const INPUT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "config/package.json",
  "packages/graph-sitter/package.json",
  "packages/graph/package.json",
  "tests/benchmark/package.json",
  "tests/experiment/package.json",
  "tests/test-graph/package.json",
];

/**
 * Manually reviewed facts for the pinned repository-orientation question.
 *
 * The input digest makes this oracle fail closed when an owning manifest moves;
 * update the declarations and digest together after reviewing that change.
 */
export const TOPOLOGY_ORIENTATION_ORACLE = {
  inputFiles: INPUT_FILES,
  inputDigest: "2a5bcae8a79790512fd799d8d49d28fa63a3be07979fa5f85e7322eff578d14b",
  nodes: [
    workspaceNode(),
    packageNode("@samchon/graph-workspace", ".", "package.json"),
    packageNode("@samchon/graph-config", "config", "config/package.json"),
    packageNode(
      "@samchon/graph-sitter",
      "packages/graph-sitter",
      "packages/graph-sitter/package.json",
    ),
    packageNode(
      "@samchon/graph",
      "packages/graph",
      "packages/graph/package.json",
    ),
    packageNode(
      "@samchon/graph-benchmark",
      "tests/benchmark",
      "tests/benchmark/package.json",
    ),
    packageNode(
      "@samchon/graph-experiment",
      "tests/experiment",
      "tests/experiment/package.json",
    ),
    packageNode(
      "@samchon/graph-test",
      "tests/test-graph",
      "tests/test-graph/package.json",
    ),
    rootNode(
      "generated-root",
      "lib",
      "packages/graph-sitter/lib",
      "packages/graph-sitter/package.json",
    ),
    rootNode(
      "source-root",
      "src",
      "packages/graph-sitter/src",
      "packages/graph-sitter/package.json",
    ),
    rootNode(
      "generated-root",
      "lib",
      "packages/graph/lib",
      "packages/graph/package.json",
    ),
    rootNode(
      "source-root",
      "sidecars",
      "packages/graph/sidecars",
      "packages/graph/package.json",
    ),
    rootNode(
      "source-root",
      "src",
      "packages/graph/src",
      "packages/graph/package.json",
    ),
    entrypointNode(
      "config",
      "exports:./lint:default",
      "config/lint.config.ts",
      "config/package.json",
    ),
    entrypointNode(
      "config",
      "exports:./lint:types",
      "config/lint.config.ts",
      "config/package.json",
    ),
    entrypointNode(
      "config",
      "exports:./package.json",
      "config/package.json",
      "config/package.json",
    ),
    entrypointNode(
      "config",
      "exports:./tsconfig",
      "config/tsconfig.json",
      "config/package.json",
    ),
    entrypointNode(
      "packages/graph",
      "bin:samchon-graph",
      "packages/graph/lib/bin.js",
      "packages/graph/package.json",
    ),
    entrypointNode(
      "packages/graph",
      "exports:./package.json",
      "packages/graph/package.json",
      "packages/graph/package.json",
    ),
    entrypointNode(
      "packages/graph",
      "exports:.:default",
      "packages/graph/lib/index.js",
      "packages/graph/package.json",
    ),
    entrypointNode(
      "packages/graph",
      "exports:.:types",
      "packages/graph/lib/index.d.ts",
      "packages/graph/package.json",
    ),
    entrypointNode(
      "packages/graph",
      "main",
      "packages/graph/lib/index.js",
      "packages/graph/package.json",
    ),
    entrypointNode(
      "packages/graph",
      "types",
      "packages/graph/lib/index.d.ts",
      "packages/graph/package.json",
    ),
    entrypointNode(
      "packages/graph-sitter",
      "exports:./package.json",
      "packages/graph-sitter/package.json",
      "packages/graph-sitter/package.json",
    ),
    entrypointNode(
      "packages/graph-sitter",
      "exports:.:default",
      "packages/graph-sitter/lib/index.js",
      "packages/graph-sitter/package.json",
    ),
    entrypointNode(
      "packages/graph-sitter",
      "exports:.:types",
      "packages/graph-sitter/lib/index.d.ts",
      "packages/graph-sitter/package.json",
    ),
    entrypointNode(
      "packages/graph-sitter",
      "main",
      "packages/graph-sitter/lib/index.js",
      "packages/graph-sitter/package.json",
    ),
    entrypointNode(
      "packages/graph-sitter",
      "types",
      "packages/graph-sitter/lib/index.d.ts",
      "packages/graph-sitter/package.json",
    ),
  ],
  dependencies: [
    dependency("@samchon/graph", "@samchon/graph-sitter"),
    dependency("@samchon/graph-benchmark", "@samchon/graph"),
    dependency("@samchon/graph-experiment", "@samchon/graph"),
    dependency("@samchon/graph-test", "@samchon/graph"),
    dependency("@samchon/graph-test", "@samchon/graph-sitter"),
  ],
};

function workspaceNode() {
  return {
    ...node("workspace", ".", "tool-resolved"),
    name: "compiler-knowledge-graph",
    evidence: evidence("pnpm-workspace.yaml"),
  };
}

function packageNode(name, coordinate, manifest) {
  return {
    ...node("package", name, "declared"),
    name,
    coordinate,
    evidence: evidence(manifest),
  };
}

function rootNode(kind, name, root, manifest) {
  return {
    ...node(kind, root, "declared"),
    name,
    root,
    evidence: evidence(manifest),
  };
}

function entrypointNode(packageCoordinate, name, file, manifest) {
  const coordinate = `${packageCoordinate}:${name}`;
  return {
    ...node("entrypoint", coordinate, "declared"),
    name,
    file,
    evidence: evidence(manifest),
  };
}

function node(kind, identity, authority) {
  return {
    id: `repository://pnpm/default/${kind}/${encodeURIComponent(identity)}`,
    authority,
    kind,
    ecosystem: "pnpm",
    coordinate: identity,
    configuration: "default",
    external: false,
  };
}

function evidence(file) {
  return { file, startLine: 1, startColumn: 1 };
}

function dependency(from, to) {
  return {
    authority: "tool-resolved",
    kind: "depends-on",
    from: `repository://pnpm/default/package/${encodeURIComponent(from)}`,
    to: `repository://pnpm/default/package/${encodeURIComponent(to)}`,
  };
}
