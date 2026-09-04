using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Diagnostics;

namespace Samchon.Graph.CSharp;

internal static class Program
{
    public static async Task Main(string[] args)
    {
        if (args is ["--dotnet-host", var host, .. var trailing])
        {
            MakeDotNetDiscoverable(host);
            args = trailing;
        }
        if (args is ["--measure-load", var root])
        {
            var elapsed = await WorkspaceGraphService.MeasureLoadAsync(
                root,
                CancellationToken.None).ConfigureAwait(false);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                phase = "msbuild-workspace-load",
                elapsedMs = elapsed,
            }));
            return;
        }
        if (args.Length != 0)
        {
            throw new ArgumentException("Usage: samchon-roslyn [--measure-load <workspace-root>]");
        }
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();
        await new JsonRpcServer(input, output).RunAsync().ConfigureAwait(false);
    }

    private static void MakeDotNetDiscoverable(string host)
    {
        if (!Path.IsPathFullyQualified(host) || !File.Exists(host))
        {
            throw new ArgumentException("--dotnet-host must name an absolute executable.");
        }
        var directory = Path.GetDirectoryName(host)!;
        Environment.SetEnvironmentVariable("DOTNET_ROOT", directory);
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        if (!path.Split(Path.PathSeparator).Any(entry =>
                string.Equals(entry.TrimEnd(Path.DirectorySeparatorChar),
                    directory.TrimEnd(Path.DirectorySeparatorChar),
                    StringComparison.OrdinalIgnoreCase)))
        {
            Environment.SetEnvironmentVariable(
                "PATH",
                directory + (path.Length == 0 ? string.Empty : Path.PathSeparator + path));
        }
    }
}

