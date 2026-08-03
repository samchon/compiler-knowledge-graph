import fs from "node:fs";
import path from "node:path";

import { TestValidator } from "@nestia/e2e";

import { GraphPaths } from "../internal/GraphPaths";

const CORPUS_NAMES = [
  "excalidraw",
  "gin",
  "flask",
  "tokio",
  "gson",
  "redis",
  "leveldb",
  "sinatra",
  "slim",
  "serilog",
  "koin",
  "lualine",
  "darthttp",
] as const;

/**
 * Every corpus repository below has, at some point, explained a real bug in a
 * source comment — a package that imports its own `testdata`, a package with
 * several `func init()`. That is exactly how a fixture name becomes product
 * behaviour: the next reader treats the named project as the specification and
 * special-cases it. This pins the prohibition mechanically over the shipped
 * source and sidecars, so a corpus name cannot reach a published artifact even
 * as prose.
 */
export const test_shipped_source_does_not_leak_benchmark_corpus_names = () => {
  const roots = [
    path.join(GraphPaths.graphPackageRoot, "src"),
    path.join(GraphPaths.graphPackageRoot, "sidecars"),
  ];
  const leaked: string[] = [];
  for (const root of roots)
    for (const file of walk(root)) {
      const source = fs.readFileSync(file, "utf8").toLowerCase();
      for (const name of CORPUS_NAMES)
        if (new RegExp(`\\b${name}\\b`, "u").test(source))
          leaked.push(
            `${path.relative(GraphPaths.graphPackageRoot, file).replaceAll("\\", "/")}: ${name}`,
          );
    }
  TestValidator.equals(
    "the published source carries no benchmark repository names",
    leaked,
    [],
  );
};

function walk(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(file) : [file];
    })
    .filter((file) =>
      /\.(?:ts|js|mjs|cjs|json|html|go|lua|mod|sum)$/u.test(file),
    );
}
