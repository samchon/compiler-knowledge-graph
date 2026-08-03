import { TestValidator } from "@nestia/e2e";
import { buildGraphDump, createResidentGraphSource } from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphFixtures } from "../internal/GraphFixtures";
import { GraphPaths } from "../internal/GraphPaths";

const fakeCmake = [process.execPath, GraphPaths.fakeCmake];

/** Proves generated compilation databases live for exactly their LSP session. */
export const test_ensure_compile_commands_wires_into_lsp_build = async () => {
  const root = GraphFixtures.createCmakeFixture();
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "include"));
  fs.writeFileSync(path.join(root, "src", "main.cc"), "int main() { return 0; }\n");
  fs.writeFileSync(
    path.join(root, "include", "shared.h"),
    "class SharedHeader {};\n",
  );

  const argsFile = path.join(root, "fake-lsp-args.json");
  const previousArgsFile = process.env.SAMCHON_GRAPH_FAKE_LSP_ARGS_FILE;
  process.env.SAMCHON_GRAPH_FAKE_LSP_ARGS_FILE = argsFile;
  try {
    const dump = await buildGraphDump({
      cwd: root,
      mode: "lsp",
      languages: ["cpp"],
      server: process.execPath,
      serverArgs: [GraphPaths.fakeLspServer],
      cmakeCommand: fakeCmake,
    });
    TestValidator.equals("cpp LSP build still succeeds", dump.indexer, "lsp");
    TestValidator.predicate(
      "generic C++ LSP discovery opens a shared .h before semantic ownership resolution",
      dump.nodes.some(
        (node) => node.language === "cpp" && node.file.endsWith("shared.h"),
      ),
    );
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    TestValidator.predicate(
      "the resolved compile_commands.json directory is passed to the server",
      args.some((arg) => arg.startsWith("--compile-commands-dir=")),
    );
    const oneShotDirectory = args
      .find((arg) => arg.startsWith("--compile-commands-dir="))!
      .slice("--compile-commands-dir=".length);
    TestValidator.equals(
      "a one-shot build removes its generated compilation database",
      fs.existsSync(oneShotDirectory),
      false,
    );

    const resident = createResidentGraphSource({
      cwd: root,
      mode: "lsp",
      languages: ["cpp"],
      server: process.execPath,
      serverArgs: [GraphPaths.fakeLspServer],
      cmakeCommand: fakeCmake,
    });
    await resident.load();
    const residentArgs = JSON.parse(
      fs.readFileSync(argsFile, "utf8"),
    ) as string[];
    const residentDirectory = residentArgs
      .find((arg) => arg.startsWith("--compile-commands-dir="))!
      .slice("--compile-commands-dir=".length);
    TestValidator.equals(
      "a resident clangd retains its generated compilation database",
      fs.existsSync(residentDirectory),
      true,
    );
    await resident.close();
    TestValidator.equals(
      "resident shutdown releases its generated compilation database",
      fs.existsSync(residentDirectory),
      false,
    );
  } finally {
    if (previousArgsFile === undefined) delete process.env.SAMCHON_GRAPH_FAKE_LSP_ARGS_FILE;
    else process.env.SAMCHON_GRAPH_FAKE_LSP_ARGS_FILE = previousArgsFile;
  }
};
