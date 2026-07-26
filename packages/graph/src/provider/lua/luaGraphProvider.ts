import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { toolchainVersion } from "../toolchainVersion";
import { IGraphProvider } from "../IGraphProvider";
import { LuaGraphSession } from "./LuaGraphSession";

const BUILD_FILES = [".luarc.json", ".luarc.jsonc"] as const;
const BUILD_EXTENSIONS = [".rockspec"] as const;

/**
 * Lua, indexed by driving lua-language-server's own analysis engine.
 *
 * Lua has no upstream SCIP indexer, and this is what stands in for one. The
 * server takes a `--doc` export and lets a build script replace the exporter,
 * handing that script the `vm` engine — so the graph is produced by the same
 * analysis that answers an editor, in one batch run rather than a request per
 * symbol.
 *
 * The entry that used to sit here named `samchon-graph-lua` as a program and no
 * such program was ever written, so every Lua build fell through to the generic
 * language-server lane.
 */
export const luaGraphProvider: IGraphProvider = {
  name: "samchon-graph-lua",
  languages: ["lua"],
  authority: "analyzer",
  facts: [...LuaGraphSession.FACTS],

  buildInputs: (root) =>
    providerInputFiles(root, [], BUILD_FILES, BUILD_EXTENSIONS),

  /**
   * The options this producer cannot honour, said out loud.
   *
   * The exporter runs once over the whole workspace and has no bounded mode: it
   * cannot index a subset, cannot stop after N symbols, and cannot be pointed at
   * a caller-supplied server, because the analysis it walks belongs to the
   * server it is injected into. Returning the reason makes the language fall
   * through with that sentence recorded, rather than a capped run passing for
   * the whole-project index it silently replaced.
   */
  refuse: (options) => {
    const refused: string[] = [];
    if (options.server !== undefined) refused.push("server");
    if (options.maxFiles !== undefined) refused.push("maxFiles");
    if (options.lspReferenceLimit !== undefined)
      refused.push("lspReferenceLimit");
    if (refused.length === 0) return undefined;
    return (
      `lua: the samchon-graph-lua analyzer provider is disabled by ${refused.join(", ")}; ` +
      "it exports the whole workspace in one pass and has no bounded mode, so " +
      "lua falls through to the generic language-server lane. " +
      `Drop ${refused.length === 1 ? "that option" : "those options"} for a strict index.`
    );
  },

  resolve: (root, env) =>
    /* c8 ignore next -- the exporter ships with this package, so the absent
     * arm is a broken installation rather than a state a suite can reach
     * without deleting a file out from under the run. */
    exporterScript() === undefined
      ? undefined
      : resolveProviderCommand(root, env, {
          command: "lua-language-server",
          override: "SAMCHON_GRAPH_LUA",
        }),

  /**
   * Write the config that points the server at our exporter.
   *
   * `Lua.docScriptPath` is concatenated onto the indexed root as a plain
   * string, so a path built from the root's own relative distance walks back
   * out to the installed package instead of being written into someone's
   * project. Nothing lands in the tree being analysed.
   *
   * Throwing declines the candidate rather than failing the build, which is
   * what the hook is for: a Lua project whose config cannot be written is a
   * fallback condition.
   */
  prepare: (root) => {
    const script = exporterScript();
    /* c8 ignore start -- same broken-installation arm as `resolve`; reaching it
     * means the package shipped without its own producer. */
    if (script === undefined) {
      throw new Error(
        "samchon-graph-lua: the exporter script is missing from this installation",
      );
    }
    /* c8 ignore stop */
    const relative = path
      .relative(path.resolve(root), script)
      .split(path.sep)
      .join("/");
    fs.writeFileSync(
      configPath(root),
      `${JSON.stringify({ "Lua.docScriptPath": `/${relative}` }, null, 2)}\n`,
    );
  },

  open: (props) =>
    new LuaGraphSession({
      root: props.root,
      languages: props.languages,
      provider: "samchon-graph-lua",
      command: props.command,
      // `--doc` names the project, `--doc_out_path` the directory the exporter
      // writes into — which is the artifact's own directory, so the file lands
      // exactly where the session looks for it.
      indexArgs: (artifact) => [
        `--doc=${path.resolve(props.root)}`,
        `--doc_out_path=${path.dirname(artifact)}`,
        `--configpath=${configPath(props.root)}`,
      ],
      inputs: () =>
        providerInputFiles(
          props.root,
          props.languages,
          BUILD_FILES,
          BUILD_EXTENSIONS,
        ),
      configuration: () => [
        toolchainVersion({
          root: props.root,
          env: process.env,
          command: "lua-language-server",
          override: "SAMCHON_GRAPH_LUA",
          args: ["--version"],
        }),
      ],
    }),
};

/**
 * The exporter shipped beside this module, or nothing when it is absent.
 *
 * Absent means an installation that did not carry `sidecars/lua`, and a
 * provider that cannot find its own producer must decline rather than resolve a
 * server it would then drive with the stock documentation exporter — which
 * emits no references at all and would publish a graph with no edges as though
 * the project had none.
 */
function exporterScript(): string | undefined {
  const script = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "sidecars",
    "lua",
    "export.lua",
  );
  return fs.existsSync(script) ? script : undefined;
}

/**
 * Where this project's generated config lives.
 *
 * Outside the project, because writing into the tree being indexed is what the
 * relative-escape above exists to avoid, and keyed by the root so two projects
 * indexed in one process do not overwrite each other's script path.
 */
function configPath(root: string): string {
  const key = createHash("sha256")
    .update(path.resolve(root))
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), `samchon-graph-lua-${key}.json`);
}
