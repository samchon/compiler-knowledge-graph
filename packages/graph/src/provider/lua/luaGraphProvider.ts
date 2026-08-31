import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { toolchainVersion } from "../toolchainVersion";
import { IGraphProvider } from "../IGraphProvider";
import { exporterTemporaryParent } from "./exporterTemporaryParent";
import { LuaGraphSession } from "./LuaGraphSession";

const BUILD_FILES = [".luarc.json", ".luarc.jsonc"] as const;
const BUILD_EXTENSIONS = [".rockspec"] as const;
const LUA_GRAPH_TOOLS = Object.freeze({
  server: Object.freeze({
    command: "lua-language-server",
    override: "SAMCHON_GRAPH_LUA",
  }),
  exporterOverride: "SAMCHON_GRAPH_LUA_EXPORTER",
});
const LUA_GRAPH_RESOLUTION = Object.freeze({
  commands: Object.freeze([LUA_GRAPH_TOOLS.server.command]),
  environmentOverrides: Object.freeze([
    LUA_GRAPH_TOOLS.server.override,
    LUA_GRAPH_TOOLS.exporterOverride,
  ]),
}) satisfies IGraphProvider.IResolution;

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
  resolution: LUA_GRAPH_RESOLUTION,

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
    if (inspectExporter(env).status !== "available") return undefined;
    return resolveProviderCommand(root, env, {
      ...LUA_GRAPH_TOOLS.server,
    });
  },

  open: (props) => {
    const initial = inspectExporter(process.env);
    if (initial.status !== "available") {
      throw new Error(
        "samchon-graph-lua: the exporter script is missing from this installation",
      );
    }
    let exporter: IAvailableExporter | undefined = initial;
    return new LuaGraphSession({
      root: props.root,
      languages: props.languages,
      provider: "samchon-graph-lua",
      command: props.command,
      // LuaLS concatenates `Lua.docScriptPath` onto the project root instead of
      // accepting an absolute path. Keep the generation outside the indexed
      // tree but in the same Windows path namespace, falling back to a sibling
      // only when `%TEMP%` is on another volume.
      temporaryParent: exporterTemporaryParent(props.root),
      // `--doc` names the project, `--doc_out_path` the directory the exporter
      // writes into — which is the artifact's own directory, so the file lands
      // exactly where the session looks for it.
      indexArgs: (artifact) => {
        if (exporter === undefined) {
          throw new Error(
            "samchon-graph-lua: the exporter script is missing or unreadable",
          );
        }
        const config = writeExporterConfig(
          props.root,
          exporter,
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
      configuration: () => {
        const inspected = inspectExporter(process.env);
        exporter =
          inspected.status === "available" ? inspected : undefined;
        return luaConfiguration(
          props.root,
          process.env,
          props.command,
          inspected,
        );
      },
    });
  },
};

function luaConfiguration(
  root: string,
  env: NodeJS.ProcessEnv,
  resolved?: IGraphProvider.ICommand,
  exporter: IExporterInspection = inspectExporter(env),
): toolchainVersion.IDerivation {
  return toolchainVersion.derive([
    toolchainVersion.observe({
      root,
      env,
      ...LUA_GRAPH_TOOLS.server,
      args: ["--version"],
      ...(resolved === undefined ? {} : { resolved }),
    }),
    luaExporterConfiguration(exporter),
  ]);
}

function luaExporterConfiguration(
  exporter: IExporterInspection,
): toolchainVersion.IObservation {
  if (exporter.status === "unavailable") {
    return toolchainVersion.conclusive(
      "lua-exporter=unavailable",
      "lua-exporter",
    );
  }
  const identity = `lua-exporter:${exporter.path}`;
  if (exporter.status === "unreadable") {
    return toolchainVersion.conclusive("lua-exporter=unreadable", identity);
  }
  return toolchainVersion.conclusive(
    `lua-exporter=sha256:${createHash("sha256")
      .update(exporter.source)
      .digest("hex")}`,
    identity,
  );
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
function inspectExporter(env: NodeJS.ProcessEnv): IExporterInspection {
  const named = env[LUA_GRAPH_TOOLS.exporterOverride];
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
  if (!fs.existsSync(script)) return { status: "unavailable" };
  try {
    return {
      status: "available",
      path: script,
      source: fs.readFileSync(script),
    };
  } catch {
    return { status: "unreadable", path: script };
  }
}

interface IAvailableExporter {
  status: "available";
  path: string;
  source: Buffer;
}

type IExporterInspection =
  | IAvailableExporter
  | { status: "unavailable" }
  | { status: "unreadable"; path: string };

/**
 * Write one generated config inside this generation's private output.
 *
 * `Lua.docScriptPath` is concatenated onto the indexed root as a plain string,
 * so the value walks from that root to a private copy beside the generation
 * artifact. That copy is the exact buffer whose digest moved the build
 * universe: changing the installed file while the server starts cannot make
 * the artifact come from bytes different from the recorded digest.
 * `BatchGraphSession` gives every refresh a unique temporary directory and
 * removes it afterwards. A root-keyed file in the shared OS temporary
 * directory let two concurrent sessions for the same project overwrite each
 * other's exporter selection and left the path behind after both closed.
 */
function writeExporterConfig(
  root: string,
  exporter: IAvailableExporter,
  artifact: string,
): string {
  const script = path.join(
    path.dirname(artifact),
    "samchon-graph-lua-export.lua",
  );
  fs.writeFileSync(script, exporter.source);
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
