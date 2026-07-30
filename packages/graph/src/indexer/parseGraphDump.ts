import path from "node:path";

import typia from "typia";

import { ISamchonGraphDump, ISamchonGraphSpan } from "../structures";
import { GRAPH_EDGE_KINDS } from "../typings";
import { validateSemanticGraphNode } from "../provider/semanticIdentity";
import { fileOfNodeId } from "../utils/fileOfNodeId";

/**
 * Parse one public graph dump at the shared trust boundary.
 *
 * Structural reflection proves the JSON shape. The checks below prove the
 * relationships that no field-local schema can express: identity/file
 * agreement, unique nodes and edges, closed endpoints, valid coordinates and
 * coherent provider provenance.
 */
export function parseGraphDump(input: unknown): ISamchonGraphDump {
  const dump = typia.assert<ISamchonGraphDump>(input);
  if (!path.isAbsolute(dump.project)) {
    throw new Error("@samchon/graph: dump project must be absolute");
  }
  assertUnique(dump.languages, "dump language");

  const nodeIds = new Set<string>();
  const files = new Set<string>();
  const dumpLanguages = new Set(dump.languages);
  for (const node of dump.nodes) {
    if (node.file === "") {
      if (!node.external || node.kind !== "external_symbol") {
        throw new Error(
          `@samchon/graph: only an external symbol may omit its file: ${node.id}`,
        );
      }
    } else {
      validateGraphPath(node.file, `node ${node.id} file`);
      files.add(node.file);
    }
    if (!dumpLanguages.has(node.language)) {
      throw new Error(
        `@samchon/graph: node language is absent from the dump: ${node.language}`,
      );
    }
    if (nodeIds.has(node.id)) {
      throw new Error(`@samchon/graph: duplicate node id in dump: ${node.id}`);
    }
    nodeIds.add(node.id);
    validateSemanticGraphNode(node);
    if (
      !node.id.startsWith("@v2/") &&
      !node.id.startsWith("@g2/") &&
      !(node.external && node.kind === "external_symbol" && node.file === "")
    ) {
      if (node.kind === "file" && node.id === node.file) {
        // A synthesized or provider-owned file container is its own coordinate.
      } else {
        const parsed = fileOfNodeId.parseLegacy(node.id);
        if (
          parsed === undefined ||
          parsed.file !== node.file ||
          parsed.kind !== node.kind
        ) {
          throw new Error(
            `@samchon/graph: legacy node id does not match its file and kind: ${node.id}`,
          );
        }
      }
    }
    validateSpan(node.evidence, node.file, `${node.id}.evidence`);
    validateSpan(node.implementation, undefined, `${node.id}.implementation`);
  }

  const edgeKeys = new Set<string>();
  for (const edge of dump.edges) {
    validateEndpoint(edge.from, "source", nodeIds, files);
    validateEndpoint(edge.to, "target", nodeIds, files);
    const key = `${edge.kind}\0${edge.from}\0${edge.to}`;
    if (edgeKeys.has(key)) {
      throw new Error(
        `@samchon/graph: duplicate edge in dump: ${edge.from} -> ${edge.to} (${edge.kind})`,
      );
    }
    edgeKeys.add(key);
    validateSpan(edge.evidence, undefined, `${edge.from} -> ${edge.to}`);
  }

  for (const diagnostic of dump.diagnostics ?? []) {
    if (diagnostic.file !== "") {
      validateGraphPath(diagnostic.file, "diagnostic file");
    }
    const fileless = diagnostic.file === "";
    const invalidLine = fileless
      ? diagnostic.line !== 0
      : !isPositiveSafeInteger(diagnostic.line);
    const invalidColumn = fileless
      ? diagnostic.column !== 0
      : diagnostic.column !== undefined &&
        !isPositiveSafeInteger(diagnostic.column);
    if (invalidLine || invalidColumn) {
      throw new Error(
        "@samchon/graph: diagnostic coordinates must be one-based, or exactly 0:0 for a global finding",
      );
    }
  }

  const providers = new Set<string>();
  for (const row of dump.provenance ?? []) {
    if (row.provider === "" || providers.has(row.provider)) {
      throw new Error(
        `@samchon/graph: duplicate or empty provenance provider: ${row.provider}`,
      );
    }
    providers.add(row.provider);
    assertUnique(row.languages, `${row.provider} provenance language`);
    assertUnique(row.facts, `${row.provider} provenance fact`);
    assertUnique(row.capabilities, `${row.provider} provenance capability`);
    if (
      row.languages.length === 0 ||
      row.producer.tool === "" ||
      !Number.isSafeInteger(row.producer.schemaVersion) ||
      row.producer.schemaVersion < 1 ||
      !Number.isSafeInteger(row.producer.protocolVersion) ||
      row.producer.protocolVersion < 0 ||
      row.capabilities.some((capability) => capability === "") ||
      !row.capabilities.includes("universe")
    ) {
      throw new Error(
        `@samchon/graph: provenance ${row.provider} has an invalid producer envelope`,
      );
    }
    for (const language of row.languages) {
      if (!dumpLanguages.has(language)) {
        throw new Error(
          `@samchon/graph: provenance provider "${row.provider}" claims absent language ${language}`,
        );
      }
    }
    for (const [label, digest] of [
      ["universe", row.universe],
      ["manifest", row.manifest],
      ["content", row.content],
    ] as const) {
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(
          `@samchon/graph: provenance ${row.provider}.${label} is not SHA-256`,
        );
      }
    }
  }
  const coverage = new Map<
    string,
    NonNullable<ISamchonGraphDump["coverage"]>[number]
  >();
  const coverageSlices = new Map<
    string,
    Pick<
      NonNullable<ISamchonGraphDump["coverage"]>[number],
      "provider" | "language" | "target"
    >
  >();
  for (const row of dump.coverage ?? []) {
    if (
      row.provider === "" ||
      row.provider.includes("\0") ||
      row.target === "" ||
      row.target.includes("\0") ||
      !dumpLanguages.has(row.language)
    ) {
      throw new Error("@samchon/graph: coverage row has invalid ownership");
    }
    const key = coverageKey(row);
    if (coverage.has(key)) {
      throw new Error(`@samchon/graph: duplicate coverage row: ${key}`);
    }
    coverage.set(key, row);
    coverageSlices.set(
      coverageSliceKey(row),
      {
        provider: row.provider,
        language: row.language,
        target: row.target,
      },
    );
  }
  if (dump.coverage !== undefined) {
    for (const slice of coverageSlices.values())
      for (const family of GRAPH_EDGE_KINDS) {
        const key = coverageKey({ ...slice, family });
        if (!coverage.has(key)) {
          throw new Error(`@samchon/graph: coverage is not exhaustive: ${key}`);
        }
      }
    for (const provenance of dump.provenance ?? []) {
      for (const language of provenance.languages) {
        if (
          ![...coverageSlices.values()].some(
            (slice) =>
              slice.provider === provenance.provider &&
              slice.language === language,
          )
        ) {
          throw new Error(
            `@samchon/graph: coverage is missing for ${provenance.provider}/${language}`,
          );
        }
      }
    }
  }
  const unresolved = new Set<string>();
  for (const row of dump.unresolved ?? []) {
    validateSpan(row.evidence, undefined, "unresolved evidence");
    assertUnique(row.candidates ?? [], "unresolved candidate");
    const owner = (dump.provenance ?? []).find(
      (candidate) =>
        candidate.provider === row.provider &&
        candidate.languages.includes(row.language),
    );
    if (
      !/^[0-9a-f]{64}$/.test(row.universe) ||
      owner === undefined ||
      owner.universe !== row.universe
    ) {
      throw new Error(
        "@samchon/graph: unresolved site has no matching provider universe",
      );
    }
    const covered = coverage.get(coverageKey(row));
    if (covered?.state !== "partial") {
      throw new Error(
        "@samchon/graph: unresolved site does not have partial coverage",
      );
    }
    const key = JSON.stringify(row);
    if (unresolved.has(key)) {
      throw new Error("@samchon/graph: duplicate unresolved site");
    }
    unresolved.add(key);
  }
  return dump;
}

