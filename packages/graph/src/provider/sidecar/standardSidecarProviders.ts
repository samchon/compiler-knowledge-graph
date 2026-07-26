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


// Three languages have left this list, each for its own reason, and only swift
// and zig remain.
//
// dart and php named a `samchon-graph-<lang>` program that was never written
// while a real indexer already existed — `scip_dart` on pub.dev, `scip-php` on
// Packagist — so those entries were not unfinished work but the wrong
// architecture, and both now live in `standardScipProviders`.
//
// lua had no upstream indexer at all, which made the name honest, and it left
// anyway: lua-language-server's `--doc` export accepts a replacement exporter
// and hands it the `vm` analysis engine, so the producer is a script inside the
// server rather than a program beside it. That does not fit this file's shape —
// the tool cannot emit a finished snapshot, because the server ships no hashing
// primitive — so it takes `scipProvider`'s run-then-adapt form instead.
//
// Two entries claiming one language is a registry defect that refuses the
// build, so each departure had to be a move rather than an addition.
//
// swift is next and lands in lua's shape for lua's reason: IndexStoreDB is a
// native on-disk index read through an official API, not a snapshot any
// analyzer hands over pre-formed. zig is the one language on the list with no
// channel of any kind, so its entry still describes work nobody has started.

/** External analyzer sidecars in deterministic registry order. */
export const standardSidecarProviders = [
  swiftGraphProvider,
  zigGraphProvider,
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
