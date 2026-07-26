import { GraphLanguage, GraphProviderAuthority } from "../../typings";
import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { sidecarProvider } from "./sidecarProvider";

const swiftGraphProvider = externalSidecar({
  language: "swift",
  authority: "analyzer",
  buildFiles: ["Package.swift", "Package.resolved", "project.pbxproj"],
});

const zigGraphProvider = externalSidecar({
  language: "zig",
  authority: "analyzer",
  buildFiles: ["build.zig", "build.zig.zon"],
});

const luaGraphProvider = externalSidecar({
  language: "lua",
  authority: "analyzer",
  buildFiles: [".luarc.json", ".luarc.jsonc"],
  buildExtensions: [".rockspec"],
});

// Dart and php have both left this list. Each named a `samchon-graph-<lang>`
// program that was never written, while a real indexer for the language already
// existed — `scip_dart` on pub.dev, `scip-php` on Packagist. Neither entry was
// unfinished work; both were the wrong architecture, and each now lives in
// `standardScipProviders` against its actual tool. Two entries claiming one
// language is a registry defect that refuses the build, so a sidecar has to
// leave when its SCIP provider arrives.
//
// What remains is the honest residue: swift, zig and lua have no upstream SCIP
// indexer at all, so for these three the name still describes work rather than
// a mistake. Even here two of the three have a channel that is not a new
// analyzer — swift through IndexStoreDB, lua through a script injected into
// lua-language-server's own `--doc` export, which is handed the `vm` module and
// can therefore resolve references the plain export omits. Only zig has nothing.

/** External analyzer sidecars in deterministic registry order. */
export const standardSidecarProviders = [
  swiftGraphProvider,
  zigGraphProvider,
  luaGraphProvider,
] as const;

interface IExternalSidecar {
  language: GraphLanguage;
  authority: GraphProviderAuthority;
  buildFiles: readonly string[];
  buildExtensions?: readonly string[];
}

function externalSidecar(props: IExternalSidecar) {
  const name = `samchon-graph-${props.language}`;
  return sidecarProvider({
    name,
    languages: [props.language],
    authority: props.authority,
    facts: [
      "contains",
      "exports",
      "imports",
      "calls",
      "accesses",
      "instantiates",
      "type_ref",
      "implements",
      "overrides",
      "dispatches",
      "decorates",
      "tests",
      "references",
    ],
    buildInputs: (root) =>
      providerInputFiles(root, [], props.buildFiles, props.buildExtensions),
    resolve: (root, env) =>
      resolveProviderCommand(root, env, {
        command: name,
        override: `SAMCHON_GRAPH_${props.language.toUpperCase()}`,
      }),
    indexArgs: (artifact) => [`--output=${artifact}`, "--project=."],
    inputs: (root, languages) =>
      providerInputFiles(
        root,
        languages,
        props.buildFiles,
        props.buildExtensions,
      ),
  });
}
