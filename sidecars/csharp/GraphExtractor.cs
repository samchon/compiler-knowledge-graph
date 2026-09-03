using System.Text;
using System.Text.Json.Nodes;
using System.Collections.Immutable;
using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Samchon.Graph.CSharp;

internal static class GraphExtractor
{
    private static readonly string[] Families =
    [
        "contains", "exports", "imports", "calls", "accesses",
        "instantiates", "type_ref", "extends", "implements", "overrides",
        "dispatches", "decorates", "renders", "tests", "references",
    ];

    public static async Task<GraphDraft> ExtractAsync(
        Solution solution,
        string root,
        IReadOnlyList<string> workspaceDiagnostics,
        GraphDraft? previous,
        IReadOnlySet<string> changedFiles,
        bool forceFull,
        CancellationToken cancellationToken)
    {
        var timing = Stopwatch.StartNew();
        var priorElapsed = 0L;
        void Trace(string phase)
        {
            if (Environment.GetEnvironmentVariable("SAMCHON_GRAPH_ROSLYN_TRACE") != "1")
            {
                return;
            }
            var elapsed = timing.ElapsedMilliseconds;
            Console.Error.WriteLine(
                $"{{\"phase\":\"roslyn-{phase}\",\"elapsedMs\":{elapsed - priorElapsed}}}");
            priorElapsed = elapsed;
        }

        var topologicalOrder = solution.GetProjectDependencyGraph()
            .GetTopologicallySortedProjects()
            .Select((project, index) => (project, index))
            .ToDictionary(entry => entry.project, entry => entry.index);
        var projects = solution.Projects
            .Where(project => project.Language == LanguageNames.CSharp)
            .OrderBy(project => topologicalOrder[project.Id])
            .ThenBy(project => project.FilePath ?? project.Name, StringComparer.Ordinal)
            .ToArray();
        var previousContexts = previous?.ProviderState as IReadOnlyList<ProjectContext>;
        var changed = changedFiles
            .Select(Path.GetFullPath)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var directlyChangedProjects = projects
            .Where(project => project.Documents.Any(document =>
                    document.FilePath is { Length: > 0 } file
                    && changed.Contains(Path.GetFullPath(file)))
                || previousContexts?.Any(context =>
                    context.Project.Id == project.Id
                    && context.Project.Documents.Any(document =>
                        document.FilePath is { Length: > 0 } file
                        && changed.Contains(Path.GetFullPath(file)))) == true)
            .Select(project => project.Id)
            .ToHashSet();
        // Roslyn's topological order does not define an order between independent
        // projects, and their reload-specific ProjectIds may therefore reorder
        // otherwise identical Solutions.  Downstream order assigns the one shard
        // that carries shared build sources, so seal it by semantic target.
        var contexts = (await Task.WhenAll(projects.Select(async project =>
        {
            var prior = previousContexts?.FirstOrDefault(context =>
                context.Project.Id == project.Id);
            if (!forceFull
                && prior is not null
                && !directlyChangedProjects.Contains(project.Id))
            {
                return new ProjectContext(
                    prior.Project,
                    prior.Compilation,
                    prior.Target,
                    prior.Assembly,
                    prior.Framework,
                    prior.ProjectFile,
                    [],
                    prior.Documents,
                    prior.GeneratedDocuments);
            }
            cancellationToken.ThrowIfCancellationRequested();
            var compilation = await project.GetCompilationAsync(cancellationToken).ConfigureAwait(false)
                ?? throw new InvalidOperationException($"Roslyn produced no compilation for {project.Name}");
            var framework = TargetFramework(compilation);
            var assembly = compilation.Assembly.Identity.GetDisplayName();
            var projectFile = project.FilePath is null
                ? $"bundled:///csharp/projects/{Safe(project.Name)}"
                : Path.GetFullPath(project.FilePath);
            var target = $"roslyn:{GraphProtocol.HashText($"{projectFile}\0{assembly}\0{framework}")}";
            return new ProjectContext(
                project,
                compilation,
                target,
                assembly,
                framework,
                projectFile,
                [],
                null,
                forceFull ? null : prior?.GeneratedDocuments);
        })))
            .OrderBy(context => context.Target, StringComparer.Ordinal)
            .ToList();
        Trace("compilations");
        if (contexts.Count == 0)
        {
            throw new InvalidOperationException("Roslyn workspace contains no C# compilation");
        }
        var catalog = new ProjectCatalog(contexts);
        foreach (var context in contexts)
        {
            context.Catalog = catalog;
        }

        var reuseBuildUniverse = !forceFull
            && previous is not null
            && changed.All(file => Path.GetExtension(file).Equals(
                ".cs",
                StringComparison.OrdinalIgnoreCase))
            && previous.Targets.Order(StringComparer.Ordinal).SequenceEqual(
                contexts.Select(context => context.Target).Order(StringComparer.Ordinal));
        List<JsonObject> buildSources;
        JsonObject universe;
        if (reuseBuildUniverse)
        {
            buildSources = [];
            universe = previous!.Universe.DeepClone().AsObject();
        }
        else
        {
            buildSources = BuildSources(root, contexts);
            var universeRows = new JsonArray();
            foreach (var context in contexts)
            {
                universeRows.Add(new JsonObject
                {
                    ["target"] = context.Target,
                    ["project"] = context.ProjectFile,
                    ["assembly"] = context.Assembly,
                    ["framework"] = context.Framework,
                    ["parseOptions"] = context.Project.ParseOptions?.ToString() ?? "",
                    ["compilationOptions"] = context.Project.CompilationOptions?.ToString() ?? "",
                    ["output"] = context.Project.OutputFilePath ?? "",
                    ["analyzers"] = new JsonArray(context.Project.AnalyzerReferences
                        .Select(reference => reference.FullPath ?? reference.Display ?? "")
                        .Order(StringComparer.Ordinal)
                        .Select(value => JsonValue.Create(value))
                        .ToArray()),
                    ["projectReferences"] = new JsonArray(context.Project.ProjectReferences
                        .Select(reference => solution.GetProject(reference.ProjectId)?.FilePath ?? reference.ProjectId.Id.ToString())
                        .Order(StringComparer.Ordinal)
                        .Select(value => JsonValue.Create(value))
                        .ToArray()),
                    ["metadataReferences"] = new JsonArray(context.Project.MetadataReferences
                        .Select(reference => reference.Display ?? "")
                        .Order(StringComparer.Ordinal)
                        .Select(value => JsonValue.Create(value))
                        .ToArray()),
                });
            }
            var inputRows = new JsonArray(buildSources
                .OrderBy(source => source["file"]!.GetValue<string>(), StringComparer.Ordinal)
                .Select(source => source.DeepClone())
                .ToArray());
            universe = new JsonObject
            {
                ["workspaceRoot"] = Path.GetFullPath(root),
                ["projects"] = universeRows,
                ["inputs"] = inputRows,
            };
        }
        var universeDigest = GraphProtocol.Hash(universe);

        var shards = new List<ShardDraft>();
        var diagnosticsByFile = new Dictionary<string, List<Diagnostic>>(StringComparer.OrdinalIgnoreCase);
        var globalDiagnostics = contexts.ToDictionary(
            context => context.Target,
            _ => new List<Diagnostic>(),
            StringComparer.Ordinal);

        var documentWork = new List<DocumentWork>();
        foreach (var context in contexts)
        {
            IReadOnlyList<ContextDocument> projectDocuments;
            if (context.Documents is not null)
            {
                projectDocuments = context.Documents;
            }
            else
            {
                var documents = context.Project.Documents.Cast<Document>()
                    .Select(document => new ContextDocument(
                        document,
                        document.FilePath is { Length: > 0 } file
                            && Ignored(root, Path.GetFullPath(file))))
                    .ToList();
                IReadOnlyList<ContextDocument> generatedDocuments;
                if (context.GeneratedDocuments is not null
                    && await GeneratedOutputsMatch(
                        context,
                        context.GeneratedDocuments,
                        cancellationToken).ConfigureAwait(false))
                {
                    generatedDocuments = context.GeneratedDocuments;
                }
                else
                {
                    generatedDocuments = (await context.Project
                        .GetSourceGeneratedDocumentsAsync(cancellationToken)
                        .ConfigureAwait(false))
                        .Select(document => new ContextDocument(document, true))
                        .ToArray();
                }
                context.GeneratedDocuments = generatedDocuments;
                documents.AddRange(generatedDocuments);
                projectDocuments = documents
                    .OrderBy(entry => DocumentIdentity(entry.Document), StringComparer.Ordinal)
                    .ToArray();
                context.Documents = projectDocuments;
            }
            foreach (var entry in projectDocuments)
            {
                var document = entry.Document;
                var generated = entry.Generated;
                if (generated && document.FilePath is { Length: > 0 } generatedFile)
                {
                    context.GeneratedSources[Path.GetFullPath(generatedFile)] =
                        GeneratedSourceIdentity(context, document);
                }
                documentWork.Add(new DocumentWork(
                    context,
                    document,
                    DocumentShardKey(context, document, root, generated),
                    generated));
            }
        }
        Trace("documents");

        var previousShards = previous?.Shards
            .ToDictionary(shard => shard.Key, StringComparer.Ordinal)
            ?? new Dictionary<string, ShardDraft>(StringComparer.Ordinal);
        var reuse = !forceFull
            && previous is not null
            && GraphProtocol.Hash(previous.Universe) == universeDigest;
        var extracted = new Dictionary<string, ShardDraft>(StringComparer.Ordinal);
        var signatureChanged = new HashSet<ProjectId>();
        var diagnosticProjects = new HashSet<ProjectId>();
        using var extractionGate = new SemaphoreSlim(
            Math.Max(1, Math.Min(Environment.ProcessorCount, 8)));
        async Task<(DocumentWork Work, ShardDraft? Prior, ShardDraft? Next)> ExtractChanged(
            DocumentWork work)
        {
            previousShards.TryGetValue(work.Key, out var prior);
            if (reuse
                && prior is not null
                && !changed.Contains(SourceIdentity(
                    work.Context,
                    work.Document,
                    work.Generated))
                && (!work.Generated
                    || await CheckerDigest(work.Document, cancellationToken).ConfigureAwait(false)
                        == SourceCheckerDigest(prior)))
            {
                return (work, prior, null);
            }
            ShardDraft next;
            if (reuse)
            {
                await extractionGate.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    next = await Task.Run(
                        () => ExtractDocumentAsync(
                            work.Context,
                            work.Document,
                            root,
                            universeDigest,
                            diagnosticsByFile,
                            work.Generated,
                            cancellationToken),
                        cancellationToken).ConfigureAwait(false);
                }
                finally
                {
                    extractionGate.Release();
                }
            }
            else
            {
                next = await ExtractDocumentAsync(
                    work.Context,
                    work.Document,
                    root,
                    universeDigest,
                    diagnosticsByFile,
                    work.Generated,
                    cancellationToken).ConfigureAwait(false);
            }
            return (work, prior, next);
        }
        IReadOnlyList<(DocumentWork Work, ShardDraft? Prior, ShardDraft? Next)>
            extractionResults;
        if (reuse)
        {
            extractionResults = await Task.WhenAll(documentWork.Select(ExtractChanged))
                .ConfigureAwait(false);
        }
        else
        {
            var initialResults =
                new List<(DocumentWork Work, ShardDraft? Prior, ShardDraft? Next)>();
            foreach (var work in documentWork)
            {
                initialResults.Add(await ExtractChanged(work).ConfigureAwait(false));
            }
            extractionResults = initialResults;
        }
        foreach (var result in extractionResults)
        {
            if (result.Next is null)
            {
                continue;
            }
            extracted[result.Work.Key] = result.Next;
            if (result.Prior is null
                || result.Prior.InterfaceFingerprint != result.Next.InterfaceFingerprint)
            {
                signatureChanged.Add(result.Work.Context.Project.Id);
            }
        }
        Trace("extraction");
        if (reuse)
        {
            var currentKeys = documentWork
                .Select(work => work.Key)
                .ToHashSet(StringComparer.Ordinal);
            foreach (var context in contexts)
            {
                var prefix = $"csharp-shard-v1|{context.Target}|document:";
                var removed = previousShards.Keys.FirstOrDefault(key =>
                    key.StartsWith(prefix, StringComparison.Ordinal)
                    && !currentKeys.Contains(key));
                if (removed is not null)
                {
                    signatureChanged.Add(context.Project.Id);
                    diagnosticProjects.Add(context.Project.Id);
                }
            }
        }
        if (reuse && signatureChanged.Count != 0)
        {
            return await ExtractAsync(
                solution,
                root,
                workspaceDiagnostics,
                previous,
                changedFiles,
                true,
                cancellationToken).ConfigureAwait(false);
        }
        var affected = DependentClosure(solution, signatureChanged);
        diagnosticProjects.UnionWith(affected);
        if (!reuse)
        {
            diagnosticProjects.UnionWith(contexts.Select(context => context.Project.Id));
        }
        var incrementalDocuments = documentWork
            .Where(work => extracted.ContainsKey(work.Key)
                && !diagnosticProjects.Contains(work.Context.Project.Id))
            .GroupBy(work => work.Context.Project.Id)
            .ToDictionary(
                group => group.Key,
                group => (IReadOnlyList<Document>)group
                    .Select(work => work.Document)
                    .DistinctBy(document => document.Id)
                    .ToArray());
        await Task.WhenAll(contexts
            .Where(context => diagnosticProjects.Contains(context.Project.Id)
                || incrementalDocuments.ContainsKey(context.Project.Id))
            .Select(async context =>
            {
                context.Diagnostics = diagnosticProjects.Contains(context.Project.Id)
                    ? await DiagnosticsOf(
                        context.Project,
                        context.Compilation,
                        cancellationToken).ConfigureAwait(false)
                    : await IncrementalDiagnosticsOf(
                        incrementalDocuments[context.Project.Id],
                        cancellationToken).ConfigureAwait(false);
            })).ConfigureAwait(false);
        foreach (var context in contexts
            .Where(context => diagnosticProjects.Contains(context.Project.Id)
                || incrementalDocuments.ContainsKey(context.Project.Id)))
        {
            foreach (var diagnostic in context.Diagnostics)
            {
                if (diagnostic.Location.IsInSource
                    && diagnostic.Location.SourceTree?.FilePath is { Length: > 0 } file)
                {
                    var absolute = Path.GetFullPath(file);
                    var key = $"{context.Target}\0{absolute}";
                    if (!diagnosticsByFile.TryGetValue(key, out var rows))
                    {
                        rows = [];
                        diagnosticsByFile[key] = rows;
                    }
                    rows.Add(diagnostic);
                }
                else
                {
                    globalDiagnostics[context.Target].Add(diagnostic);
                }
            }
        }
        Trace("diagnostics");
        foreach (var work in documentWork)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (extracted.TryGetValue(work.Key, out var shard))
            {
                previousShards.TryGetValue(work.Key, out var prior);
                shard = ReuseWithDiagnostics(
                    shard,
                    DiagnosticsFor(
                        work.Context,
                        work.Document,
                        root,
                        diagnosticsByFile,
                        diagnosticProjects.Contains(work.Context.Project.Id)
                            ? null
                            : prior?.Payload["diagnostics"]?.AsArray()));
            }
            else
            {
                if (!reuse
                    || affected.Contains(work.Context.Project.Id)
                    || !previousShards.TryGetValue(work.Key, out var prior))
                {
                    shard = await ExtractDocumentAsync(
                        work.Context,
                        work.Document,
                        root,
                        universeDigest,
                        diagnosticsByFile,
                        work.Generated,
                        cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    shard = diagnosticProjects.Contains(work.Context.Project.Id)
                        ? ReuseWithDiagnostics(
                            prior,
                            DiagnosticsFor(
                                work.Context,
                                work.Document,
                                root,
                                diagnosticsByFile))
                        : prior;
                }
            }
            shards.Add(shard);
        }

