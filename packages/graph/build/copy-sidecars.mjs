import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy the sidecar sources this package ships into the package itself.
 *
 * The Go, C#, Scala, and Swift sidecars are source a user compiles into their
 * native producer; the Gradle Java source reads the opted-in Tooling API model; and
 * the Lua exporter is a script the provider hands to lua-language-server. All
 * must exist in an installed package rather than only in this repository.
 *
 * Named per file rather than copied wholesale. A directory copy would ship
 * whatever happened to be sitting there — a probe, a scratch file, a build
 * artifact — and the published package should carry exactly what was intended.
 */
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageRoot, "..", "..");

const SIDECARS = {
  csharp: [
    "GraphExtractor.cs",
    "GraphProtocol.cs",
    "Program.cs",
    "Samchon.Graph.CSharp.csproj",
    "WorkspaceGraphService.cs",
    "packages.lock.json",
  ],
  gradle: ["RepositoryContext.java"],
  go: [
    "analyze.go",
    "go.mod",
    "go.sum",
    "main.go",
    "model.go",
    "modules.go",
    "process_unix.go",
    "process_windows.go",
    "scip.go",
  ],
  // `probe.lua` is deliberately absent: it is the research instrument that
  // established what the engine exposes, not something a user runs.
  lua: ["export.lua"],
  scala: [
    "README.md",
    "pom.xml",
    "common/pom.xml",
    "common/src/main/java/org/samchon/graph/scala/model/Evidence.java",
    "common/src/main/java/org/samchon/graph/scala/model/GraphEdge.java",
    "common/src/main/java/org/samchon/graph/scala/model/GraphNode.java",
    "common/src/main/java/org/samchon/graph/scala/model/TypedShard.java",
    "common/src/main/java/org/samchon/graph/scala/model/UnresolvedSite.java",
    "common/src/main/java/org/samchon/graph/scala/plugin/GraphShardWriter.java",
    "common/src/main/java/org/samchon/graph/scala/plugin/PluginOptions.java",
    "scala2-plugin/pom.xml",
    "scala2-plugin/src/main/resources/scalac-plugin.xml",
    "scala2-plugin/src/main/scala/org/samchon/graph/scala2/Scala2GraphPlugin.scala",
    "scala3-plugin/pom.xml",
    "scala3-plugin/src/main/resources/plugin.properties",
    "scala3-plugin/src/main/scala/org/samchon/graph/scala3/Scala3GraphPlugin.scala",
    "server/pom.xml",
    "server/src/main/java/org/samchon/graph/scala/server/model/DiagnosticFact.java",
    "server/src/main/java/org/samchon/graph/scala/server/model/SemanticShard.java",
    "server/src/main/java/org/samchon/graph/scala/server/model/SnapshotArtifact.java",
    "server/src/main/java/org/samchon/graph/scala/server/model/TargetSnapshot.java",
    "server/src/main/scala/org/samchon/graph/scala/server/AtomicJson.scala",
    "server/src/main/scala/org/samchon/graph/scala/server/BspSession.scala",
    "server/src/main/scala/org/samchon/graph/scala/server/Main.scala",
    "server/src/main/scala/org/samchon/graph/scala/server/SemanticDbReader.scala",
    "server/src/main/scala/org/samchon/graph/scala/server/SnapshotProducer.scala",
  ],
  swift: [
    "README.md",
    "Package.resolved",
    "Package.swift",
    "Sources/SamchonSwiftGraph/GraphModel.swift",
    "Sources/SamchonSwiftGraph/main.swift",
    "Sources/SamchonSwiftGraph/SHA256.swift",
    "Sources/SamchonSwiftGraph/SourceEnrichment.swift",
    "Sources/SamchonSwiftGraph/SwiftGraphProducer.swift",
  ],
};

for (const [sidecar, files] of Object.entries(SIDECARS)) {
  const source = path.join(repositoryRoot, "sidecars", sidecar);
  const target = path.join(packageRoot, "sidecars", sidecar);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) {
    const from = path.join(source, file);
    if (!fs.existsSync(from)) {
      throw new Error(`sidecar source is missing: ${from}`);
    }
    const to = path.join(target, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}
