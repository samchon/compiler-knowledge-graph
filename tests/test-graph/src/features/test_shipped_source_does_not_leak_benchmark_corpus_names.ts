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
 * A corpus name in product source is how a fixture becomes a specification:
 * the next reader treats the named project as the thing the code must satisfy
 * and special-cases it. The Go sidecar carried exactly that shape until this
 * campaign — two comments explaining real defects by naming the corpus that
 * exhibited them — and both were rewritten to describe the condition instead.
 *
 * Scope is `packages/graph/src` and `packages/graph/sidecars`. The README is
 * outside it on purpose: its benchmark tables name every corpus as published
 * measurement evidence.
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
      // Every extension `copy-sidecars.mjs` ships, plus the package's own
      // source. `.java` was missing while `sidecars/gradle` shipped a `.java`
      // file, so the one shipped language most likely to name a JVM corpus was
      // the one language this never read.
      /\.(?:ts|js|mjs|cjs|json|html|go|java|lua|mod|sum)$/u.test(file),
    );
}
