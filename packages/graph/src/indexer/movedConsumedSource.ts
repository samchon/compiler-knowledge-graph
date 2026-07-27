import { createHash } from "node:crypto";
import fs from "node:fs";

/**
 * First source whose current text differs from what the consumer received, and
 * how.
 *
 * The "how" is not decoration. A C# corpus fixture failed this check three
 * bounded attempts running, twice in a row, and the message it produced —
 * `<file> changed after this build consumed it` — could not distinguish three
 * quite different situations:
 *
 *   * the file genuinely changed on disk while the build was running,
 *   * the coordinator stripped the leading BOM before opening the source,
 *   * the server reported text it had normalized, such as line endings folded
 *     to `\n`, while the bytes on disk still carry it,
 *   * the file was read back through a different encoding than the producer
 *     used.
 *
 * Only the first is the hazard this guard exists for. A stripped leading BOM is
 * the coordinator's own documented transport transform, and the surrounding
 * raw-byte manifest comparison still detects a BOM added or removed during the
 * build. Other differences remain failures; naming them turns an unactionable
 * retry loop into a diagnosis.
 */
export function movedConsumedSource(
  sources: ReadonlyMap<string, string>,
  manifest?: ReadonlyMap<string, string>,
): movedConsumedSource.IMovement | undefined {
  for (const [file, consumed] of sources) {
    let current: Buffer;
    try {
      current = fs.readFileSync(file);
    } catch {
      return { file, detail: "it could not be read back" };
    }
    const text = current.toString("utf8");
    if (!sameConsumedText(text, consumed))
      return { file, detail: describe(text, consumed) };
    if (
      manifest !== undefined &&
      manifest.get(file) !==
        createHash("sha256").update(current).digest("hex")
    ) {
      return {
        file,
        detail: "its text is unchanged but its manifest digest is not",
      };
    }
  }
  return undefined;
}

/**
 * `readText` removes one leading UTF-8 BOM before a generic source is opened.
 * Accept exactly that transport representation here; the caller separately
 * fences the raw project-input manifest before and after the build.
 */
function sameConsumedText(current: string, consumed: string): boolean {
  return (
    current === consumed ||
    (current.startsWith(BOM) && current.slice(BOM.length) === consumed)
  );
}

export namespace movedConsumedSource {
  export interface IMovement {
    /** The source whose text no longer matches what was consumed. */
    file: string;

    /** Why the two disagree, in a form a reader can act on. */
    detail: string;
  }
}

/**
 * Name the difference between what is on disk and what the build consumed.
 *
 * Ordered by how often each explains a real failure rather than by how easy it
 * is to detect: a normalization mismatch repeats forever and a genuine edit
 * clears on the next attempt, so a reader who sees "differs only by" knows to
 * stop retrying.
 */
function describe(current: string, consumed: string): string {
  if (current.startsWith(BOM) && !consumed.startsWith(BOM)) {
    return current.slice(BOM.length) === consumed
      ? "they differ only by a leading byte order mark the consumer stripped"
      : `it carries a byte order mark the consumer stripped, and differs further from offset ${String(firstDifference(current.slice(BOM.length), consumed))}`;
  }
  if (current.replace(/\r\n/g, "\n") === consumed.replace(/\r\n/g, "\n")) {
    return "they differ only by line endings";
  }
  const at = firstDifference(current, consumed);
  return (
    `on-disk length ${String(current.length)}, consumed length ` +
    `${String(consumed.length)}, first difference at offset ${String(at)}`
  );
}

// Escaped, not literal. A byte order mark written into the source is an
// invisible character in the file that describes byte order marks, which the
// lint rule refuses and a reader would never see.
const BOM = "\uFEFF";

function firstDifference(left: string, right: string): number {
  const shortest = Math.min(left.length, right.length);
  for (let index = 0; index < shortest; index++)
    if (left[index] !== right[index]) return index;
  return shortest;
}
