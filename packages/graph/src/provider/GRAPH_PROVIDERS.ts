import { IGraphProvider } from "./IGraphProvider";
import { cppGraphProvider } from "./cpp/cppGraphProvider";
import { goGraphProvider } from "./go/goGraphProvider";
import { javaGraphProvider } from "./java/javaGraphProvider";
import { luaGraphProvider } from "./lua/luaGraphProvider";
import { rustGraphProvider } from "./rust/rustGraphProvider";
import { standardScipProviders } from "./scip/standardScipProviders";
import { standardSidecarProviders } from "./sidecar/standardSidecarProviders";
import { ttscGraphProvider } from "./ttscgraph/ttscGraphProvider";

/**
 * Every registered strict provider, in selection order.
 *
 * This list is the registry. Discovery reads it; nothing else decides which
 * providers exist, and adding one is an entry here rather than a branch in the
 * indexer. Order is the tie-break when two entries could serve the same
 * language, and it is deterministic so a build's provider choice does not
 * depend on iteration accident.
 *
 * Two entries claiming the same language for one project is a registry defect,
 * not a runtime condition: {@link selectGraphProviders} refuses the build
 * rather than silently letting the earlier entry win, because a graph whose
 * facts came from an arbitrary one of two compilers is not a graph anyone can
 * reason about.
 */
export const GRAPH_PROVIDERS: readonly IGraphProvider[] = [
  ttscGraphProvider,
  goGraphProvider,
  luaGraphProvider,
  rustGraphProvider,
  cppGraphProvider,
  javaGraphProvider,
  // Both entries are owned by a strict route as its fallback tier, so the
  // registry must not also list them as owners: one language cannot have two.
  ...standardScipProviders.filter(
    (provider) =>
      provider.name !== "scip-clang" && provider.name !== "scip-java",
  ),
  ...standardSidecarProviders,
];
