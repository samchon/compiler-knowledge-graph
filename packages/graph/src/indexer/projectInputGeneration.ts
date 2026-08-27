import { createHash } from "node:crypto";
import path from "node:path";

import { IBulkGraphSession } from "../provider/IBulkGraphSession";
import { ISamchonGraphDump } from "../structures";

interface IProjectInputGeneration {
  sourceFiles: readonly string[];
  buildInputFiles: readonly string[];
  manifest: ReadonlyMap<string, string>;
  consumedSources?: ReadonlyMap<string, string>;
  providerSources?: ReadonlyMap<string, IBulkGraphSession.ISourceDigest>;
  provenance?: readonly ISamchonGraphDump.IProvenance[];
}

/**
 * One deterministic token for every input that contributed to a graph.
 *
 * The transaction's individual gates answer whether each input still matches.
 * This token answers the project-wide question they exist to prove: which
 * exact source set, build universe, generic bytes, and provider checker
 * generation were committed together.
 */
export function projectInputGeneration(
  input: IProjectInputGeneration,
): string {
  const hash = createHash("sha256");
  collection(
    hash,
    "source-set",
    [...new Set(input.sourceFiles)]
      .sort(compareOrdinal)
      .map((file) => [file]),
  );
  collection(
    hash,
    "build-input-set",
    [...new Set(input.buildInputFiles)]
      .sort(compareOrdinal)
      .map((file) => [file]),
  );
  collection(
    hash,
    "coordinator-manifest",
    [...input.manifest]
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([file, digest]) => [file, digest]),
  );
  collection(
    hash,
    "generic-consumed-sources",
    [...(input.consumedSources ?? new Map())]
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([file, text]) => [
        file,
        createHash("sha256").update(text).digest("hex"),
      ]),
  );
  collection(
    hash,
    "provider-sources",
    [...(input.providerSources ?? new Map())]
      .map(([file, digest]) => [providerSourceIdentity(file), digest] as const)
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([file, digest]) => [
        file,
        digest.checkerDigest,
        digest.diskDigest,
      ]),
  );
  collection(
    hash,
    "provider-universes",
    [...(input.provenance ?? [])]
      .sort((left, right) => compareOrdinal(left.provider, right.provider))
      .map((row) => [
        row.provider,
        row.universe,
        row.manifest,
        String(row.languages.length),
        ...row.languages,
      ]),
  );
  return hash.digest("hex");
}

function collection(
  hash: ReturnType<typeof createHash>,
  label: string,
  rows: readonly (readonly string[])[],
): void {
  frame(hash, "collection", Buffer.from(label, "utf8"));
  frame(hash, "row-count", Buffer.from(String(rows.length), "utf8"));
  for (const row of rows) {
    frame(hash, "field-count", Buffer.from(String(row.length), "utf8"));
    for (const value of row) {
      frame(hash, "value", Buffer.from(value, "utf8"));
    }
  }
}

function frame(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: Buffer,
): void {
  const labelBytes = Buffer.from(label, "utf8");
  hash.update(String(labelBytes.length));
  hash.update(":");
  hash.update(labelBytes);
  hash.update(String(value.length));
  hash.update(":");
  hash.update(value);
}

function compareOrdinal(left: string, right: string): number {
  // Two-way: sorted sets/maps contain distinct string identities, so the equal
  // arm cannot run, and an ignore directive over it would take the two
  // reachable arms out of the coverage gate with it -- which is how a reversed
  // ordering stops being a failing test.
  return left < right ? -1 : 1;
}

function providerSourceIdentity(file: string): string {
  /* c8 ignore start -- only Windows folds filesystem identities; each
   * platform's CI run exercises its own identity rule. */
  if (process.platform === "win32" && !file.startsWith("bundled:///")) {
    return path.normalize(file).toLowerCase();
  }
  /* c8 ignore stop */
  return file;
}