function coverageKey(row: {
  provider: string;
  language: string;
  target: string;
  family: string;
}): string {
  return `${row.provider}\0${row.language}\0${row.target}\0${row.family}`;
}

function coverageSliceKey(row: {
  provider: string;
  language: string;
  target: string;
}): string {
  return `${row.provider}\0${row.language}\0${row.target}`;
}

function validateEndpoint(
  endpoint: string,
  side: "source" | "target",
  nodeIds: ReadonlySet<string>,
  files: Set<string>,
): void {
  if (nodeIds.has(endpoint) || files.has(endpoint)) return;
  if (
    endpoint.startsWith("@v2/") ||
    endpoint.startsWith("@g2/") ||
    fileOfNodeId.parseLegacy(endpoint) !== undefined
  ) {
    throw new Error(
      `@samchon/graph: edge ${side} is absent from the dump: ${endpoint}`,
    );
  }
  validateGraphPath(endpoint, `edge ${side} file`);
  files.add(endpoint);
}

function validateSpan(
  span: ISamchonGraphSpan | undefined,
  implicitFile: string | undefined,
  label: string,
): void {
  if (span === undefined) return;
  if (span.file !== undefined) validateGraphPath(span.file, `${label}.file`);
  if (span.file === "" || implicitFile === "") {
    throw new Error(`@samchon/graph: ${label} has an empty file identity`);
  }
  if (
    !isPositiveSafeInteger(span.startLine) ||
    (span.startCol !== undefined && !isPositiveSafeInteger(span.startCol)) ||
    (span.endLine !== undefined &&
      (!isPositiveSafeInteger(span.endLine) ||
        span.endLine < span.startLine)) ||
    (span.endCol !== undefined &&
      (span.endLine === undefined ||
        !isPositiveSafeInteger(span.endCol) ||
        (span.endLine === span.startLine &&
          span.startCol !== undefined &&
          span.endCol < span.startCol)))
  ) {
    throw new Error(`@samchon/graph: ${label} has invalid coordinates`);
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function validateGraphPath(file: string, label: string): void {
  if (file.startsWith("bundled:///")) {
    const relative = file.slice("bundled:///".length);
    if (
      relative === "" ||
      relative.includes("\\") ||
      path.posix.normalize(relative) !== relative ||
      relative.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`@samchon/graph: ${label} is not a canonical bundled path`);
    }
    return;
  }
  const parts = file.split("/");
  if (
    file === "" ||
    file.includes("\\") ||
    /^[A-Za-z]:\//.test(file) ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    parts.some(
      (part, index) =>
        part === "" ||
        part === "." ||
        (part === ".." && parts.slice(index + 1).every((rest) => rest === "..")),
    )
  ) {
    throw new Error(`@samchon/graph: ${label} is not a schema-v6 graph path`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`@samchon/graph: duplicate ${label}`);
  }
}