        for (var index = 0; index < contexts.Count; index++)
        {
            var context = contexts[index];
            var metadataKey = $"csharp-shard-v1|{context.Target}|metadata";
            if (reuseBuildUniverse
                && previousShards.TryGetValue(metadataKey, out var cachedMetadata))
            {
                shards.Add(cachedMetadata);
                continue;
            }
            var projectId = ProjectNodeId(context);
            var projectFile = GraphFile(root, context.ProjectFile);
            var evidence = new JsonObject
            {
                ["file"] = projectFile,
                ["startLine"] = 1,
                ["startCol"] = 1,
                ["endLine"] = 1,
                ["endCol"] = 1,
            };
            var nodes = new JsonArray(new JsonObject
            {
                ["id"] = projectId,
                ["kind"] = "package",
                ["language"] = "csharp",
                ["name"] = context.Project.Name,
                ["qualifiedName"] = context.Assembly,
                ["file"] = projectFile,
                ["external"] = false,
                ["exported"] = true,
                ["evidence"] = evidence.DeepClone(),
            });
            var projectEdges = new JsonArray();
            foreach (var reference in context.Project.ProjectReferences)
            {
                var referenced = contexts.FirstOrDefault(candidate =>
                    candidate.Project.Id == reference.ProjectId);
                if (referenced is null)
                {
                    continue;
                }
                var referencedId = ProjectNodeId(referenced);
                nodes.Add(new JsonObject
                {
                    ["id"] = referencedId,
                    ["kind"] = "package",
                    ["language"] = "csharp",
                    ["name"] = referenced.Project.Name,
                    ["qualifiedName"] = referenced.Assembly,
                    ["file"] = GraphFile(root, referenced.ProjectFile),
                    ["external"] = false,
                    ["exported"] = true,
                });
                projectEdges.Add(new JsonObject
                {
                    ["from"] = projectId,
                    ["to"] = referencedId,
                    ["kind"] = "imports",
                    ["evidence"] = evidence.DeepClone(),
                });
            }
            var coverage = new JsonArray();
            var unresolved = new JsonArray();
            foreach (var family in Families)
            {
                var state = family == "renders" ? "unsupported" : "partial";
                coverage.Add(new JsonObject
                {
                    ["provider"] = GraphProtocol.Provider,
                    ["language"] = "csharp",
                    ["target"] = context.Target,
                    ["family"] = family,
                    ["state"] = state,
                });
                if (state == "partial")
                {
                    unresolved.Add(new JsonObject
                    {
                        ["provider"] = GraphProtocol.Provider,
                        ["language"] = "csharp",
                        ["target"] = context.Target,
                        ["universe"] = universeDigest,
                        ["family"] = family,
                        ["evidence"] = evidence.DeepClone(),
                        ["reason"] = "provider-gap",
                        ["candidates"] = new JsonArray(),
                    });
                }
            }
            JsonArray diagnostics;
            if (reuse
                && !diagnosticProjects.Contains(context.Project.Id)
                && previousShards.TryGetValue(metadataKey, out var priorMetadata))
            {
                diagnostics = priorMetadata.Payload["diagnostics"]!.DeepClone().AsArray();
            }
            else
            {
                diagnostics = new JsonArray();
                foreach (var diagnostic in globalDiagnostics[context.Target]
                    .Select(diagnostic => DiagnosticNode(context, root, diagnostic))
                    .OrderBy(DiagnosticKey, StringComparer.Ordinal))
                {
                    diagnostics.Add(diagnostic);
                }
                foreach (var diagnostic in workspaceDiagnostics)
                {
                    diagnostics.Add(new JsonObject
                    {
                        ["file"] = "",
                        ["line"] = 0,
                        ["column"] = 0,
                        ["code"] = "MSBUILD",
                        ["message"] = diagnostic,
                        ["severity"] = "warning",
                    });
                }
            }
            var sources = new JsonArray();
            sources.Add(SourceOf(context.ProjectFile));
            if (index == 0)
            {
                foreach (var source in buildSources)
                {
                    if (source["file"]!.GetValue<string>() != context.ProjectFile)
                    {
                        sources.Add(source.DeepClone());
                    }
                }
            }
            shards.Add(Shard(
                metadataKey,
                context.Target,
                nodes,
                projectEdges,
                diagnostics,
                coverage,
                unresolved,
                sources));
        }