internal sealed class JsonRpcServer(Stream input, Stream output)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly ConcurrentDictionary<string, CancellationTokenSource> requests = new();
    private readonly SemaphoreSlim writes = new(1, 1);
    private WorkspaceGraphService? graph;
    private bool shutdown;

    public async Task RunAsync()
    {
        var pending = new List<Task>();
        while (await ReadMessageAsync(input, CancellationToken.None).ConfigureAwait(false) is { } message)
        {
            if (!message.RootElement.TryGetProperty("method", out var methodElement))
            {
                message.Dispose();
                continue;
            }
            var method = methodElement.GetString() ?? "";
            if (method == "$/cancelRequest")
            {
                Cancel(message.RootElement);
                message.Dispose();
                continue;
            }
            if (method == "exit")
            {
                message.Dispose();
                break;
            }
            pending.Add(HandleAsync(message, method));
        }
        await Task.WhenAll(pending).ConfigureAwait(false);
        if (graph is not null)
        {
            await graph.DisposeAsync().ConfigureAwait(false);
        }
    }

    private async Task HandleAsync(JsonDocument message, string method)
    {
        using (message)
        {
            var root = message.RootElement;
            var hasId = root.TryGetProperty("id", out var idElement);
            var id = hasId ? idElement.Clone() : default;
            var requestKey = hasId ? id.GetRawText() : "";
            using var cancellation = new CancellationTokenSource();
            if (hasId)
            {
                requests[requestKey] = cancellation;
            }
            try
            {
                var result = await DispatchAsync(root, method, cancellation.Token).ConfigureAwait(false);
                if (hasId)
                {
                    await RespondAsync(id, result, cancellation.Token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                if (hasId)
                {
                    await ErrorAsync(id, -32800, "Request cancelled", CancellationToken.None)
                        .ConfigureAwait(false);
                }
            }
            catch (SnapshotInvalidatedException error)
            {
                if (hasId)
                {
                    await ErrorAsync(id, -32801, error.Message, CancellationToken.None)
                        .ConfigureAwait(false);
                }
            }
            catch (Exception error)
            {
                if (hasId)
                {
                    await ErrorAsync(id, -32603, error.Message, CancellationToken.None)
                        .ConfigureAwait(false);
                }
                Console.Error.WriteLine(error);
            }
            finally
            {
                if (hasId)
                {
                    requests.TryRemove(requestKey, out _);
                }
            }
        }
    }

    private async Task<JsonNode?> DispatchAsync(
        JsonElement request,
        string method,
        CancellationToken cancellationToken)
    {
        switch (method)
        {
            case "initialize":
                {
                    if (shutdown)
                    {
                        throw new InvalidOperationException("Roslyn graph server is shutting down");
                    }
                    var parameters = request.GetProperty("params");
                    var rootUri = parameters.TryGetProperty("rootUri", out var rootElement)
                        ? rootElement.GetString()
                        : null;
                    if (string.IsNullOrWhiteSpace(rootUri))
                    {
                        throw new InvalidOperationException("initialize.rootUri is required");
                    }
                    var root = Path.GetFullPath(new Uri(rootUri).LocalPath);
                    graph = new WorkspaceGraphService(root);
                    return new JsonObject
                    {
                        ["capabilities"] = new JsonObject
                        {
                            ["executeCommandProvider"] = new JsonObject
                            {
                                ["commands"] = new JsonArray("csharp.graph.snapshot"),
                            },
                        },
                        ["serverInfo"] = new JsonObject
                        {
                            ["name"] = GraphProtocol.Producer,
                            ["version"] = GraphProtocol.Version,
                        },
                    };
                }
            case "initialized":
                return null;
            case "workspace/didChangeWatchedFiles":
                RequireGraph().NotifyChangedFiles(request.GetProperty("params"));
                return null;
            case "workspace/executeCommand":
                {
                    var parameters = request.GetProperty("params");
                    var command = parameters.GetProperty("command").GetString();
                    if (command != "csharp.graph.snapshot")
                    {
                        throw new InvalidOperationException($"Unsupported command: {command}");
                    }
                    string? knownGeneration = null;
                    if (parameters.TryGetProperty("arguments", out var arguments)
                        && arguments.ValueKind == JsonValueKind.Array
                        && arguments.GetArrayLength() != 0
                        && arguments[0].ValueKind == JsonValueKind.Object
                        && arguments[0].TryGetProperty("knownGeneration", out var known)
                        && known.ValueKind == JsonValueKind.String)
                    {
                        knownGeneration = known.GetString();
                    }
                    return await RequireGraph().SnapshotAsync(knownGeneration, cancellationToken)
                        .ConfigureAwait(false);
                }
            case "shutdown":
                shutdown = true;
                return null;
            default:
                throw new InvalidOperationException($"Unsupported method: {method}");
        }
    }

    private WorkspaceGraphService RequireGraph() => graph
        ?? throw new InvalidOperationException("Roslyn graph server is not initialized");

    private void Cancel(JsonElement message)
    {
        if (!message.TryGetProperty("params", out var parameters)
            || !parameters.TryGetProperty("id", out var id))
        {
            return;
        }
        if (requests.TryGetValue(id.GetRawText(), out var cancellation))
        {
            cancellation.Cancel();
        }
    }

    private Task RespondAsync(JsonElement id, JsonNode? result, CancellationToken cancellationToken) =>
        WriteAsync(new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = JsonNode.Parse(id.GetRawText()),
            ["result"] = result,
        }, cancellationToken);

    private Task ErrorAsync(
        JsonElement id,
        int code,
        string message,
        CancellationToken cancellationToken) => WriteAsync(new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = JsonNode.Parse(id.GetRawText()),
            ["error"] = new JsonObject
            {
                ["code"] = code,
                ["message"] = message,
            },
        }, cancellationToken);

    private async Task WriteAsync(JsonObject message, CancellationToken cancellationToken)
    {
        var timing = Stopwatch.StartNew();
        var body = JsonSerializer.SerializeToUtf8Bytes(message, JsonOptions);
        Trace("json-serialize", timing.ElapsedMilliseconds, body.Length);
        var header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
        timing.Restart();
        await writes.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await output.WriteAsync(header, cancellationToken).ConfigureAwait(false);
            await output.WriteAsync(body, cancellationToken).ConfigureAwait(false);
            await output.FlushAsync(cancellationToken).ConfigureAwait(false);
            Trace("json-write", timing.ElapsedMilliseconds, body.Length);
        }
        finally
        {
            writes.Release();
        }
    }

    private static void Trace(string phase, long elapsedMs, int bytes)
    {
        if (Environment.GetEnvironmentVariable("SAMCHON_GRAPH_ROSLYN_TRACE") == "1")
        {
            Console.Error.WriteLine(
                $"{{\"phase\":\"roslyn-{phase}\",\"elapsedMs\":{elapsedMs},\"bytes\":{bytes}}}");
        }
    }

    private static async Task<JsonDocument?> ReadMessageAsync(
        Stream stream,
        CancellationToken cancellationToken)
    {
        var header = new List<byte>();
        var suffix = 0;
        while (suffix != 4)
        {
            var value = new byte[1];
            if (await stream.ReadAsync(value, cancellationToken).ConfigureAwait(false) == 0)
            {
                return header.Count == 0
                    ? null
                    : throw new EndOfStreamException("Truncated LSP header");
            }
            header.Add(value[0]);
            suffix = value[0] == "\r\n\r\n"[suffix]
                ? suffix + 1
                : value[0] == '\r' ? 1 : 0;
            if (header.Count > 16 * 1024)
            {
                throw new InvalidDataException("LSP header is too large");
            }
        }
        var text = Encoding.ASCII.GetString([.. header]);
        var length = text.Split("\r\n", StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Split(':', 2))
            .Where(parts => parts.Length == 2 && parts[0].Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
            .Select(parts => int.Parse(parts[1].Trim(), System.Globalization.CultureInfo.InvariantCulture))
            .Single();
        if (length <= 0)
        {
            throw new InvalidDataException("LSP Content-Length must be positive");
        }
        var body = new byte[length];
        var offset = 0;
        while (offset != body.Length)
        {
            var read = await stream.ReadAsync(body.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                throw new EndOfStreamException("Truncated LSP body");
            }
            offset += read;
        }
        return JsonDocument.Parse(body);
    }
}

internal sealed class SnapshotInvalidatedException(string message) : Exception(message);
