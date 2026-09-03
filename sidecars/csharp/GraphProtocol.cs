using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Globalization;

namespace Samchon.Graph.CSharp;

internal static class GraphProtocol
{
    public const string Provider = "roslyn-workspace";
    public const string Producer = "samchon-roslyn";
    public const string Version = "1.0.0";

    public static readonly string[] Facts =
    [
        "contains",
        "exports",
        "imports",
        "calls",
        "accesses",
        "instantiates",
        "type_ref",
        "extends",
        "implements",
        "overrides",
        "dispatches",
        "decorates",
        "tests",
        "references",
    ];

    public static readonly string[] Capabilities =
    [
        "coverage",
        "diagnostics",
        "diskDigests",
        "incremental",
        "sourceDigests",
        "universe",
        "unresolved",
        "immutableSolution",
        "sourceGeneratedDocuments",
    ];

    public static JsonObject Unchanged(GraphGeneration generation) => new()
    {
        ["protocolVersion"] = 1,
        ["mode"] = "unchanged",
        ["sequence"] = generation.Sequence,
        ["generation"] = generation.Generation,
        ["universe"] = generation.Universe,
        ["frames"] = new JsonArray(),
    };

    public static JsonObject Replay(GraphGeneration generation, string? knownGeneration)
    {
        var original = generation.Envelope.DeepClone().AsObject();
        var originalBegin = original["frames"]!.AsArray()
            .Single(frame => frame!["type"]!.GetValue<string>() == "begin")!;
        if ((knownGeneration is null
                && original["mode"]!.GetValue<string>() == "initial")
            || originalBegin["baseGeneration"]?.GetValue<string>() == knownGeneration)
        {
            return original;
        }
        var envelope = Commit(null, generation.Draft, generation.CompilerVersion);
        if (envelope["generation"]!.GetValue<string>() != generation.Generation
            || envelope["universe"]!.GetValue<string>() != generation.Universe)
        {
            throw new InvalidOperationException(
                "C# workspace graph cannot replay a generation whose sealed draft moved");
        }
        envelope["mode"] = knownGeneration is null ? "initial" : "rebuild";
        envelope["sequence"] = generation.Sequence;
        var frames = envelope["frames"]!.AsArray();
        frames.Single(frame => frame!["type"]!.GetValue<string>() == "begin")!["sequence"] = generation.Sequence;
        frames.Single(frame => frame!["type"]!.GetValue<string>() == "commit")!["sequence"] = generation.Sequence;
        return envelope;
    }

    public static JsonObject Commit(
        GraphGeneration? previous,
        GraphDraft draft,
        string compilerVersion)
    {
        var universe = draft.UniverseFingerprint;
        var full = previous is null || previous.Universe != universe;
        var sequence = (previous?.Sequence ?? 0) + 1;
        var shards = draft.Shards
            .OrderBy(shard => shard.Key, StringComparer.Ordinal)
            .ToDictionary(shard => shard.Key, StringComparer.Ordinal);
        var previousShards = previous?.Draft.Shards
            .ToDictionary(shard => shard.Key, StringComparer.Ordinal);
        var manifest = shards.Values
            .Select(shard => new ManifestEntry(shard.Key, shard.PayloadDigest))
            .ToArray();
        var generation = Hash(new JsonObject
        {
            ["universe"] = universe,
            ["shards"] = new JsonArray(manifest.Select(entry => entry.Json()).ToArray()),
        });
        if (previous is not null && previous.Generation == generation)
        {
            return Unchanged(previous);
        }

        var hello = Hello(compilerVersion);
        var allSources = Sources(shards.Values);
        var begin = new JsonObject
        {
            ["type"] = "begin",
            ["sequence"] = sequence,
            ["generation"] = generation,
            ["universe"] = universe,
            ["manifest"] = ManifestDigest(allSources),
            ["targets"] = new JsonArray(draft.Targets.Order(StringComparer.Ordinal).Select(value => JsonValue.Create(value)).ToArray()),
        };
        if (!full)
        {
            begin["baseSequence"] = previous!.Sequence;
            begin["baseGeneration"] = previous.Generation;
        }

        var frames = new JsonArray(hello, begin);
        var factsUnchanged = previous is not null
            && !full
            && previous.CompilerVersion == compilerVersion;
        if (full)
        {
            foreach (var entry in manifest)
            {
                frames.Add(Upsert(entry, shards[entry.Key].Payload));
            }
        }
        else
        {
            var oldManifest = previous!.Manifest.ToDictionary(entry => entry.Key, StringComparer.Ordinal);
            foreach (var entry in manifest)
            {
                if (!oldManifest.TryGetValue(entry.Key, out var old) || old.Digest != entry.Digest)
                {
                    frames.Add(Upsert(entry, shards[entry.Key].Payload));
                    factsUnchanged = factsUnchanged
                        && previousShards!.TryGetValue(entry.Key, out var prior)
                        && prior.FactFingerprint == shards[entry.Key].FactFingerprint;
                }
            }
            foreach (var old in previous.Manifest)
            {
                if (!shards.ContainsKey(old.Key))
                {
                    factsUnchanged = false;
                    frames.Add(new JsonObject
                    {
                        ["type"] = "deleteShard",
                        ["key"] = old.Key,
                    });
                }
            }
        }

        var factDigest = factsUnchanged
            ? PreviousFactDigest(previous!)
            : FactDigest(hello, universe, manifest, shards);
        frames.Add(new JsonObject
        {
            ["type"] = "commit",
            ["sequence"] = sequence,
            ["generation"] = generation,
            ["shards"] = new JsonArray(manifest.Select(entry => entry.Json()).ToArray()),
            ["factDigest"] = factDigest,
        });
        return new JsonObject
        {
            ["protocolVersion"] = 1,
            ["mode"] = previous is null ? "initial" : full ? "reload" : "incremental",
            ["sequence"] = sequence,
            ["generation"] = generation,
            ["universe"] = universe,
            ["frames"] = frames,
        };
    }

