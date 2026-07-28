import { createHash } from "node:crypto";
import fs from "node:fs";
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
  configuration: (root, env) => [...luaConfiguration(root, env).rows],
  configurationDerivation: (root, env) =>
    luaConfiguration(root, env),

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

  resolve: (root, env) => {
    if (exporterScript(env) === undefined) return undefined;
    return resolveProviderCommand(root, env, {
      command: "lua-language-server",
      override: "SAMCHON_GRAPH_LUA",
    });
  },

  open: (props) => {
    if (exporterScript(process.env) === undefined) {
      throw new Error(
        "samchon-graph-lua: the exporter script is missing from this installation",
      );
    }
    return new LuaGraphSession({
      root: props.root,
      languages: props.languages,
      provider: "samchon-graph-lua",
      command: props.command,
      // `--doc` names the project, `--doc_out_path` the directory the exporter
      // writes into — which is the artifact's own directory, so the file lands
      // exactly where the session looks for it.
      indexArgs: (artifact) => {
        const script = exporterScript(process.env);
        if (script === undefined) {
          throw new Error(
            "samchon-graph-lua: the exporter script is missing from this installation",
          );
        }
        const config = writeExporterConfig(
          props.root,
          script,
          artifact,
        );
        return [
          `--doc=${path.resolve(props.root)}`,
          `--doc_out_path=${path.dirname(artifact)}`,
          `--configpath=${config}`,
        ];
      },
      inputs: () =>
        providerInputFiles(
          props.root,
          props.languages,
          BUILD_FILES,
          BUILD_EXTENSIONS,
        ),
      configuration: () =>
        luaConfiguration(props.root, process.env, props.command),
    });
  },
};

function luaConfiguration(
  root: string,
  env: NodeJS.ProcessEnv,
  resolved?: IGraphProvider.ICommand,
): toolchainVersion.IDerivation {
  return toolchainVersion.derive([
    toolchainVersion.observe({
      root,
      env,
      command: "lua-language-server",
      override: "SAMCHON_GRAPH_LUA",
      args: ["--version"],
      ...(resolved === undefined ? {} : { resolved }),
    }),
    luaExporterConfiguration(env),
  ]);
}

function luaExporterConfiguration(
  env: NodeJS.ProcessEnv,
): toolchainVersion.IObservation {
  const script = exporterScript(env);
  if (script === undefined) {
    return toolchainVersion.conclusive(
      "lua-exporter=unavailable",
      "lua-exporter",
    );
  }
  const identity = `lua-exporter:${path.resolve(script)}`;
  try {
    return toolchainVersion.conclusive(
      `lua-exporter=sha256:${createHash("sha256")
        .update(fs.readFileSync(script))
        .digest("hex")}`,
      identity,
    );
  } catch {
    return toolchainVersion.conclusive("lua-exporter=unreadable", identity);
  }
}

/**
 * The exporter to inject, or nothing when the named one is not there.
 *
 * A provider that cannot find its own producer must decline rather than resolve
 * a server it would then drive with the stock documentation exporter — which
 * emits no references at all and would publish an edgeless graph as though the
 * project had none.
 *
 * `SAMCHON_GRAPH_LUA_EXPORTER` overrides the shipped script, matching the
 * override every other provider here offers for its producer. It also makes the
 * declined path reachable: without it, "the package shipped without its own
 * exporter" is a state no test can produce without deleting a file mid-run, and
 * five attempts at excusing that line from coverage all excused a different one.
 * A seam that makes the behaviour testable is better than a hint that makes the
 * tool look away.
 */
function exporterScript(env: NodeJS.ProcessEnv): string | undefined {
  const named = env.SAMCHON_GRAPH_LUA_EXPORTER;
  const script =
    named !== undefined && named !== ""
      ? path.resolve(named)
      : path.resolve(
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
 * Write one generated config inside this generation's private output.
 *
 * `Lua.docScriptPath` is concatenated onto the indexed root as a plain string,
 * so the value walks from that root to the installed exporter. The config
 * itself belongs beside the generation artifact: `BatchGraphSession` gives
 * every refresh a unique temporary directory and removes it afterwards. A
 * root-keyed file in the shared OS temporary directory let two concurrent
 * sessions for the same project overwrite each other's exporter selection and
 * left the path behind after both sessions closed.
 */
function writeExporterConfig(
  root: string,
  script: string,
  artifact: string,
): string {
  const relative = path
    .relative(path.resolve(root), script)
    .split(path.sep)
    .join("/");
  const config = path.join(
    path.dirname(artifact),
    "samchon-graph-lua-config.json",
  );
  fs.writeFileSync(
    config,
    `${JSON.stringify({ "Lua.docScriptPath": `/${relative}` }, null, 2)}\n`,
  );
  return config;
}
