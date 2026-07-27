import fs from "node:fs";
import path from "node:path";

import { allExtensions } from "../indexer/allExtensions";
import { GraphLanguage } from "../typings";
import { DEFAULT_IGNORES } from "../utils/DEFAULT_IGNORES";
import { normalizePath } from "../utils/normalizePath";
import { walkSourceFiles } from "../utils/walkSourceFiles";

/** Source and dynamically discovered build inputs owned by one provider. */
export function providerInputFiles(
  root: string,
  languages: readonly GraphLanguage[],
  buildFileNames: readonly string[],
  extraExtensions: readonly string[] = [],
): string[] {
  const resolved = path.resolve(root);
  const extensions = allExtensions(languages);
  for (const extension of extraExtensions) {
    extensions.add(extension.toLowerCase());
  }
  const inputs = new Set(
    walkSourceFiles(resolved, { extensions }).map(
      (file) => normalizePath(path.relative(resolved, file)),
    ),
  );
  const names = new Set(
    buildFileNames.filter((name) => !/[\\/]/.test(name)),
  );
  const paths = new Set(
    buildFileNames
      .filter((name) => /[\\/]/.test(name))
      .map((name) => normalizePath(name)),
  );
  visitBuildInputs(resolved, resolved, names, paths, inputs);
  return [...inputs].sort(compareOrdinal);
}

function visitBuildInputs(
  root: string,
  directory: string,
  names: ReadonlySet<string>,
  paths: ReadonlySet<string>,
  inputs: Set<string>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
    /* c8 ignore start -- a directory disappearing during the walk is benign
     * and cannot be triggered deterministically without racing the process. */
  } catch {
    return;
  }
  /* c8 ignore stop */
  entries.sort((left, right) => compareOrdinal(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORES.has(entry.name)) continue;
      if (fs.existsSync(path.join(absolute, ".git"))) continue;
      visitBuildInputs(root, absolute, names, paths, inputs);
    } else if (entry.isFile()) {
      const relative = normalizePath(path.relative(root, absolute));
      if (names.has(entry.name) || paths.has(relative)) inputs.add(relative);
    }
  }
}

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- callers sort distinct directory entries or paths. */
  return left < right ? -1 : left > right ? 1 : 0;
}