    public static GraphGeneration GenerationFrom(
        JsonObject envelope,
        GraphDraft draft,
        string compilerVersion)
    {
        var manifest = draft.Shards
            .OrderBy(shard => shard.Key, StringComparer.Ordinal)
            .Select(shard => new ManifestEntry(shard.Key, shard.PayloadDigest))
            .ToArray();
        return new GraphGeneration(
            envelope["sequence"]!.GetValue<int>(),
            envelope["generation"]!.GetValue<string>(),
            envelope["universe"]!.GetValue<string>(),
            manifest,
            draft,
            compilerVersion,
            envelope.DeepClone().AsObject());
    }

    public static string HashBytes(ReadOnlySpan<byte> bytes) =>
        Convert.ToHexStringLower(SHA256.HashData(bytes));

    public static string HashText(string text) => HashBytes(Encoding.UTF8.GetBytes(text));

    public static string Hash(JsonNode node) => HashText(CanonicalText(node));

    public static string ShardFactHash(JsonObject shard)
    {
        var builder = new StringBuilder();
        builder.Append('{');
        var first = true;
        foreach (var name in new[] { "coverage", "diagnostics", "edges", "nodes", "unresolved" })
        {
            if (!first)
            {
                builder.Append(',');
            }
            first = false;
            WriteQuoted(builder, name);
            builder.Append(':');
            WriteCanonical(builder, shard[name]);
        }
        builder.Append('}');
        return HashText(builder.ToString());
    }

    private static string PreviousFactDigest(GraphGeneration generation) => generation.Envelope["frames"]!
        .AsArray()
        .Single(frame => frame!["type"]!.GetValue<string>() == "commit")!["factDigest"]!
        .GetValue<string>();

    private static JsonObject Hello(string compilerVersion) => new()
    {
        ["type"] = "hello",
        ["protocolVersion"] = 1,
        ["schemaVersion"] = 1,
        ["producerSchemaVersion"] = 1,
        ["provider"] = Provider,
        ["producer"] = Producer,
        ["producerVersion"] = Version,
        ["compilerVersion"] = compilerVersion,
        ["languages"] = new JsonArray("csharp"),
        ["authority"] = "compiler",
        ["supportedFacts"] = new JsonArray(Facts.Select(value => JsonValue.Create(value)).ToArray()),
        ["capabilities"] = new JsonArray(Capabilities.Select(value => JsonValue.Create(value)).ToArray()),
    };

    private static JsonObject Upsert(ManifestEntry entry, JsonObject shard) => new()
    {
        ["type"] = "upsertShard",
        ["digest"] = entry.Digest,
        ["shard"] = shard.DeepClone(),
    };

