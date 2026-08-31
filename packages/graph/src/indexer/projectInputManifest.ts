import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { confinedProjectInput } from "./confinedProjectInput";
import { IBuildGraphOptions } from "./IBuildGraphOptions";
import { selectGraphSources } from "./selectGraphSources";

/**
 * Content tokens for the selected source set and declared build inputs.
 *
 * Missing inputs are entries too. Creating `tsconfig.json` can change a
 * program as decisively as editing it, so absence must compare differently
 * from an empty file and from a path the manifest never watched.
 */
export function projectInputManifest(
  root: string,
  options: IBuildGraphOptions,
  buildInputs: readonly string[],
  sourceFiles: readonly string[] = selectGraphSources(root, options).files,
): Map<string, string> {
  const files = new Set<string>();
  for (const file of sourceFiles) {
    files.add(path.resolve(file));
  }
  // Declared build inputs are coordinator-owned even if an unusual extension
  // makes one look like source. Their content decides the project universe and
  // must therefore be hashed, not hidden behind the provider-owned sentinel.
  for (const input of buildInputs) files.add(confinedProjectInput(root, input));

  const manifest = new Map<string, string>();
  for (const file of [...files].sort(compareOrdinal)) {
    try {
      manifest.set(
        file,
        createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      );
    } catch {
      manifest.set(file, "missing");
    }
  }
  return manifest;
}

function compareOrdinal(left: string, right: string): number {
  // Two-way: sets contain distinct normalized path identities, so the equal arm
  // cannot run, and an ignore directive over it would take the two reachable
  // arms out of the coverage gate with it -- which is how a reversed ordering
  // stops being a failing test.
  return left < right ? -1 : 1;
}
