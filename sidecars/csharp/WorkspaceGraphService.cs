using System.Text.Json;
using System.Text.Json.Nodes;
using System.Diagnostics;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Samchon.Graph.CSharp;

internal sealed class WorkspaceGraphService : IAsyncDisposable
{
    private readonly string root;
    private readonly object eventGate = new();
    private readonly HashSet<string> changedFiles = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim snapshots = new(1, 1);
    private readonly FileSystemWatcher watcher;
    private HashSet<string> compilerInputs = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<string, SourceStamp> observedSources =
        new(StringComparer.OrdinalIgnoreCase);
    private List<FileSystemWatcher> compilerInputWatchers = [];
    private MSBuildWorkspace? workspace;
    private Solution? solution;
    private GraphGeneration? generation;
    private long eventEpoch;
    private bool dirty = true;
    private bool buildDirty = true;

    public WorkspaceGraphService(string root)
    {
        this.root = Path.GetFullPath(root);
        if (!Directory.Exists(this.root))
        {
            throw new DirectoryNotFoundException($"C# workspace root does not exist: {this.root}");
        }
        watcher = new FileSystemWatcher(this.root)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.FileName
                | NotifyFilters.DirectoryName
                | NotifyFilters.LastWrite
                | NotifyFilters.CreationTime
                | NotifyFilters.Size,
            EnableRaisingEvents = true,
        };
        watcher.Changed += OnChanged;
        watcher.Created += OnChanged;
        watcher.Deleted += OnChanged;
        watcher.Renamed += OnRenamed;
        watcher.Error += OnWatcherError;
    }

    public static async Task<long> MeasureLoadAsync(
        string root,
        CancellationToken cancellationToken)
    {
        var resolved = Path.GetFullPath(root);
        if (!MSBuildLocator.IsRegistered)
        {
            MSBuildLocator.RegisterDefaults();
        }
        using var measured = MSBuildWorkspace.Create();
        measured.SkipUnrecognizedProjects = false;
        var entry = SelectEntryPoint(resolved);
        var started = Stopwatch.StartNew();
        var loaded = Path.GetExtension(entry).Equals(".csproj", StringComparison.OrdinalIgnoreCase)
            ? (await measured.OpenProjectAsync(entry, cancellationToken: cancellationToken)
                .ConfigureAwait(false)).Solution
            : await measured.OpenSolutionAsync(entry, cancellationToken: cancellationToken)
                .ConfigureAwait(false);
        started.Stop();
        if (!loaded.Projects.Any(project => project.Language == LanguageNames.CSharp))
        {
            throw new InvalidOperationException($"C# workspace contains no C# projects: {entry}");
        }
        return started.ElapsedMilliseconds;
    }

    public void NotifyChangedFiles(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("changes", out var changes)
            || changes.ValueKind != JsonValueKind.Array)
        {
            return;
        }
        foreach (var change in changes.EnumerateArray())
        {
            if (change.TryGetProperty("uri", out var uri)
                && Uri.TryCreate(uri.GetString(), UriKind.Absolute, out var parsed)
                && parsed.IsFile)
            {
                MarkChanged(parsed.LocalPath);
            }
        }
    }

    public async Task<JsonObject> SnapshotAsync(
        string? knownGeneration,
        CancellationToken cancellationToken)
    {
        await snapshots.WaitAsync(cancellationToken).ConfigureAwait(false);
        HashSet<string> changes;
        bool reload;
        long epoch;
        try
        {
            if (solution is not null)
            {
                ReconcileSourceFiles();
            }
            lock (eventGate)
            {
                if (!dirty && generation is not null)
                {
                    return knownGeneration == generation.Generation
                        ? GraphProtocol.Unchanged(generation)
                        : GraphProtocol.Replay(generation, knownGeneration);
                }
                changes = new HashSet<string>(changedFiles, StringComparer.OrdinalIgnoreCase);
                changedFiles.Clear();
                reload = buildDirty || solution is null;
                buildDirty = false;
                dirty = false;
                epoch = eventEpoch;
            }
            if (!reload && changes.Any(file =>
                    Path.GetExtension(file).Equals(".cs", StringComparison.OrdinalIgnoreCase)
                    && File.Exists(file)
                    && !solution!.GetDocumentIdsWithFilePath(Path.GetFullPath(file)).Any()))
            {
                // Only MSBuild evaluation can decide whether a newly observed
                // source belongs to a project. Directory ancestry would invent
                // ownership for Compile Remove, explicit include, and nested
                // project layouts.
                reload = true;
            }

            try
            {
                if (reload)
                {
                    await LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    solution = await ApplySourceChangesAsync(
                        solution!,
                        changes,
                        cancellationToken).ConfigureAwait(false);
                }

                var draft = await GraphExtractor.ExtractAsync(
                    solution!,
                    root,
                    WorkspaceDiagnostics(),
                    generation?.Draft,
                    changes,
                    reload,
                    cancellationToken).ConfigureAwait(false);
                ReconcileSourceFiles();
                lock (eventGate)
                {
                    if (eventEpoch != epoch)
                    {
                        dirty = true;
                        throw new SnapshotInvalidatedException(
                            "C# workspace inputs changed while the immutable Solution was being exported; retry");
                    }
                }
                if (draft.HasErrors)
                {
                    throw new InvalidOperationException(
                        $"C# workspace graph retained its prior generation after compiler errors: {draft.ErrorSummary}");
                }
                var protocolTiming = Stopwatch.StartNew();
                var envelope = GraphProtocol.Commit(
                    generation,
                    draft,
                    typeof(Microsoft.CodeAnalysis.CSharp.CSharpCompilation)
                        .Assembly.GetName().Version?.ToString() ?? "unknown");
                Trace("protocol-commit", protocolTiming.ElapsedMilliseconds);
                if (envelope["mode"]!.GetValue<string>() != "unchanged")
                {
                    protocolTiming.Restart();
                    generation = GraphProtocol.GenerationFrom(
                        envelope,
                        draft,
                        typeof(Microsoft.CodeAnalysis.CSharp.CSharpCompilation)
                            .Assembly.GetName().Version?.ToString() ?? "unknown");
                    Trace("protocol-generation", protocolTiming.ElapsedMilliseconds);
                }
                return envelope["mode"]!.GetValue<string>() == "unchanged"
                    && knownGeneration != generation!.Generation
                        ? GraphProtocol.Replay(generation, knownGeneration)
                        : envelope;
            }
            catch
            {
                lock (eventGate)
                {
                    dirty = true;
                    buildDirty |= reload;
                    foreach (var file in changes)
                    {
                        changedFiles.Add(file);
                    }
                }
                throw;
            }
        }
        finally
        {
            snapshots.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        watcher.EnableRaisingEvents = false;
        watcher.Dispose();
        foreach (var inputWatcher in compilerInputWatchers)
        {
            inputWatcher.Dispose();
        }
        snapshots.Dispose();
        if (workspace is not null)
        {
            workspace.Dispose();
        }
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private async Task LoadWorkspaceAsync(CancellationToken cancellationToken)
    {
        var sourceBaseline = CaptureSourceFiles();
        if (!MSBuildLocator.IsRegistered)
        {
            MSBuildLocator.RegisterDefaults();
        }
        var candidate = MSBuildWorkspace.Create();
        candidate.SkipUnrecognizedProjects = false;
        try
        {
            var entry = SelectEntryPoint(root);
            var candidateSolution = Path.GetExtension(entry).Equals(".csproj", StringComparison.OrdinalIgnoreCase)
                ? (await candidate.OpenProjectAsync(entry, cancellationToken: cancellationToken)
                    .ConfigureAwait(false)).Solution
                : await candidate.OpenSolutionAsync(entry, cancellationToken: cancellationToken)
                    .ConfigureAwait(false);
            if (!candidateSolution.Projects.Any(project => project.Language == LanguageNames.CSharp))
            {
                throw new InvalidOperationException($"C# workspace contains no C# projects: {entry}");
            }
            ReplaceCompilerInputWatchers(candidateSolution);
            var previous = workspace;
            workspace = candidate;
            solution = candidateSolution;
            observedSources = sourceBaseline;
            previous?.Dispose();
        }
        catch
        {
            candidate.Dispose();
            throw;
        }
    }

    private void ReplaceCompilerInputWatchers(Solution candidate)
    {
        var inputs = candidate.Projects
            .Where(project => project.Language == LanguageNames.CSharp)
            .SelectMany(project => project.AnalyzerReferences
                .Select(reference => reference.FullPath)
                .Concat(project.AdditionalDocuments
                    .Concat(project.AnalyzerConfigDocuments)
                    .Select(document => document.FilePath))
                .Append(project.FilePath is null
                    ? null
                    : Path.Combine(
                        Path.GetDirectoryName(project.FilePath)!,
                        "obj",
                        "project.assets.json")))
            .Where(file => file is { Length: > 0 })
            .Select(file => Path.GetFullPath(file!))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var replacements = new List<FileSystemWatcher>();
        try
        {
            foreach (var file in inputs
                .Where(file => !IsWithin(root, file) || Ignored(file))
                .Where(file => Directory.Exists(Path.GetDirectoryName(file)))
                .Order(StringComparer.Ordinal))
            {
                var inputWatcher = new FileSystemWatcher(
                    Path.GetDirectoryName(file)!,
                    Path.GetFileName(file))
                {
                    NotifyFilter = NotifyFilters.FileName
                        | NotifyFilters.LastWrite
                        | NotifyFilters.CreationTime
                        | NotifyFilters.Size,
                };
                inputWatcher.Changed += OnChanged;
                inputWatcher.Created += OnChanged;
                inputWatcher.Deleted += OnChanged;
                inputWatcher.Renamed += OnRenamed;
                inputWatcher.Error += OnWatcherError;
                replacements.Add(inputWatcher);
            }
        }
        catch
        {
            foreach (var replacement in replacements)
            {
                replacement.Dispose();
            }
            throw;
        }
        List<FileSystemWatcher> previous;
        lock (eventGate)
        {
            previous = compilerInputWatchers;
            compilerInputWatchers = replacements;
            compilerInputs = inputs;
            foreach (var replacement in replacements)
            {
                replacement.EnableRaisingEvents = true;
            }
        }
        foreach (var prior in previous)
        {
            prior.Dispose();
        }
    }

    private static string SelectEntryPoint(string root)
    {
        foreach (var extension in new[] { ".slnx", ".sln" })
        {
            var solutions = Directory.EnumerateFiles(root, $"*{extension}", SearchOption.TopDirectoryOnly)
                .Order(StringComparer.Ordinal)
                .ToArray();
            if (solutions.Length == 1)
            {
                return solutions[0];
            }
            if (solutions.Length > 1)
            {
                throw new InvalidOperationException(
                    $"C# workspace root has multiple {extension} entry points; select one explicitly");
            }
        }
        var projects = EnumerateProjectFiles(root).ToArray();
        return projects.Length switch
        {
            1 => projects[0],
            0 => throw new InvalidOperationException("C# workspace has no .sln, .slnx, or .csproj entry point"),
            _ => throw new InvalidOperationException(
                "C# workspace has multiple projects and no solution entry point"),
        };
    }

    private static IEnumerable<string> EnumerateProjectFiles(string root)
    {
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count != 0)
        {
            var directory = pending.Pop();
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory)
                .Order(StringComparer.Ordinal))
            {
                if (Directory.Exists(entry))
                {
                    if (!Ignored(root, entry))
                    {
                        pending.Push(entry);
                    }
                }
                else if (Path.GetExtension(entry).Equals(
                    ".csproj",
                    StringComparison.OrdinalIgnoreCase))
                {
                    yield return entry;
                }
            }
        }
    }

    private async Task<Solution> ApplySourceChangesAsync(
        Solution current,
        IReadOnlySet<string> changes,
        CancellationToken cancellationToken)
    {
        var next = current;
        foreach (var file in changes
            .Where(file => Path.GetExtension(file).Equals(".cs", StringComparison.OrdinalIgnoreCase))
            .Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var absolute = Path.GetFullPath(file);
            var documents = next.GetDocumentIdsWithFilePath(absolute).ToArray();
            if (!File.Exists(absolute))
            {
                foreach (var document in documents)
                {
                    next = next.RemoveDocument(document);
                }
                continue;
            }
            var bytes = await File.ReadAllBytesAsync(absolute, cancellationToken).ConfigureAwait(false);
            using var stream = new MemoryStream(bytes, writable: false);
            var text = SourceText.From(
                stream,
                encoding: null,
                checksumAlgorithm: SourceHashAlgorithm.Sha256,
                throwIfBinaryDetected: true,
                canBeEmbedded: true);
            if (documents.Length != 0)
            {
                foreach (var document in documents)
                {
                    next = next.WithDocumentText(document, text, PreservationMode.PreserveIdentity);
                }
                continue;
            }
            throw new SnapshotInvalidatedException(
                $"C# source membership moved after refresh preparation: {absolute}");
        }
        return next;
    }

    private IReadOnlyList<string> WorkspaceDiagnostics() => workspace is null
        ? []
        : workspace.Diagnostics
            .Select(diagnostic => diagnostic.Message)
            .Order(StringComparer.Ordinal)
            .ToArray();

    private void ReconcileSourceFiles()
    {
        var current = CaptureSourceFiles();
        var changes = observedSources.Keys
            .Concat(current.Keys)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(file => !observedSources.TryGetValue(file, out var prior)
                || !current.TryGetValue(file, out var next)
                || prior != next)
            .ToArray();
        observedSources = current;
        if (changes.Length == 0)
        {
            return;
        }
        lock (eventGate)
        {
            dirty = true;
            foreach (var file in changes)
            {
                changedFiles.Add(file);
            }
            eventEpoch++;
        }
    }

    private Dictionary<string, SourceStamp> CaptureSourceFiles()
    {
        var sources = new Dictionary<string, SourceStamp>(StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count != 0)
        {
            var directory = pending.Pop();
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                if (Directory.Exists(entry))
                {
                    if (!Ignored(root, entry))
                    {
                        pending.Push(entry);
                    }
                    continue;
                }
                if (!Path.GetExtension(entry).Equals(".cs", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                try
                {
                    var file = new FileInfo(entry);
                    sources[file.FullName] = new SourceStamp(
                        file.Length,
                        file.LastWriteTimeUtc.Ticks);
                }
                catch (FileNotFoundException)
                {
                    // A concurrent deletion is represented by the absent entry.
                }
            }
        }
        return sources;
    }

    private void OnChanged(object sender, FileSystemEventArgs args) => MarkChanged(args.FullPath);

    private void OnRenamed(object sender, RenamedEventArgs args)
    {
        MarkChanged(args.OldFullPath);
        MarkChanged(args.FullPath);
    }

    private void OnWatcherError(object sender, ErrorEventArgs args)
    {
        lock (eventGate)
        {
            dirty = true;
            buildDirty = true;
            eventEpoch++;
        }
    }

    private void MarkChanged(string file)
    {
        var absolute = Path.GetFullPath(file);
        bool compilerInput;
        lock (eventGate)
        {
            compilerInput = compilerInputs.Contains(absolute);
        }
        if ((!IsWithin(root, absolute) && !compilerInput)
            || (Ignored(absolute) && !compilerInput))
        {
            return;
        }
        var extension = Path.GetExtension(absolute);
        if (!extension.Equals(".cs", StringComparison.OrdinalIgnoreCase)
            && !IsBuildInput(absolute)
            && !compilerInput)
        {
            return;
        }
        if (extension.Equals(".cs", StringComparison.OrdinalIgnoreCase))
        {
            SourceStamp? current = null;
            try
            {
                var source = new FileInfo(absolute);
                if (source.Exists)
                {
                    current = new SourceStamp(source.Length, source.LastWriteTimeUtc.Ticks);
                }
            }
            catch (FileNotFoundException)
            {
                // Treat a file that disappeared during inspection as deleted.
            }
            if (current is { } stamp
                && observedSources.TryGetValue(absolute, out var observed)
                && stamp == observed
                || current is null && !observedSources.ContainsKey(absolute))
            {
                return;
            }
        }
        lock (eventGate)
        {
            dirty = true;
            buildDirty |= IsBuildInput(absolute) || compilerInput;
            changedFiles.Add(absolute);
            eventEpoch++;
        }
    }

    private static bool IsBuildInput(string file)
    {
        var name = Path.GetFileName(file);
        return Path.GetExtension(file).ToLowerInvariant() is ".sln" or ".slnx" or ".csproj" or ".props" or ".targets"
            || name.Equals("global.json", StringComparison.OrdinalIgnoreCase)
            || name.Equals("packages.lock.json", StringComparison.OrdinalIgnoreCase)
            || name.Equals("nuget.config", StringComparison.OrdinalIgnoreCase);
    }

    private bool Ignored(string file)
        => Ignored(root, file);

    private static bool Ignored(string root, string file)
    {
        var parts = Path.GetRelativePath(root, file)
            .Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return parts.Any(part => part is ".git" or ".wiki" or "bin" or "node_modules" or "obj");
    }

    private static bool IsWithin(string parent, string child)
    {
        var relative = Path.GetRelativePath(Path.GetFullPath(parent), Path.GetFullPath(child));
        return relative != ".."
            && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            && !Path.IsPathRooted(relative);
    }

    private readonly record struct SourceStamp(long Length, long LastWriteTicks);

    private static void Trace(string phase, long elapsedMs)
    {
        if (Environment.GetEnvironmentVariable("SAMCHON_GRAPH_ROSLYN_TRACE") == "1")
        {
            Console.Error.WriteLine(
                $"{{\"phase\":\"roslyn-{phase}\",\"elapsedMs\":{elapsedMs}}}");
        }
    }
}