    private static IReadOnlyList<JsonObject> Sources(IEnumerable<ShardDraft> shards)
    {
        var sources = new SortedDictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var shard in shards)
        {
            foreach (var node in shard.Payload["sources"]!.AsArray())
            {
                var source = node!.AsObject();
                var file = source["file"]!.GetValue<string>();
                if (sources.TryGetValue(file, out var prior) && Hash(prior) != Hash(source))
                {
                    throw new InvalidOperationException($"Shards disagree about source {file}");
                }
                sources[file] = source;
            }
        }
        return sources.Values.ToArray();
    }

    private static string ManifestDigest(IReadOnlyList<JsonObject> sources)
    {
        var array = new JsonArray(sources
            .OrderBy(source => source["file"]!.GetValue<string>(), StringComparer.Ordinal)
            .Select(source => source.DeepClone())
            .ToArray());
        return Hash(array);
    }

    private static string FactDigest(
        JsonObject hello,
        string universe,
        IReadOnlyList<ManifestEntry> manifest,
        IReadOnlyDictionary<string, ShardDraft> shards)
    {
        var nodes = new JsonArray();
        var edges = new JsonArray();
        var diagnostics = new JsonArray();
        var coverage = new JsonArray();
        var unresolved = new JsonArray();
        var seenNodes = new HashSet<string>(StringComparer.Ordinal);
        var seenEdges = new HashSet<string>(StringComparer.Ordinal);
        var seenDiagnostics = new HashSet<string>(StringComparer.Ordinal);
        var seenUnresolved = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in manifest)
        {
            var shard = shards[entry.Key].Payload;
            foreach (var node in shard["nodes"]!.AsArray())
            {
                if (seenNodes.Add(node!["id"]!.GetValue<string>()))
                {
                    nodes.Add(node.DeepClone());
                }
            }
            foreach (var edge in shard["edges"]!.AsArray())
            {
                var key = string.Join('\0',
                    edge!["from"]!.GetValue<string>(),
                    edge["to"]!.GetValue<string>(),
                    edge["kind"]!.GetValue<string>());
                if (seenEdges.Add(key))
                {
                    edges.Add(edge.DeepClone());
                }
            }
            foreach (var diagnostic in shard["diagnostics"]!.AsArray())
            {
                var key = string.Join('\0',
                    diagnostic!["file"]!.GetValue<string>(),
                    diagnostic["line"]!.ToJsonString(),
                    diagnostic["column"]?.ToJsonString() ?? "",
                    diagnostic["code"]!.ToJsonString(),
                    diagnostic["severity"]?.GetValue<string>() ?? "",
                    diagnostic["message"]!.GetValue<string>());
                if (seenDiagnostics.Add(key))
                {
                    diagnostics.Add(diagnostic.DeepClone());
                }
            }
            foreach (var row in shard["coverage"]!.AsArray())
            {
                coverage.Add(row!.DeepClone());
            }
            foreach (var site in shard["unresolved"]!.AsArray())
            {
                var key = CanonicalText(site!);
                if (seenUnresolved.Add(key))
                {
                    unresolved.Add(site!.DeepClone());
                }
            }
        }
        var provenance = new JsonObject
        {
            ["provider"] = hello["provider"]!.DeepClone(),
            ["authority"] = hello["authority"]!.DeepClone(),
            ["facts"] = hello["supportedFacts"]!.DeepClone(),
            ["schemaVersion"] = hello["producerSchemaVersion"]!.DeepClone(),
            ["tool"] = hello["producer"]!.DeepClone(),
            ["toolVersion"] = hello["producerVersion"]!.DeepClone(),
            ["compilerVersion"] = hello["compilerVersion"]!.DeepClone(),
            ["protocolVersion"] = hello["protocolVersion"]!.DeepClone(),
            ["universe"] = universe,
            ["capabilities"] = hello["capabilities"]!.DeepClone(),
        };
        return Hash(new JsonObject
        {
            ["languages"] = hello["languages"]!.DeepClone(),
            ["nodes"] = nodes,
            ["edges"] = edges,
            ["diagnostics"] = diagnostics,
            ["coverage"] = coverage,
            ["unresolved"] = unresolved,
            ["provenance"] = provenance,
        });
    }

    private static string CanonicalText(JsonNode? node)
    {
        var builder = new StringBuilder();
        WriteCanonical(builder, node);
        return builder.ToString();
    }

    private static void WriteCanonical(StringBuilder builder, JsonNode? node)
    {
        if (node is null)
        {
            builder.Append("null");
            return;
        }
        if (node is JsonObject valueObject)
        {
            builder.Append('{');
            var first = true;
            foreach (var property in valueObject.OrderBy(property => property.Key, StringComparer.Ordinal))
            {
                if (!first)
                {
                    builder.Append(',');
                }
                first = false;
                WriteQuoted(builder, property.Key);
                builder.Append(':');
                WriteCanonical(builder, property.Value);
            }
            builder.Append('}');
            return;
        }
        if (node is JsonArray array)
        {
            builder.Append('[');
            var first = true;
            foreach (var item in array)
            {
                if (!first)
                {
                    builder.Append(',');
                }
                first = false;
                WriteCanonical(builder, item);
            }
            builder.Append(']');
            return;
        }
        if (node is JsonValue value && value.TryGetValue<string>(out var text))
        {
            WriteQuoted(builder, text);
            return;
        }
        if (node is JsonValue boolean && boolean.TryGetValue<bool>(out var flag))
        {
            builder.Append(flag ? "true" : "false");
            return;
        }
        if (node is JsonValue number && TryNumber(number, out var numeric))
        {
            WriteJavaScriptNumber(builder, numeric);
            return;
        }
        builder.Append(node.ToJsonString());
    }

    private static bool TryNumber(JsonValue value, out double number)
    {
        if (value.TryGetValue<int>(out var integer))
        {
            number = integer;
            return true;
        }
        if (value.TryGetValue<long>(out var longInteger))
        {
            number = longInteger;
            return true;
        }
        if (value.TryGetValue<uint>(out var unsignedInteger))
        {
            number = unsignedInteger;
            return true;
        }
        if (value.TryGetValue<ulong>(out var unsignedLongInteger))
        {
            number = unsignedLongInteger;
            return true;
        }
        if (value.TryGetValue<float>(out var single))
        {
            number = single;
            return true;
        }
        if (value.TryGetValue<double>(out var floating))
        {
            number = floating;
            return true;
        }
        if (value.TryGetValue<decimal>(out var decimalNumber))
        {
            number = (double)decimalNumber;
            return true;
        }
        number = 0;
        return false;
    }

    private static void WriteJavaScriptNumber(StringBuilder builder, double number)
    {
        if (number == 0)
        {
            builder.Append('0');
            return;
        }
        if (!double.IsFinite(number))
        {
            builder.Append("null");
            return;
        }

        if (number < 0)
        {
            builder.Append('-');
            number = -number;
        }
        var roundTrip = number.ToString("R", CultureInfo.InvariantCulture);
        var exponentIndex = roundTrip.IndexOfAny(['E', 'e']);
        var mantissa = exponentIndex == -1
            ? roundTrip
            : roundTrip[..exponentIndex];
        var exponent = exponentIndex == -1
            ? 0
            : int.Parse(roundTrip[(exponentIndex + 1)..], CultureInfo.InvariantCulture);
        var decimalIndex = mantissa.IndexOf('.');
        var decimalPosition = (decimalIndex == -1 ? mantissa.Length : decimalIndex) + exponent;
        var digits = mantissa.Replace(".", "", StringComparison.Ordinal);
        var leading = 0;
        while (leading < digits.Length && digits[leading] == '0')
        {
            leading++;
        }
        decimalPosition -= leading;
        digits = digits[leading..].TrimEnd('0');

        if (number >= 1e-6 && number < 1e21)
        {
            if (decimalPosition <= 0)
            {
                builder.Append("0.");
                builder.Append('0', -decimalPosition);
                builder.Append(digits);
            }
            else if (decimalPosition >= digits.Length)
            {
                builder.Append(digits);
                builder.Append('0', decimalPosition - digits.Length);
            }
            else
            {
                builder.Append(digits.AsSpan(0, decimalPosition));
                builder.Append('.');
                builder.Append(digits.AsSpan(decimalPosition));
            }
            return;
        }

        builder.Append(digits[0]);
        if (digits.Length > 1)
        {
            builder.Append('.');
            builder.Append(digits.AsSpan(1));
        }
        builder.Append('e');
        var scientificExponent = decimalPosition - 1;
        if (scientificExponent >= 0)
        {
            builder.Append('+');
        }
        builder.Append(scientificExponent.ToString(CultureInfo.InvariantCulture));
    }

    private static void WriteQuoted(StringBuilder builder, string value)
    {
        builder.Append('"');
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            switch (character)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                default:
                    if (character < ' ' || char.IsSurrogate(character)
                        && (index + 1 == value.Length
                            || !char.IsSurrogatePair(character, value[index + 1])))
                    {
                        builder.Append("\\u");
                        builder.Append(((int)character).ToString("x4",
                            System.Globalization.CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(character);
                        if (char.IsHighSurrogate(character))
                        {
                            builder.Append(value[++index]);
                        }
                    }
                    break;
            }
        }
        builder.Append('"');
    }
}

internal sealed record ManifestEntry(string Key, string Digest)
{
    public JsonObject Json() => new()
    {
        ["key"] = Key,
        ["digest"] = Digest,
    };
}

internal sealed record ShardDraft(
    string Key,
    JsonObject Payload,
    string InterfaceFingerprint,
    string FactFingerprint,
    string PayloadDigest);

internal sealed record GraphDraft(
    IReadOnlyList<string> Targets,
    JsonObject Universe,
    string UniverseFingerprint,
    IReadOnlyList<ShardDraft> Shards,
    bool HasErrors,
    string ErrorSummary,
    object? ProviderState = null);

internal sealed record GraphGeneration(
    int Sequence,
    string Generation,
    string Universe,
    IReadOnlyList<ManifestEntry> Manifest,
    GraphDraft Draft,
    string CompilerVersion,
    JsonObject Envelope);