        var errorDiagnostics = contexts
            .SelectMany(context => context.Diagnostics)
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .Take(3)
            .Select(diagnostic => diagnostic.GetMessage())
            .ToArray();
        Trace("assembly");
        return new GraphDraft(
            contexts.Select(context => context.Target).Order(StringComparer.Ordinal).ToArray(),
            universe,
            universeDigest,
            shards,
            errorDiagnostics.Length != 0,
            string.Join("; ", errorDiagnostics),
            contexts);
    }

    private static async Task<ShardDraft> ExtractDocumentAsync(
        ProjectContext context,
        Document document,
        string root,
        string universe,
        IReadOnlyDictionary<string, List<Diagnostic>> diagnosticsByFile,
        bool generated,
        CancellationToken cancellationToken)
    {
        var syntax = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Roslyn produced no syntax tree for {document.Name}");
        var model = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Roslyn produced no semantic model for {document.Name}");
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var sourceFile = SourceIdentity(context, document, generated);
        var graphFile = GraphFile(root, sourceFile);
        var fileId = SemanticNodeId(
            $"file:{context.Target}:{graphFile}",
            "file",
            Path.GetFileName(graphFile),
            context.Target);
        var projectId = ProjectNodeId(context);
        var nodes = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var edges = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var unresolved = new JsonArray();
        var declarationFingerprints = new List<string>();
        nodes[fileId] = new JsonObject
        {
            ["id"] = fileId,
            ["kind"] = "file",
            ["language"] = "csharp",
            ["name"] = Path.GetFileName(graphFile),
            ["file"] = graphFile,
            ["external"] = false,
        };
        AddEdge(edges, projectId, fileId, "contains", null);

        var allSyntax = syntax.DescendantNodesAndSelf().ToArray();
        foreach (var declaration in allSyntax)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var symbol = DeclaredSymbol(model, declaration, cancellationToken);
            if (symbol is null || symbol is IAliasSymbol || symbol.Name == "")
            {
                continue;
            }
            declarationFingerprints.Add(DeclarationFingerprint(symbol));
            var node = NodeForSymbol(context, symbol, root);
            nodes.TryAdd(node["id"]!.GetValue<string>(), node);
            var owner = OwnerSymbol(symbol);
            var ownerId = owner is null || owner is INamespaceSymbol { IsGlobalNamespace: true }
                ? fileId
                : EnsureNode(nodes, context, owner, root);
            var nodeId = node["id"]!.GetValue<string>();
            AddEdge(edges, ownerId, nodeId, "contains", Evidence(context, root, declaration.GetLocation()));
            if (Exported(symbol))
            {
                AddEdge(edges, owner is null ? projectId : ownerId, nodeId, "exports", Evidence(context, root, declaration.GetLocation()));
            }
            if (symbol is INamedTypeSymbol type)
            {
                AddTypeRelations(nodes, edges, context, type, nodeId, root, declaration.GetLocation());
                AddSynthesizedRecordMembers(nodes, edges, context, type, nodeId, root);
            }
            AddOverride(nodes, edges, context, symbol, nodeId, root, declaration.GetLocation());
        }

        foreach (var item in allSyntax)
        {
            cancellationToken.ThrowIfCancellationRequested();
            switch (item)
            {
                case UsingDirectiveSyntax usingDirective:
                    {
                        var target = usingDirective.Alias is null
                            ? model.GetSymbolInfo(usingDirective.Name!, cancellationToken).Symbol
                            : model.GetSymbolInfo(usingDirective.Name!, cancellationToken).Symbol;
                        if (target is not null)
                        {
                            AddEdge(edges, fileId, EnsureNode(nodes, context, target, root), "imports", Evidence(context, root, usingDirective.GetLocation()));
                        }
                        break;
                    }
                case InvocationExpressionSyntax invocation
                    when model.GetOperation(invocation, cancellationToken) is IInvocationOperation operation:
                    {
                        var owner = model.GetEnclosingSymbol(invocation.SpanStart, cancellationToken);
                        if (owner is null)
                        {
                            break;
                        }
                        var from = EnsureNode(nodes, context, owner, root);
                        var target = CanonicalMethod(operation.TargetMethod);
                        var to = EnsureNode(nodes, context, target, root);
                        AddEdge(edges, from, to, "calls", Evidence(context, root, invocation.GetLocation()));
                        AddDispatchCandidates(
                            nodes,
                            unresolved,
                            context,
                            target,
                            invocation,
                            root,
                            universe);
                        if (IsTest(owner))
                        {
                            AddEdge(edges, from, to, "tests", Evidence(context, root, invocation.GetLocation()));
                        }
                        break;
                    }
                case ObjectCreationExpressionSyntax creation
                    when model.GetOperation(creation, cancellationToken) is IObjectCreationOperation operation:
                    AddSemanticEdge(nodes, edges, context, model, operation.Type, creation, root, "instantiates", cancellationToken);
                    break;
                case ImplicitObjectCreationExpressionSyntax creation
                    when model.GetOperation(creation, cancellationToken) is IObjectCreationOperation operation:
                    AddSemanticEdge(nodes, edges, context, model, operation.Type, creation, root, "instantiates", cancellationToken);
                    break;
                case AttributeSyntax attribute:
                    {
                        var owner = AttributeOwner(model, attribute, cancellationToken);
                        var constructor = model.GetSymbolInfo(attribute, cancellationToken).Symbol as IMethodSymbol;
                        if (owner is not null && constructor is not null)
                        {
                            var from = EnsureNode(nodes, context, owner, root);
                            var type = EnsureNode(nodes, context, constructor.ContainingType, root);
                            AddEdge(
                                edges,
                                from,
                                type,
                                "decorates",
                                Evidence(context, root, attribute.GetLocation()));
                            AddEdge(
                                edges,
                                from,
                                EnsureNode(nodes, context, constructor, root),
                                "references",
                                Evidence(context, root, attribute.GetLocation()));
                            AddEdge(
                                edges,
                                from,
                                type,
                                "type_ref",
                                Evidence(context, root, attribute.GetLocation()));
                        }
                        break;
                    }
                case AnonymousFunctionExpressionSyntax anonymous
                    when model.GetOperation(anonymous, cancellationToken)
                        is IAnonymousFunctionOperation operation:
                    {
                        var lambda = EnsureNode(nodes, context, operation.Symbol, root);
                        var owner = operation.Symbol.ContainingSymbol;
                        if (owner is not null)
                        {
                            AddEdge(
                                edges,
                                EnsureNode(nodes, context, owner, root),
                                lambda,
                                "contains",
                                Evidence(context, root, anonymous.GetLocation()));
                        }
                        unresolved.Add(new JsonObject
                        {
                            ["provider"] = GraphProtocol.Provider,
                            ["language"] = "csharp",
                            ["target"] = context.Target,
                            ["universe"] = universe,
                            ["family"] = "contains",
                            ["evidence"] = Evidence(context, root, anonymous.GetLocation()),
                            ["reason"] = "identity-unstable",
                            ["candidates"] = new JsonArray(lambda),
                        });
                        break;
                    }
                case IdentifierNameSyntax identifier:
                    {
                        var symbol = model.GetSymbolInfo(identifier, cancellationToken).Symbol;
                        if (symbol is null || IsDeclarationIdentifier(identifier))
                        {
                            break;
                        }
                        var owner = model.GetEnclosingSymbol(identifier.SpanStart, cancellationToken);
                        if (owner is null)
                        {
                            break;
                        }
                        var from = EnsureNode(nodes, context, owner, root);
                        var to = EnsureNode(nodes, context, symbol, root);
                        AddEdge(edges, from, to, "references", Evidence(context, root, identifier.GetLocation()));
                        if (symbol is ITypeSymbol)
                        {
                            AddEdge(edges, from, to, "type_ref", Evidence(context, root, identifier.GetLocation()));
                        }
                        if (symbol is IFieldSymbol or IPropertySymbol or IEventSymbol or ILocalSymbol or IParameterSymbol)
                        {
                            AddEdge(edges, from, to, "accesses", Evidence(context, root, identifier.GetLocation()));
                        }
                        break;
                    }
                case TypeSyntax typeSyntax:
                    {
                        var type = model.GetTypeInfo(typeSyntax, cancellationToken).Type;
                        AddSemanticEdge(nodes, edges, context, model, type, typeSyntax, root, "type_ref", cancellationToken);
                        break;
                    }
            }
        }

        var diagnostics = DiagnosticsFor(context, document, root, diagnosticsByFile);
        var source = new JsonObject
        {
            ["file"] = sourceFile,
            ["checkerDigest"] = GraphProtocol.HashText(text.ToString()),
            ["diskDigest"] = !generated
                && document.FilePath is { Length: > 0 } disk
                && File.Exists(disk)
                ? GraphProtocol.HashBytes(await File.ReadAllBytesAsync(disk, cancellationToken).ConfigureAwait(false))
                : "",
        };
        return Shard(
            DocumentShardKey(context, document, root, generated),
            context.Target,
            new JsonArray(nodes.Values.OrderBy(node => node["id"]!.GetValue<string>(), StringComparer.Ordinal).Select(node => node.DeepClone()).ToArray()),
            new JsonArray(edges.Values.OrderBy(edge => EdgeKey(edge), StringComparer.Ordinal).Select(edge => edge.DeepClone()).ToArray()),
            diagnostics,
            new JsonArray(),
            unresolved,
            new JsonArray(source),
            GraphProtocol.Hash(new JsonArray(declarationFingerprints
                .Order(StringComparer.Ordinal)
                .Select(value => JsonValue.Create(value))
                .ToArray())));
    }

    private static string DocumentShardKey(
        ProjectContext context,
        Document document,
        string root,
        bool generated) =>
        $"csharp-shard-v1|{context.Target}|document:{GraphFile(root, SourceIdentity(context, document, generated))}";

    private static async Task<string> CheckerDigest(
        Document document,
        CancellationToken cancellationToken) =>
        GraphProtocol.HashText(
            (await document.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString());

    private static string SourceCheckerDigest(ShardDraft shard) =>
        shard.Payload["sources"]!.AsArray().Single()!["checkerDigest"]!.GetValue<string>();

    private static async Task<bool> GeneratedOutputsMatch(
        ProjectContext context,
        IReadOnlyList<ContextDocument> cached,
        CancellationToken cancellationToken)
    {
        var sourcePaths = context.Project.Documents
            .Where(document => document.FilePath is { Length: > 0 })
            .Select(document => Path.GetFullPath(document.FilePath!))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var current = context.Compilation.SyntaxTrees
            .Where(tree => tree.FilePath is { Length: > 0 })
            .Select(tree => new
            {
                File = Path.GetFullPath(tree.FilePath),
                Tree = tree,
            })
            .Where(entry => !sourcePaths.Contains(entry.File))
            .GroupBy(entry => entry.File, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                group => group.Key,
                group => GraphProtocol.HashText(
                    group.First().Tree.GetText(cancellationToken).ToString()),
                StringComparer.OrdinalIgnoreCase);
        if (current.Count != cached.Count
            || cached.Any(document => document.Document.FilePath is not { Length: > 0 }))
        {
            return false;
        }
        foreach (var document in cached)
        {
            var file = Path.GetFullPath(document.Document.FilePath!);
            if (!current.TryGetValue(file, out var digest)
                || digest != await CheckerDigest(document.Document, cancellationToken)
                    .ConfigureAwait(false))
            {
                return false;
            }
        }
        return true;
    }

    private static HashSet<ProjectId> DependentClosure(
        Solution solution,
        IReadOnlySet<ProjectId> changed)
    {
        var output = changed.ToHashSet();
        var pending = new Queue<ProjectId>(changed);
        var graph = solution.GetProjectDependencyGraph();
        while (pending.TryDequeue(out var project))
        {
            foreach (var dependent in graph.GetProjectsThatDirectlyDependOnThisProject(project))
            {
                if (output.Add(dependent))
                {
                    pending.Enqueue(dependent);
                }
            }
        }
        return output;
    }

    private static JsonArray DiagnosticsFor(
        ProjectContext context,
        Document document,
        string root,
        IReadOnlyDictionary<string, List<Diagnostic>> diagnosticsByFile,
        JsonArray? cachedDiagnostics = null)
    {
        var diagnostics = new List<JsonObject>();
        if (document.FilePath is { Length: > 0 } filePath
            && diagnosticsByFile.TryGetValue(
                $"{context.Target}\0{Path.GetFullPath(filePath)}",
                out var rows))
        {
            foreach (var diagnostic in rows
                .Select(diagnostic => DiagnosticNode(context, root, diagnostic))
                .OrderBy(DiagnosticKey, StringComparer.Ordinal))
            {
                diagnostics.Add(diagnostic);
            }
        }
        if (cachedDiagnostics is not null)
        {
            diagnostics.AddRange(cachedDiagnostics
                .Where(diagnostic => diagnostic is JsonObject value
                    && !IsCompilerDiagnostic(value))
                .Select(diagnostic => diagnostic!.DeepClone().AsObject()));
        }
        return new JsonArray(diagnostics
            .GroupBy(DiagnosticKey, StringComparer.Ordinal)
            .Select(group => group.First())
            .OrderBy(DiagnosticKey, StringComparer.Ordinal)
            .ToArray());
    }

    private static bool IsCompilerDiagnostic(JsonObject diagnostic)
    {
        var code = diagnostic["code"]?.GetValue<string>();
        return code is { Length: > 2 }
            && code.StartsWith("CS", StringComparison.Ordinal)
            && code.AsSpan(2).IndexOfAnyExceptInRange('0', '9') == -1;
    }

    private static ShardDraft ReuseWithDiagnostics(
        ShardDraft prior,
        JsonArray diagnostics)
    {
        if (GraphProtocol.Hash(prior.Payload["diagnostics"]!) == GraphProtocol.Hash(diagnostics))
        {
            return prior;
        }
        var payload = prior.Payload.DeepClone().AsObject();
        payload["diagnostics"] = diagnostics;
        return new ShardDraft(
            prior.Key,
            payload,
            prior.InterfaceFingerprint,
            GraphProtocol.ShardFactHash(payload),
            GraphProtocol.Hash(payload));
    }

    private static string DeclarationFingerprint(ISymbol symbol)
    {
        symbol = Canonical(symbol);
        var builder = new StringBuilder();
        builder.Append(DocumentationCommentId.CreateDeclarationId(symbol));
        builder.Append('|').Append(symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat));
        builder.Append('|').Append(symbol.DeclaredAccessibility);
        foreach (var attribute in symbol.GetAttributes()
            .OrderBy(attribute => attribute.AttributeClass?.ToDisplayString(), StringComparer.Ordinal))
        {
            builder.Append('|').Append(attribute.ToString());
        }
        if (symbol is IFieldSymbol { HasConstantValue: true } field)
        {
            builder.Append("|const:").Append(field.ConstantValue);
        }
        if (symbol is INamedTypeSymbol type)
        {
            builder.Append("|base:").Append(type.BaseType?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat));
            foreach (var @interface in type.Interfaces
                .OrderBy(value => value.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat), StringComparer.Ordinal))
            {
                builder.Append("|interface:")
                    .Append(@interface.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat));
            }
        }
        return builder.ToString();
    }

    private static void AddDispatchCandidates(
        Dictionary<string, JsonObject> nodes,
        JsonArray unresolved,
        ProjectContext context,
        IMethodSymbol target,
        InvocationExpressionSyntax invocation,
        string root,
        string universe)
    {
        if (!target.IsAbstract
            && !target.IsVirtual
            && target.ContainingType.TypeKind != TypeKind.Interface)
        {
            return;
        }
        var candidates = context.Catalog.DispatchCandidates(target)
            .Select(candidate => EnsureNode(nodes, candidate.Context, candidate.Symbol, root))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        unresolved.Add(new JsonObject
        {
            ["provider"] = GraphProtocol.Provider,
            ["language"] = "csharp",
            ["target"] = context.Target,
            ["universe"] = universe,
            ["family"] = "dispatches",
            ["evidence"] = Evidence(context, root, invocation.GetLocation()),
            ["reason"] = candidates.Length == 0 ? "external-boundary" : "dynamic",
            ["candidates"] = new JsonArray(candidates
                .Select(candidate => JsonValue.Create(candidate))
                .ToArray()),
        });
    }

    private static void AddSemanticEdge(
        Dictionary<string, JsonObject> nodes,
        Dictionary<string, JsonObject> edges,
        ProjectContext context,
        SemanticModel model,
        ISymbol? target,
        SyntaxNode syntax,
        string root,
        string kind,
        CancellationToken cancellationToken)
    {
        var owner = model.GetEnclosingSymbol(syntax.SpanStart, cancellationToken);
        if (owner is null || target is null)
        {
            return;
        }
        AddEdge(
            edges,
            EnsureNode(nodes, context, owner, root),
            EnsureNode(nodes, context, target, root),
            kind,
            Evidence(context, root, syntax.GetLocation()));
    }

    private static void AddTypeRelations(
        Dictionary<string, JsonObject> nodes,
        Dictionary<string, JsonObject> edges,
        ProjectContext context,
        INamedTypeSymbol type,
        string from,
        string root,
        Location location)
    {
        if (type.BaseType is { SpecialType: not SpecialType.System_Object } baseType)
        {
            AddEdge(edges, from, EnsureNode(nodes, context, baseType, root), "extends", Evidence(context, root, location));
        }
        foreach (var contract in type.Interfaces)
        {
            AddEdge(
                edges,
                from,
                EnsureNode(nodes, context, contract, root),
                type.TypeKind == TypeKind.Interface ? "extends" : "implements",
                Evidence(context, root, location));
        }
    }

    private static void AddSynthesizedRecordMembers(
        Dictionary<string, JsonObject> nodes,
        Dictionary<string, JsonObject> edges,
        ProjectContext context,
        INamedTypeSymbol type,
        string owner,
        string root)
    {
        if (!type.IsRecord)
        {
            return;
        }
        foreach (var member in type.GetMembers()
            .Where(member => member.IsImplicitlyDeclared)
            .OrderBy(member => DocumentationCommentId.CreateDeclarationId(member)
                ?? member.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat), StringComparer.Ordinal))
        {
            var memberId = EnsureNode(nodes, context, member, root);
            AddEdge(edges, owner, memberId, "contains", null);
            AddOverride(nodes, edges, context, member, memberId, root,
                member.Locations.FirstOrDefault(location => location.IsInSource));
        }
    }

    private static void AddOverride(
        Dictionary<string, JsonObject> nodes,
        Dictionary<string, JsonObject> edges,
        ProjectContext context,
        ISymbol symbol,
        string from,
        string root,
        Location? location)
    {
        ISymbol? overridden = symbol switch
        {
            IMethodSymbol method => method.OverriddenMethod,
            IPropertySymbol property => property.OverriddenProperty,
            IEventSymbol @event => @event.OverriddenEvent,
            _ => null,
        };
        if (overridden is not null)
        {
            AddEdge(
                edges,
                from,
                EnsureNode(nodes, context, overridden, root),
                "overrides",
                location is null ? null : Evidence(context, root, location));
        }
        if (symbol.ContainingType is { } containingType)
        {
            foreach (var contract in containingType.AllInterfaces
                .SelectMany(@interface => @interface.GetMembers())
                .Where(contract => SymbolEqualityComparer.Default.Equals(
                    containingType.FindImplementationForInterfaceMember(contract),
                    symbol))
                .OrderBy(contract => DocumentationCommentId.CreateDeclarationId(contract)
                    ?? contract.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat), StringComparer.Ordinal))
            {
                AddEdge(
                    edges,
                    from,
                    EnsureNode(nodes, context, contract, root),
                    "implements",
                    location is null ? null : Evidence(context, root, location));
            }
        }
    }

    private static string EnsureNode(
        Dictionary<string, JsonObject> nodes,
        ProjectContext context,
        ISymbol symbol,
        string root)
    {
        var canonical = Canonical(symbol);
        var identityContext = context.Catalog.Resolve(context, canonical);
        var node = NodeForSymbol(identityContext, canonical, root);
        var id = node["id"]!.GetValue<string>();
        nodes.TryAdd(id, node);
        return id;
    }

    private static JsonObject NodeForSymbol(
        ProjectContext context,
        ISymbol symbol,
        string root)
    {
        symbol = Canonical(symbol);
        return context.Nodes.GetOrAdd(symbol, resolved =>
            CreateNodeForSymbol(context, resolved, root));
    }

    private static JsonObject CreateNodeForSymbol(
        ProjectContext context,
        ISymbol symbol,
        string root)
    {
        // A symbol is repeated in its declaration shard and every shard that
        // references it.  Build one canonical representation in all of them:
        // Roslyn's symbol location is the declaration token, while a caller-
        // supplied syntax location may span the whole body and move on body edits.
        var location = SourceLocation(symbol);
        var declaration = symbol.GetAttributes().Length == 0
            ? null
            : CanonicalDeclaration(symbol);
        var source = location?.SourceTree?.FilePath;
        var generated = source is null ? null : GeneratedGraphFile(context, root, source);
        var external = source is null || generated is null && !IsWithin(root, source);
        var kind = NodeKind(symbol, external);
        var name = symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } constructor
            ? constructor.ContainingType.Name
            : symbol.Name == "" ? symbol.ContainingAssembly?.Name ?? "external" : symbol.Name;
        var qualified = symbol.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat);
        var node = new JsonObject
        {
            ["id"] = SymbolId(context, symbol, root),
            ["kind"] = kind,
            ["language"] = "csharp",
            ["name"] = name,
            ["file"] = generated ?? (external
                ? $"bundled:///csharp/dependencies/{Safe(symbol.ContainingAssembly?.Name ?? "unknown")}"
                : GraphFile(root, Path.GetFullPath(source!))),
            ["external"] = external,
            ["signature"] = symbol.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
        };
        if (qualified != name)
        {
            node["qualifiedName"] = qualified;
        }
        if (Exported(symbol))
        {
            node["exported"] = true;
        }
        if (location is { IsInSource: true })
        {
            node["evidence"] = Evidence(context, root, location);
        }
        var modifiers = Modifiers(symbol);
        if (modifiers.Count != 0)
        {
            node["modifiers"] = new JsonArray(modifiers.Select(value => JsonValue.Create(value)).ToArray());
        }
        if (declaration is MemberDeclarationSyntax member && member.AttributeLists.Count != 0)
        {
            node["decorators"] = new JsonArray(member.AttributeLists
                .SelectMany(list => list.Attributes)
                .Select(attribute => new JsonObject
                {
                    ["name"] = attribute.Name.ToString(),
                    ["arguments"] = new JsonArray(attribute.ArgumentList?.Arguments
                        .Select(argument => DecoratorArgument(argument.Expression))
                        .ToArray() ?? []),
                })
                .ToArray());
        }
        return node;
    }

    private static JsonNode? Literal(ExpressionSyntax expression) => expression switch
    {
        LiteralExpressionSyntax literal when literal.Token.Value is string value => value,
        LiteralExpressionSyntax literal when literal.Token.Value is bool value => value,
        LiteralExpressionSyntax literal when literal.Token.Value is int value => value,
        LiteralExpressionSyntax literal when literal.Token.Value is long value => value,
        LiteralExpressionSyntax literal when literal.Token.Value is double value => value,
        _ => null,
    };

    private static JsonObject DecoratorArgument(ExpressionSyntax expression)
    {
        var output = new JsonObject();
        if (Literal(expression) is { } literal)
        {
            output["literal"] = literal;
        }
        return output;
    }

    private static ISymbol? DeclaredSymbol(
        SemanticModel model,
        SyntaxNode syntax,
        CancellationToken cancellationToken) => syntax switch
        {
            BaseNamespaceDeclarationSyntax or BaseTypeDeclarationSyntax or DelegateDeclarationSyntax
                or BaseMethodDeclarationSyntax or PropertyDeclarationSyntax or IndexerDeclarationSyntax
                or EventDeclarationSyntax or EnumMemberDeclarationSyntax or ParameterSyntax
                or LocalFunctionStatementSyntax => model.GetDeclaredSymbol(syntax, cancellationToken),
            VariableDeclaratorSyntax variable
                when variable.Parent?.Parent is FieldDeclarationSyntax or EventFieldDeclarationSyntax
                    or LocalDeclarationStatementSyntax => model.GetDeclaredSymbol(variable, cancellationToken),
            _ => null,
        };

    private static ISymbol Canonical(ISymbol symbol) => symbol switch
    {
        IMethodSymbol method => CanonicalMethod(method),
        INamedTypeSymbol type => type.OriginalDefinition,
        IPropertySymbol property => property.OriginalDefinition,
        IEventSymbol @event => @event.OriginalDefinition,
        IFieldSymbol field => field.OriginalDefinition,
        _ => symbol,
    };

    private static IMethodSymbol CanonicalMethod(IMethodSymbol method)
    {
        method = method.ReducedFrom ?? method;
        method = method.PartialDefinitionPart ?? method;
        return method.OriginalDefinition;
    }

    private static ISymbol? OwnerSymbol(ISymbol symbol) => symbol switch
    {
        INamespaceSymbol namespaceSymbol => namespaceSymbol.ContainingNamespace,
        _ => symbol.ContainingSymbol,
    };

    private static ISymbol? AttributeOwner(
        SemanticModel model,
        AttributeSyntax attribute,
        CancellationToken cancellationToken)
    {
        for (var node = attribute.Parent?.Parent; node is not null; node = node.Parent)
        {
            var symbol = DeclaredSymbol(model, node, cancellationToken);
            if (symbol is not null)
            {
                return symbol;
            }
        }
        return null;
    }

    private static string SymbolId(ProjectContext context, ISymbol symbol, string root)
    {
        symbol = Canonical(symbol);
        var source = SourceLocation(symbol)?.SourceTree?.FilePath;
        var external = source is null
            || GeneratedGraphFile(context, root, source) is null && !IsWithin(root, source);
        var kind = NodeKind(symbol, external);
        var name = symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } constructor
            ? constructor.ContainingType.Name
            : symbol.Name == "" ? symbol.ContainingAssembly?.Name ?? "external" : symbol.Name;
        var qualified = symbol.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat);
        var display = qualified == name ? name : qualified;
        var assembly = symbol.ContainingAssembly?.Identity.GetDisplayName() ?? context.Assembly;
        var documentation = DocumentationCommentId.CreateDeclarationId(symbol);
        if (documentation is null)
        {
            var owner = symbol.ContainingSymbol is null
                ? "global"
                : DocumentationCommentId.CreateDeclarationId(Canonical(symbol.ContainingSymbol))
                    ?? symbol.ContainingSymbol.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat);
            documentation = symbol switch
            {
                IParameterSymbol parameter => $"parameter:{owner}:{parameter.Ordinal}:{parameter.Name}",
                ITypeParameterSymbol parameter => $"type-parameter:{owner}:{parameter.Ordinal}:{parameter.Name}",
                ILocalSymbol local => $"local:{owner}:{LexicalIdentity(local, root)}:{local.Name}:{local.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}",
                _ => $"structural:{owner}:{LexicalIdentity(symbol, root)}:{symbol.Kind}:{symbol.Name}",
            };
        }
        var native = $"csharp-v1|{assembly.Length}:{assembly}|{context.Framework.Length}:{context.Framework}|{documentation}|{kind}";
        var unstable = symbol is IMethodSymbol { MethodKind: MethodKind.AnonymousFunction }
            or INamedTypeSymbol { IsAnonymousType: true };
        return SemanticNodeId(
            native,
            kind,
            display,
            context.Target,
            unstable ? "generation" : "persistent",
            DocumentationCommentId.CreateDeclarationId(symbol) is null
                ? "structural"
                : "semantic");
    }

    private static string LexicalIdentity(ISymbol symbol, string root)
    {
        var location = SourceLocation(symbol);
        if (location?.SourceTree is not { } tree)
        {
            return "generated";
        }
        var syntaxRoot = tree.GetRoot();
        var syntax = syntaxRoot.FindNode(location.SourceSpan, getInnermostNodeForTie: true);
        var parts = new Stack<string>();
        for (var node = syntax; node.Parent is { } parent; node = parent)
        {
            var ordinal = parent.ChildNodes()
                .Where(sibling => sibling.RawKind == node.RawKind)
                .TakeWhile(sibling => sibling != node)
                .Count();
            parts.Push($"{node.RawKind}:{ordinal}");
            if (DeclaredSymbolFromShape(node))
            {
                break;
            }
        }
        return $"{GraphFile(root, Path.GetFullPath(tree.FilePath))}:{string.Join('/', parts)}";
    }

    private static Location? SourceLocation(ISymbol symbol)
    {
        Location? best = null;
        foreach (var location in symbol.Locations)
        {
            if (location.IsInSource
                && (best is null || CompareSourcePosition(location, best) < 0))
            {
                best = location;
            }
        }
        return best;
    }

    private static SyntaxNode? CanonicalDeclaration(ISymbol symbol)
    {
        SyntaxReference? best = null;
        foreach (var reference in symbol.DeclaringSyntaxReferences)
        {
            if (best is null || CompareSourcePosition(reference, best) < 0)
            {
                best = reference;
            }
        }
        return best?.GetSyntax();
    }

    private static int CompareSourcePosition(Location left, Location right)
    {
        var compared = CompareSourcePath(
            left.SourceTree?.FilePath ?? "",
            right.SourceTree?.FilePath ?? "");
        return compared != 0
            ? compared
            : left.SourceSpan.Start != right.SourceSpan.Start
                ? left.SourceSpan.Start.CompareTo(right.SourceSpan.Start)
                : left.SourceSpan.Length.CompareTo(right.SourceSpan.Length);
    }

    private static int CompareSourcePosition(
        SyntaxReference left,
        SyntaxReference right)
    {
        var compared = CompareSourcePath(
            left.SyntaxTree.FilePath ?? "",
            right.SyntaxTree.FilePath ?? "");
        return compared != 0
            ? compared
            : left.Span.Start != right.Span.Start
                ? left.Span.Start.CompareTo(right.Span.Start)
                : left.Span.Length.CompareTo(right.Span.Length);
    }

    private static int CompareSourcePath(string left, string right)
    {
        var compared = StringComparer.OrdinalIgnoreCase.Compare(left, right);
        return compared != 0 ? compared : StringComparer.Ordinal.Compare(left, right);
    }

    private static bool DeclaredSymbolFromShape(SyntaxNode syntax) => syntax is
        BaseNamespaceDeclarationSyntax or BaseTypeDeclarationSyntax or DelegateDeclarationSyntax
        or BaseMethodDeclarationSyntax or PropertyDeclarationSyntax or IndexerDeclarationSyntax
        or EventDeclarationSyntax or EnumMemberDeclarationSyntax or LocalFunctionStatementSyntax;

    private static string ProjectNodeId(ProjectContext context) =>
        SemanticNodeId(
            $"project:{context.ProjectFile}:{context.Assembly}:{context.Framework}",
            "package",
            context.Assembly,
            context.Target);

    private static string SemanticNodeId(
        string symbol,
        string role,
        string display,
        string target,
        string stability = "persistent",
        string nativeStability = "semantic")
    {
        var fields = new (string Name, string Value)[]
        {
            ("version", "2"),
            ("language", "csharp"),
            ("role", role),
            ("symbol", symbol),
            ("stability", stability),
            ("scope.target", target),
            ("native.stability", nativeStability),
            ("native.key", symbol),
            ("display", display),
        };
        var encoded = string.Concat(fields.Select(field =>
            $"{Encoding.UTF8.GetByteCount(field.Name)}:{field.Name}{Encoding.UTF8.GetByteCount(field.Value)}:{field.Value}"));
        return $"@v2/csharp/{GraphProtocol.HashText(encoded)}#{EncodeComponent(display)}:{role}";
    }

    private static string EncodeComponent(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        var output = new StringBuilder(bytes.Length);
        foreach (var valueByte in bytes)
        {
            var character = (char)valueByte;
            if ((character >= 'A' && character <= 'Z')
                || (character >= 'a' && character <= 'z')
                || (character >= '0' && character <= '9')
                || character is '-' or '_' or '.' or '!' or '~' or '*' or '\'' or '(' or ')')
            {
                output.Append(character);
            }
            else
            {
                output.Append('%');
                output.Append(valueByte.ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
            }
        }
        return output.ToString();
    }

    private static string NodeKind(ISymbol symbol, bool external)
    {
        if (external)
        {
            return "external_symbol";
        }
        return symbol switch
        {
            INamespaceSymbol => "namespace",
            INamedTypeSymbol { TypeKind: TypeKind.Class } => "class",
            INamedTypeSymbol { TypeKind: TypeKind.Interface } => "interface",
            INamedTypeSymbol { TypeKind: TypeKind.Enum } => "enum",
            INamedTypeSymbol => "type",
            IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor } => "constructor",
            IMethodSymbol { MethodKind: MethodKind.LocalFunction or MethodKind.AnonymousFunction } => "function",
            IMethodSymbol => "method",
            IPropertySymbol => "property",
            IFieldSymbol => "field",
            IEventSymbol => "property",
            IParameterSymbol or ITypeParameterSymbol => "parameter",
            ILocalSymbol => "variable",
            _ => "variable",
        };
    }

    private static bool Exported(ISymbol symbol) => symbol.DeclaredAccessibility is
        Accessibility.Public or Accessibility.Protected or Accessibility.ProtectedOrInternal;

    private static List<string> Modifiers(ISymbol symbol)
    {
        var output = new List<string>();
        var accessibility = symbol.DeclaredAccessibility switch
        {
            Accessibility.Public => "public",
            Accessibility.Private => "private",
            Accessibility.Protected => "protected",
            Accessibility.Internal => "internal",
            Accessibility.ProtectedOrInternal => "protected",
            Accessibility.ProtectedAndInternal => "private",
            _ => null,
        };
        if (accessibility is not null)
        {
            output.Add(accessibility);
        }
        if (symbol.IsStatic)
        {
            output.Add("static");
        }
        if (symbol.IsAbstract)
        {
            output.Add("abstract");
        }
        if (symbol is IFieldSymbol { IsReadOnly: true } or IPropertySymbol { IsReadOnly: true })
        {
            output.Add("readonly");
        }
        if (symbol is IMethodSymbol { IsAsync: true })
        {
            output.Add("async");
        }
        if (symbol is IFieldSymbol { IsConst: true })
        {
            output.Add("const");
        }
        return output;
    }

    private static bool IsTest(ISymbol symbol) => symbol.GetAttributes().Any(attribute =>
        attribute.AttributeClass?.ToDisplayString() is
            "Xunit.FactAttribute" or "Xunit.TheoryAttribute"
            or "NUnit.Framework.TestAttribute" or "NUnit.Framework.TestCaseAttribute"
            or "Microsoft.VisualStudio.TestTools.UnitTesting.TestMethodAttribute");

    private static bool IsDeclarationIdentifier(IdentifierNameSyntax identifier) =>
        identifier.Parent is NameEqualsSyntax or NameColonSyntax
        || identifier.Ancestors().Any(ancestor => ancestor is AttributeSyntax attribute && attribute.Name == identifier);

    private static void AddEdge(
        Dictionary<string, JsonObject> edges,
        string from,
        string to,
        string kind,
        JsonObject? evidence)
    {
        if (from == to)
        {
            return;
        }
        var key = $"{kind}\0{from}\0{to}";
        if (edges.ContainsKey(key))
        {
            return;
        }
        var edge = new JsonObject
        {
            ["from"] = from,
            ["to"] = to,
            ["kind"] = kind,
        };
        if (evidence is not null)
        {
            edge["evidence"] = evidence;
        }
        edges[key] = edge;
    }

    private static string EdgeKey(JsonObject edge) => string.Join('\0',
        edge["kind"]!.GetValue<string>(),
        edge["from"]!.GetValue<string>(),
        edge["to"]!.GetValue<string>());

    private static JsonObject Evidence(
        ProjectContext context,
        string root,
        Location location)
    {
        var span = location.GetLineSpan();
        var start = span.StartLinePosition;
        var end = span.EndLinePosition;
        return new JsonObject
        {
            ["file"] = location.SourceTree?.FilePath is { Length: > 0 } file
                ? GeneratedGraphFile(context, root, file)
                    ?? GraphFile(root, Path.GetFullPath(file))
                : "",
            ["startLine"] = start.Line + 1,
            ["startCol"] = start.Character + 1,
            ["endLine"] = end.Line + 1,
            ["endCol"] = end.Character + 1,
        };
    }

    private static JsonObject DiagnosticNode(
        ProjectContext context,
        string root,
        Diagnostic diagnostic)
    {
        if (!diagnostic.Location.IsInSource)
        {
            return new JsonObject
            {
                ["file"] = "",
                ["line"] = 0,
                ["column"] = 0,
                ["code"] = diagnostic.Id,
                ["message"] = diagnostic.GetMessage(),
                ["severity"] = Severity(diagnostic.Severity),
            };
        }
        var span = diagnostic.Location.GetLineSpan();
        return new JsonObject
        {
            ["file"] = GeneratedGraphFile(context, root, span.Path)
                ?? GraphFile(root, Path.GetFullPath(span.Path)),
            ["line"] = span.StartLinePosition.Line + 1,
            ["column"] = span.StartLinePosition.Character + 1,
            ["code"] = diagnostic.Id,
            ["message"] = diagnostic.GetMessage(),
            ["severity"] = Severity(diagnostic.Severity),
        };
    }

    private static string DiagnosticKey(JsonObject diagnostic) => string.Join('\0',
        diagnostic["file"]!.GetValue<string>(),
        diagnostic["line"]!.GetValue<int>().ToString("D10",
            System.Globalization.CultureInfo.InvariantCulture),
        diagnostic["column"]!.GetValue<int>().ToString("D10",
            System.Globalization.CultureInfo.InvariantCulture),
        diagnostic["code"]!.GetValue<string>(),
        diagnostic["severity"]!.GetValue<string>(),
        diagnostic["message"]!.GetValue<string>());

    private static string Severity(DiagnosticSeverity severity) => severity switch
    {
        DiagnosticSeverity.Error => "error",
        DiagnosticSeverity.Warning => "warning",
        DiagnosticSeverity.Info => "info",
        _ => "hint",
    };

    private static ShardDraft Shard(
        string key,
        string target,
        JsonArray nodes,
        JsonArray edges,
        JsonArray diagnostics,
        JsonArray coverage,
        JsonArray unresolved,
        JsonArray sources,
        string interfaceFingerprint = "")
    {
        var payload = new JsonObject
        {
            ["key"] = key,
            ["target"] = target,
            ["languages"] = new JsonArray("csharp"),
            ["nodes"] = nodes,
            ["edges"] = edges,
            ["diagnostics"] = diagnostics,
            ["coverage"] = coverage,
            ["unresolved"] = unresolved,
            ["sources"] = sources,
        };
        return new ShardDraft(
            key,
            payload,
            interfaceFingerprint,
            GraphProtocol.ShardFactHash(payload),
            GraphProtocol.Hash(payload));
    }

    private static async Task<IReadOnlyList<Diagnostic>> DiagnosticsOf(
        Project project,
        Compilation compilation,
        CancellationToken cancellationToken)
    {
        var analyzers = project.AnalyzerReferences
            .SelectMany(reference => reference.GetAnalyzers(LanguageNames.CSharp))
            .Distinct()
            .ToImmutableArray();
        return analyzers.Length == 0
            ? compilation.GetDiagnostics(cancellationToken)
            : await compilation
                .WithAnalyzers(
                    analyzers,
                    project.AnalyzerOptions)
                .GetAllDiagnosticsAsync(cancellationToken)
                .ConfigureAwait(false);
    }

    private static async Task<IReadOnlyList<Diagnostic>> IncrementalDiagnosticsOf(
        IReadOnlyList<Document> documents,
        CancellationToken cancellationToken)
    {
        var diagnostics = new List<Diagnostic>();
        foreach (var document in documents)
        {
            var model = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
            if (model is null)
            {
                continue;
            }
            diagnostics.AddRange(model.GetDiagnostics(cancellationToken: cancellationToken));
        }
        return diagnostics;
    }

    private static List<JsonObject> BuildSources(
        string root,
        IReadOnlyList<ProjectContext> contexts)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "global.json", "Directory.Build.props", "Directory.Build.targets",
            "Directory.Packages.props", "packages.lock.json", "nuget.config",
        };
        var files = EnumerateWorkspaceFiles(root)
            .Where(file => Path.GetExtension(file).ToLowerInvariant() is ".sln" or ".slnx" or ".csproj" or ".props" or ".targets"
                || names.Contains(Path.GetFileName(file)))
            .Concat(contexts.SelectMany(context => context.Project.MetadataReferences
                .Select(reference => reference.Display)))
            .Concat(contexts.SelectMany(context => context.Project.AnalyzerReferences
                .Select(reference => reference.FullPath)))
            .Concat(contexts.SelectMany(context => context.Project.AdditionalDocuments
                .Concat(context.Project.AnalyzerConfigDocuments)
                .Select(document => document.FilePath)))
            .Concat(contexts.Select(context => context.Project.FilePath is null
                ? null
                : Path.Combine(
                    Path.GetDirectoryName(context.Project.FilePath)!,
                    "obj",
                    "project.assets.json")))
            .Where(file => file is { Length: > 0 } && File.Exists(file))
            .Select(file => Path.GetFullPath(file!))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(SourceOf)
            .OrderBy(source => source["file"]!.GetValue<string>(), StringComparer.Ordinal)
            .ToList();
        return files;
    }

    private static IEnumerable<string> EnumerateWorkspaceFiles(string root)
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
                else if (File.Exists(entry))
                {
                    yield return entry;
                }
            }
        }
    }

    private static JsonObject SourceOf(string file)
    {
        if (file.StartsWith("bundled:///", StringComparison.Ordinal))
        {
            var digest = GraphProtocol.HashText(file);
            return new JsonObject
            {
                ["file"] = file,
                ["checkerDigest"] = digest,
                ["diskDigest"] = "",
            };
        }
        var absolute = Path.GetFullPath(file);
        var bytes = File.ReadAllBytes(absolute);
        var byteDigest = GraphProtocol.HashBytes(bytes);
        return new JsonObject
        {
            ["file"] = absolute,
            // Build inputs include binary metadata and analyzers as well as
            // XML/MSBuild text. Roslyn consumes their bytes, so one atomic byte
            // read is both the checker identity and the publication fence.
            ["checkerDigest"] = byteDigest,
            ["diskDigest"] = byteDigest,
        };
    }

    private static string SourceIdentity(
        ProjectContext context,
        Document document,
        bool generated)
    {
        if (generated)
        {
            return GeneratedSourceIdentity(context, document);
        }
        if (document.FilePath is { Length: > 0 } file)
        {
            return Path.GetFullPath(file);
        }
        return $"bundled:///csharp/documents/{GraphProtocol.HashText(context.Target)}/{Safe(document.Name)}";
    }

    private static string GeneratedSourceIdentity(
        ProjectContext context,
        Document document)
    {
        var origin = document.FilePath is { Length: > 0 } file
            ? Path.GetFullPath(file)
            : string.Join('/', document.Folders.Append(document.Name));
        return $"bundled:///csharp/generated/{GraphProtocol.HashText(context.Target)}/{GraphProtocol.HashText(origin)}/{Safe(document.Name)}";
    }

    private static string? GeneratedGraphFile(
        ProjectContext context,
        string root,
        string source)
    {
        var absolute = Path.GetFullPath(source);
        if (context.GeneratedSources.TryGetValue(absolute, out var generated))
        {
            return generated;
        }
        return IsWithin(root, absolute) && Ignored(root, absolute)
            ? $"bundled:///csharp/generated/{GraphProtocol.HashText(context.Target)}/{GraphProtocol.HashText(absolute)}/{Safe(Path.GetFileName(absolute))}"
            : null;
    }

    private static string DocumentIdentity(Document document) =>
        document.FilePath is { Length: > 0 } file ? Path.GetFullPath(file) : document.Name;

    private static string GraphFile(string root, string source)
    {
        if (source.StartsWith("bundled:///", StringComparison.Ordinal))
        {
            return source;
        }
        var relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(source));
        if (Path.IsPathRooted(relative) || relative == ".")
        {
            var absolute = Path.GetFullPath(source);
            return $"bundled:///csharp/external-source/{GraphProtocol.HashText(absolute)}/{Safe(Path.GetFileName(absolute))}";
        }
        return relative.Replace(Path.DirectorySeparatorChar, '/').Replace(Path.AltDirectorySeparatorChar, '/');
    }

    private static bool IsWithin(string root, string file)
    {
        var relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(file));
        return relative != ".."
            && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            && !Path.IsPathRooted(relative);
    }

    private static bool Ignored(string root, string file)
    {
        var parts = Path.GetRelativePath(root, file)
            .Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return parts.Any(part => part is ".git" or ".wiki" or "bin" or "node_modules" or "obj");
    }

    private static string TargetFramework(Compilation compilation)
    {
        var attribute = compilation.Assembly.GetAttributes().FirstOrDefault(candidate =>
            candidate.AttributeClass?.ToDisplayString() == "System.Runtime.Versioning.TargetFrameworkAttribute");
        return attribute?.ConstructorArguments.FirstOrDefault().Value as string ?? "unspecified";
    }

    private static string Safe(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            builder.Append(char.IsLetterOrDigit(character) || character is '.' or '-' or '_'
                ? character
                : '_');
        }
        return builder.Length == 0 ? "unknown" : builder.ToString();
    }

    private sealed class ProjectContext(
        Project project,
        Compilation compilation,
        string target,
        string assembly,
        string framework,
        string projectFile,
        IReadOnlyList<Diagnostic> diagnostics,
        IReadOnlyList<ContextDocument>? documents = null,
        IReadOnlyList<ContextDocument>? generatedDocuments = null)
    {
        public Project Project { get; } = project;
        public Compilation Compilation { get; } = compilation;
        public string Target { get; } = target;
        public string Assembly { get; } = assembly;
        public string Framework { get; } = framework;
        public string ProjectFile { get; } = projectFile;
        public IReadOnlyList<Diagnostic> Diagnostics { get; set; } = diagnostics;
        public Dictionary<string, string> GeneratedSources { get; } =
            new(StringComparer.OrdinalIgnoreCase);
        public IReadOnlyList<ContextDocument>? Documents { get; set; } = documents;
        public IReadOnlyList<ContextDocument>? GeneratedDocuments { get; set; } =
            generatedDocuments;
        public ConcurrentDictionary<ISymbol, JsonObject> Nodes { get; } =
            new(SymbolEqualityComparer.Default);
        public ProjectCatalog Catalog { get; set; } = null!;
    }

    private sealed record ContextDocument(Document Document, bool Generated);

    private sealed class ProjectCatalog(IReadOnlyList<ProjectContext> contexts)
    {
        private readonly ConcurrentDictionary<string, IReadOnlyList<DispatchCandidate>> dispatchCache =
            new(StringComparer.Ordinal);

        public ProjectContext Resolve(ProjectContext current, ISymbol symbol)
        {
            var assembly = symbol.ContainingAssembly?.Identity.GetDisplayName();
            if (assembly is null)
            {
                return current;
            }
            if (current.Assembly == assembly)
            {
                return current;
            }
            var candidates = contexts
                .Where(context => context.Assembly == assembly)
                .ToArray();
            if (candidates.Length == 0)
            {
                return current;
            }
            var sourceFiles = symbol.Locations
                .Where(location => location.IsInSource && location.SourceTree?.FilePath is { Length: > 0 })
                .Select(location => Path.GetFullPath(location.SourceTree!.FilePath))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            var matchingFramework = candidates
                .Where(context => context.Framework == current.Framework)
                .ToArray();
            var bySource = matchingFramework
                .Concat(candidates.Except(matchingFramework))
                .FirstOrDefault(context => context.Project.Documents
                        .Any(document => document.FilePath is { Length: > 0 } file
                            && sourceFiles.Contains(Path.GetFullPath(file)))
                    || sourceFiles.Any(context.GeneratedSources.ContainsKey));
            return bySource
                ?? matchingFramework.FirstOrDefault()
                ?? candidates[0];
        }

        public IReadOnlyList<DispatchCandidate> DispatchCandidates(IMethodSymbol target)
        {
            target = CanonicalMethod(target);
            var declarationId = DocumentationCommentId.CreateDeclarationId(target);
            if (declarationId is null)
            {
                return [];
            }
            var assembly = target.ContainingAssembly?.Identity.GetDisplayName();
            var cacheKey = $"{assembly}\0{declarationId}";
            if (dispatchCache.TryGetValue(cacheKey, out var cached))
            {
                return cached;
            }
            var output = new List<DispatchCandidate>();
            foreach (var context in contexts)
            {
                var localTarget = DocumentationCommentId
                    .GetSymbolsForDeclarationId(declarationId, context.Compilation)
                    .OfType<IMethodSymbol>()
                    .FirstOrDefault(candidate => assembly is null
                        || candidate.ContainingAssembly?.Identity.GetDisplayName() == assembly);
                if (localTarget is null)
                {
                    continue;
                }
                foreach (var type in AllTypes(context.Compilation.Assembly.GlobalNamespace)
                    .Where(type => !type.IsAbstract))
                {
                    IMethodSymbol? implementation;
                    if (localTarget.ContainingType.TypeKind == TypeKind.Interface)
                    {
                        implementation = type.FindImplementationForInterfaceMember(localTarget)
                            as IMethodSymbol;
                    }
                    else
                    {
                        implementation = type.GetMembers(localTarget.Name)
                            .OfType<IMethodSymbol>()
                            .FirstOrDefault(candidate => Overrides(candidate, localTarget));
                        if (implementation is null
                            && !localTarget.IsAbstract
                            && SymbolEqualityComparer.Default.Equals(type, localTarget.ContainingType))
                        {
                            implementation = localTarget;
                        }
                    }
                    if (implementation is not null && !implementation.IsAbstract)
                    {
                        output.Add(new DispatchCandidate(
                            context,
                            CanonicalMethod(implementation)));
                    }
                }
            }
            var result = output
                .DistinctBy(candidate => $"{candidate.Context.Target}\0{DocumentationCommentId.CreateDeclarationId(candidate.Symbol)}")
                .ToArray();
            return dispatchCache.GetOrAdd(cacheKey, result);
        }

        private static bool Overrides(IMethodSymbol candidate, IMethodSymbol target)
        {
            for (var current = candidate.OverriddenMethod;
                current is not null;
                current = current.OverriddenMethod)
            {
                if (SymbolEqualityComparer.Default.Equals(
                    current.OriginalDefinition,
                    target.OriginalDefinition))
                {
                    return true;
                }
            }
            return false;
        }

        private static IEnumerable<INamedTypeSymbol> AllTypes(INamespaceSymbol root)
        {
            foreach (var type in root.GetTypeMembers())
            {
                foreach (var nested in AllTypes(type))
                {
                    yield return nested;
                }
            }
            foreach (var child in root.GetNamespaceMembers())
            {
                foreach (var type in AllTypes(child))
                {
                    yield return type;
                }
            }
        }

        private static IEnumerable<INamedTypeSymbol> AllTypes(INamedTypeSymbol root)
        {
            yield return root;
            foreach (var child in root.GetTypeMembers())
            {
                foreach (var nested in AllTypes(child))
                {
                    yield return nested;
                }
            }
        }
    }

    private sealed record DispatchCandidate(ProjectContext Context, IMethodSymbol Symbol);

    private sealed record DocumentWork(
        ProjectContext Context,
        Document Document,
        string Key,
        bool Generated);
}
