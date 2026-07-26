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

const phpGraphProvider = externalSidecar({
  language: "php",
  authority: "analyzer",
  buildFiles: [
    "composer.json",
    "composer.lock",
    "phpstan.neon",
    "phpstan.neon.dist",
  ],
});

const luaGraphProvider = externalSidecar({
  language: "lua",
  authority: "analyzer",
  buildFiles: [".luarc.json", ".luarc.jsonc"],
  buildExtensions: [".rockspec"],
});

// Dart is gone from this list. It named `samchon-graph-dart`, a program that
// was never written, while `scip_dart` has existed on pub.dev the whole time —
// so the entry was not unfinished work but the wrong architecture, and it now
// lives in `standardScipProviders` against its real tool. Two entries claiming
// one language is a registry defect that refuses the build, so the sidecar had
// to leave when the SCIP provider arrived.
//
// The four that remain are the languages with no upstream indexer at all:
// swift, zig, php and lua. Of those, php is also misplaced — `scip-php` exists,
// but it takes no output path and treats the working directory as the project
// root, so moving it needs a shim rather than a registry line.

/** External analyzer sidecars in deterministic registry order. */
export const standardSidecarProviders = [
  swiftGraphProvider,
  zigGraphProvider,
  phpGraphProvider,
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
