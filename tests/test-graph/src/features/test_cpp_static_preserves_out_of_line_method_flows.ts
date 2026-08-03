import fs from "node:fs";
import path from "node:path";

import { TestValidator } from "@nestia/e2e";
import { buildGraphDump } from "@samchon/graph";

import { GraphPaths } from "../internal/GraphPaths";

export const test_cpp_static_preserves_out_of_line_method_flows = async () => {
  const root = GraphPaths.createTempDirectory("samchon-cpp-methods-");
  fs.writeFileSync(
    path.join(root, "engine.h"),
    [
      "namespace storage {",
      "struct Status {};",
      "class Engine {",
      " public:",
      "  Status Put(",
      "      int key,",
      "      int value);",
      "  Status Get(",
      "      int key,",
      "      void (*handle_result)(void*, int)) const;",
      "  Status Write(",
      "      int key,",
      "      int value);",
      "};",
      "}",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "engine.cpp"),
    [
      "namespace storage {",
      "Status AddRecord(int value) { return {}; }",
      "Status InsertInto(int value) { return {}; }",
      "namespace {",
      "class HiddenEngine {",
      " public:",
      "  HiddenEngine();",
      "  Status Run(int key);",
      "};",
      "Status HiddenHelper(int value) { return {}; }",
      "}",
      "HiddenEngine::HiddenEngine() {}",
      "Status HiddenEngine::Run(int key) { return HiddenHelper(key); }",
      "namespace public_helpers {",
      "Status VisibleHelper(int value) { return {}; }",
      "}",
      "Status Engine::Put(",
      "    int key,",
      "    int value) {",
      "  return Write(key, value);",
      "}",
      "Status Engine::Get(",
      "    int key,",
      "    void (*handle_result)(void*, int)) const {",
      "  return HiddenHelper(key);",
      "}",
      "Status Engine::Write(",
      "    int key,",
      "    int value) {",
      "  AddRecord(value);",
      "  return InsertInto(key);",
      "}",
      "}",
    ].join("\n"),
  );

  const graph = await buildGraphDump({
    cwd: root,
    mode: "static",
    languages: ["cpp"],
  });
  const sourceMethods = graph.nodes.filter(
    (node) => node.file.endsWith("engine.cpp") && node.kind === "method",
  );
  const method = (name: string) =>
    sourceMethods.find(
      (node) =>
        node.name === name && node.qualifiedName === `storage.Engine.${name}`,
    );
  const put = method("Put");
  const get = method("Get");
  const write = method("Write");
  const engine = graph.nodes.find(
    (node) =>
      node.file.endsWith("engine.h") &&
      node.kind === "class" &&
      (node.qualifiedName ?? node.name) === "storage.Engine",
  );
  const targetName = new Map(graph.nodes.map((node) => [node.id, node.name]));
  const callsFrom = (id: string | undefined, name: string) =>
    id !== undefined &&
    graph.edges.some(
      (edge) =>
        edge.kind === "calls" &&
        edge.from === id &&
        targetName.get(edge.to) === name,
    );

  TestValidator.predicate(
    "qualified multiline C++ definitions retain their method owner",
    put !== undefined && get !== undefined && write !== undefined,
  );
  TestValidator.predicate(
    "header types contain their source-file method definitions",
    engine !== undefined &&
      [put, get, write].every(
        (method) =>
          method !== undefined &&
          graph.edges.some(
            (edge) =>
              edge.kind === "contains" &&
              edge.from === engine.id &&
              edge.to === method.id,
          ),
      ),
  );
  TestValidator.predicate(
    "multiline C++ declarations retain their declared method names",
    ["Put", "Get", "Write"].every((name) =>
      graph.nodes.some(
        (node) =>
          node.file.endsWith("engine.h") &&
          node.kind === "method" &&
          node.name === name &&
          node.qualifiedName === `storage.Engine.${name}`,
      ),
    ),
  );
  TestValidator.equals(
    "a C++ return type is not mistaken for a method name",
    graph.nodes.some((node) => node.kind === "method" && node.name === "Status"),
    false,
  );
  TestValidator.equals(
    "a multiline function-pointer parameter is not a nested declaration",
    graph.nodes.some(
      (node) =>
        (node.kind === "function" || node.kind === "method") &&
        node.name === "void",
    ),
    false,
  );
  TestValidator.predicate(
    "an out-of-line method calls another method",
    callsFrom(put?.id, "Write"),
  );
  TestValidator.predicate(
    "the write path retains its storage calls",
    callsFrom(write?.id, "AddRecord") && callsFrom(write?.id, "InsertInto"),
  );
  TestValidator.predicate(
    "the read path retains its helper call",
    callsFrom(get?.id, "HiddenHelper"),
  );

  const hidden = graph.nodes.find((node) => node.name === "HiddenHelper");
  const visible = graph.nodes.find((node) => node.name === "VisibleHelper");
  TestValidator.equals(
    "an anonymous namespace has a stable qualified identity",
    hidden?.qualifiedName,
    "storage.(anonymous namespace).HiddenHelper",
  );
  TestValidator.equals(
    "an anonymous-namespace function is not exported",
    hidden?.exported === true,
    false,
  );
  const hiddenRuns = graph.nodes.filter(
    (node) => node.name === "Run" && node.file.endsWith("engine.cpp"),
  );
  TestValidator.predicate(
    "an out-of-line anonymous type method reconnects to its hidden owner",
    hiddenRuns.length > 0 &&
      hiddenRuns.every(
        (node) =>
          node.qualifiedName ===
            "storage.(anonymous namespace).HiddenEngine.Run" &&
          node.exported !== true,
      ),
  );
  TestValidator.predicate(
    "an out-of-line anonymous type constructor reconnects to its hidden owner",
    graph.nodes.some(
      (node) =>
        node.kind === "constructor" &&
        node.qualifiedName ===
          "storage.(anonymous namespace).HiddenEngine.HiddenEngine",
    ),
  );
  TestValidator.equals(
    "an anonymous type is not recreated as a public qualified owner",
    graph.nodes.some(
      (node) => node.qualifiedName === "storage.HiddenEngine.Run",
    ),
    false,
  );
  TestValidator.equals(
    "an ordinary named namespace remains distinct",
    visible?.qualifiedName,
    "storage.public_helpers.VisibleHelper",
  );
};
