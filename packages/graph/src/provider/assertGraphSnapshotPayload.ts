import path from "node:path";

import { parseGraphDump } from "../indexer/parseGraphDump";
import { graphSnapshotDigests } from "./graphSnapshotDigests";
import { IBulkGraphSession } from "./IBulkGraphSession";

/**
 * Validate the complete semantic payload shared by protocol and legacy
 * snapshot publication boundaries.
 */
export function assertGraphSnapshotPayload(
  snapshot: IBulkGraphSession.ISnapshot,
  root: string,
  label: string,
): void {
  const project = path.resolve(root);
  assertProvenance(snapshot, label);
  const provenance = snapshot.provenance;
  parseGraphDump({
    project,
    languages: snapshot.languages,
    indexer: "lsp",
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    diagnostics: snapshot.diagnostics,
    warnings: snapshot.warnings,
    provenance: [
      {
        provider: provenance.provider,
        languages: [...snapshot.languages],
        authority: provenance.authority,
        facts: [...provenance.facts],
        capabilities: [...provenance.capabilities],
        producer: {
          tool: provenance.tool,
          version: provenance.toolVersion,
          compiler: provenance.compilerVersion,
          schemaVersion: provenance.schemaVersion,
          protocolVersion: provenance.protocolVersion,
        },
        universe: provenance.universe,
        manifest: graphSnapshotDigests.manifestOf(snapshot),
        content: graphSnapshotDigests.contentOf(snapshot),
      },
    ],
    ...(snapshot.coverage !== undefined
      ? { coverage: snapshot.coverage }
      : {}),
    ...(snapshot.unresolved !== undefined
      ? { unresolved: snapshot.unresolved }
      : {}),
  });

  const nodeFiles = new Set<string>();
  for (const node of snapshot.nodes) {
    if (node.file !== "") nodeFiles.add(node.file);
  }
  assertSourceManifest(snapshot, project, label, nodeFiles);
}

function assertSourceManifest(
  snapshot: IBulkGraphSession.ISnapshot,
  root: string,
  label: string,
  nodeFiles: ReadonlySet<string>,
): void {
  for (const file of snapshot.sources.keys()) {
    if (file.startsWith("bundled:///")) {
      const relative = file.slice("bundled:///".length);
      if (
        relative === "" ||
        relative.includes("\0") ||
        relative.includes("\\") ||
        path.posix.normalize(relative) !== relative ||
        relative
          .split("/")
          .some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new Error(
          `${label} published a non-canonical bundled source identity: ${file}`,
        );
      }
    } else if (
      file.includes("\0") ||
      !path.isAbsolute(file) ||
      path.normalize(file) !== file
    ) {
      throw new Error(
        `${label} published a source identity that is not normalized and absolute: ${file}`,
      );
    }
  }

  const required = new Set<string>();
  for (const file of nodeFiles) requireHostSource(required, file);
  for (const node of snapshot.nodes) {
    if (node.evidence?.file !== undefined) {
      requireHostSource(required, node.evidence.file);
    }
    if (node.implementation?.file !== undefined) {
      requireHostSource(required, node.implementation.file);
    }
  }
  for (const edge of snapshot.edges) {
    if (edge.evidence?.file !== undefined) {
      requireHostSource(required, edge.evidence.file);
    }
  }
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.file !== "") requireHostSource(required, diagnostic.file);
  }
  for (const unresolved of snapshot.unresolved ?? []) {
    requireHostSource(required, unresolved.evidence.file);
  }

  for (const file of required) {
    const source = path.resolve(root, file);
    if (!snapshot.sources.has(source)) {
      throw new Error(
        `${label} published facts for ${file} without binding that file to its source manifest`,
      );
    }
  }
}

function requireHostSource(required: Set<string>, file: string): void {
  // A bundled identity is versioned with its provider/toolchain and has no
  // coordinator-readable host file. Requiring it in the host source manifest
  // rejects valid compiler builtins without adding a reproducible byte fence.
  if (!file.startsWith("bundled:///")) required.add(file);
}

function assertProvenance(
  snapshot: IBulkGraphSession.ISnapshot,
  label: string,
): void {
  const provenance = snapshot.provenance;
  if (
    !Number.isSafeInteger(provenance.schemaVersion) ||
    provenance.schemaVersion < 1 ||
    !Number.isSafeInteger(provenance.protocolVersion) ||
    provenance.protocolVersion < 0 ||
    provenance.tool === "" ||
    !SHA256.test(provenance.universe)
  ) {
    throw new Error(`${label} published an invalid provenance envelope`);
  }
  const capabilities = new Set(provenance.capabilities);
  if (
    capabilities.size !== provenance.capabilities.length ||
    provenance.capabilities.some((capability) => capability === "") ||
    !capabilities.has("universe")
  ) {
    throw new Error(
      `${label} published duplicate, empty, or unproven provenance capabilities`,
    );
  }
  const sourceDigests = capabilities.has("sourceDigests");
  const diskDigests = capabilities.has("diskDigests");
  for (const [file, digest] of snapshot.sources) {
    if (
      (sourceDigests && !SHA256.test(digest.checkerDigest)) ||
      (!sourceDigests && digest.checkerDigest !== "") ||
      (digest.diskDigest !== "" &&
        (!diskDigests || !SHA256.test(digest.diskDigest)))
    ) {
      throw new Error(
        `${label} published a source digest that contradicts its capabilities: ${file}`,
      );
    }
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
