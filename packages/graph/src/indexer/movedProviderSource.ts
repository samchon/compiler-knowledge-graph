import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { IBulkGraphSession } from "../provider/IBulkGraphSession";

/**
 * Find a provider source that no longer belongs to the fenced generation.
 *
 * Four different things can be wrong here and they used to read as one
 * sentence, which cost a whole CI round to tell apart: a provider that never
 * hashed the file, a path it named in a form the coordinator cannot compare, a
 * file whose bytes moved under the refresh, and a file outside the tracked
 * input set whose bytes no longer match what the provider read. Each one is a
 * different defect in a different place, so each one says which it is.
 */
export function movedProviderSource(
  digests: ReadonlyMap<
    string,
    IBulkGraphSession.ISourceDigest
  > | undefined,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string | undefined {
  if (digests === undefined) return undefined;
  for (const [file, digest] of digests) {
    const expectedBefore = before.get(file);
    const expectedAfter = after.get(file);
    const unbound = (reason: string): string =>
      `${file} does not bind the provider snapshot to the coordinator's input generation: ${reason}`;
    if (digest.diskDigest === "") {
      if (
        file.startsWith("bundled:///") &&
        expectedBefore === undefined &&
        expectedAfter === undefined
      ) {
        continue;
      }
      return unbound(
        "the provider published no on-disk digest for it, so nothing ties its facts to bytes a reader can hash",
      );
    }
    if (expectedBefore === undefined && expectedAfter === undefined) {
      if (!path.isAbsolute(file)) {
        return unbound(
          "the provider named it by a relative path, which no input coordinate can be compared against",
        );
      }
      const found = diskDigest(file);
      if (digest.diskDigest !== found) {
        return unbound(
          found === ""
            ? "it is outside the tracked input set and could not be read back"
            : `it is outside the tracked input set and its bytes are now ${found}, not ${digest.diskDigest}`,
        );
      }
      continue;
    }
    if (
      digest.diskDigest !== expectedBefore ||
      digest.diskDigest !== expectedAfter
    ) {
      return unbound(
        `the provider read ${digest.diskDigest} while the generation was fenced at ${String(expectedBefore)} and settled at ${String(expectedAfter)}`,
      );
    }
  }
  return undefined;
}

function diskDigest(file: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}
