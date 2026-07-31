import fs from "node:fs";
import path from "node:path";

import { ISamchonRepositoryContextDump } from "../structures";
import { RepositoryContextRelationKind } from "../typings";
import { RepositoryContextProtocol } from "./RepositoryContextProtocol";

/** Canonical repository-context identities, evidence and input digests. */
export namespace repositoryContextFacts {
  export function repositoryContextId(
  ecosystem: string,
  kind: ISamchonRepositoryContextDump.INode["kind"],
  coordinate: string,
  configuration = "default",
): string {
  return `repository://${encodeURIComponent(ecosystem)}/${encodeURIComponent(
    configuration,
  )}/${encodeURIComponent(kind)}/${encodeURIComponent(coordinate)}`;
}

  export function repositoryContextCoverage(
  provider: string,
  ecosystem: string,
  target: string,
  complete: readonly RepositoryContextRelationKind[],
  partial: readonly RepositoryContextRelationKind[] = [],
): ISamchonRepositoryContextDump.ICoverage[] {
  return RepositoryContextProtocol.RELATION_KINDS.map((family) => ({
    provider,
    ecosystem,
    target,
    family,
    state: complete.includes(family)
      ? "complete"
      : partial.includes(family)
        ? "partial"
        : "unsupported",
  }));
}

  export function repositoryContextSource(
  root: string,
  file: string,
): ISamchonRepositoryContextDump.ISource {
  const absolute = path.resolve(root, file);
  return {
    file: repositoryContextFile(root, absolute),
    digest: repositoryContextPathDigest(absolute),
  };
}

/** Digest file bytes or one directory's immediate entry identities. */
  export function repositoryContextPathDigest(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (stat.isFile()) {
      return RepositoryContextProtocol.digest(fs.readFileSync(file));
    }
    if (stat.isDirectory()) {
      return RepositoryContextProtocol.digest(
        fs
          .readdirSync(file, { withFileTypes: true })
          .map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                /* c8 ignore next -- special Dirents are platform-specific. */
                : "other",
          }))
          .sort((left, right) => compare(left.name, right.name)),
      );
    }
  } catch {
    // The absent identity below is also used when a path moves mid-read.
  }
  return RepositoryContextProtocol.digest({ absent: true });
}

  export function repositoryContextFile(root: string, file: string): string {
  return path.relative(root, path.resolve(file)).replaceAll("\\", "/") || ".";
}

  export function repositoryContextEvidence(
  root: string,
  file: string,
): ISamchonRepositoryContextDump.IEvidence {
  return {
    file: repositoryContextFile(root, file),
    startLine: 1,
    startColumn: 1,
  };
}

  export function uniqueRepositorySources(
  sources: readonly ISamchonRepositoryContextDump.ISource[],
): ISamchonRepositoryContextDump.ISource[] {
  const unique = new Map<string, string>();
  for (const source of sources) {
    const prior = unique.get(source.file);
    if (prior !== undefined && prior !== source.digest) {
      throw new Error(
        `repository context adapter: sources disagree about ${source.file}`,
      );
    }
    unique.set(source.file, source.digest);
  }
  return [...unique]
    .sort(([left], [right]) => compare(left, right))
    .map(([file, digest]) => ({ file, digest }));
}

  export function compareRepositoryText(
  left: string,
  right: string,
): number {
  return compare(left, right);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
}
