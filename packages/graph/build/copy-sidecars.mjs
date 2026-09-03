import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy the sidecar sources this package ships into the package itself.
 *
 * The Go and C# sidecars are source a user compiles into their native producer;
 * the Gradle Java source reads the opted-in Tooling API model; and the Lua
 * exporter is a script the provider hands to lua-language-server. All must
 * exist in an installed package rather than only in this repository.
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
    fs.copyFileSync(from, path.join(target, file));
  }
}
