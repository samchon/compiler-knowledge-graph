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
  const compoundSuffixes: string[] = [];
  for (const extension of extraExtensions) {
    const normalized = extension.toLowerCase();
    if (normalized.indexOf(".", 1) === -1) extensions.add(normalized);
    else compoundSuffixes.push(normalized);
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
  visitBuildInputs(
    resolved,
    resolved,
    names,
    paths,
    compoundSuffixes,
    false,
    inputs,
  );
  return [...inputs].sort(compareOrdinal);
}

function visitBuildInputs(
  root: string,
  directory: string,
  names: ReadonlySet<string>,
  paths: ReadonlySet<string>,
  compoundSuffixes: readonly string[],
  exactOnly: boolean,
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
    const relative = normalizePath(path.relative(root, absolute));
    if (entry.isDirectory()) {
      const ignored = DEFAULT_IGNORES.has(entry.name);
      const declaredDescendant = [...paths].some((input) =>
        input.startsWith(`${relative}/`),
      );
      if (ignored && (entry.name === ".git" || !declaredDescendant)) {
        continue;
      }
      if (fs.existsSync(path.join(absolute, ".git"))) continue;
      visitBuildInputs(
        root,
        absolute,
        names,
        paths,
        compoundSuffixes,
        exactOnly || ignored,
        inputs,
      );
    } else if (entry.isFile()) {
      if (entry.name === ".git") continue;
      const lower = entry.name.toLowerCase();
      if (
        paths.has(relative) ||
        (!exactOnly &&
          (names.has(entry.name) ||
            compoundSuffixes.some((suffix) => lower.endsWith(suffix))))
      ) {
        inputs.add(relative);
      }
    }
  }
}

function compareOrdinal(left: string, right: string): number {
  // Two-way: callers sort distinct directory entries or paths, so the equal arm
  // cannot run, and an ignore directive over it would take the two reachable
  // arms out of the coverage gate with it -- which is how a reversed ordering
  // stops being a failing test.
  return left < right ? -1 : 1;
}
