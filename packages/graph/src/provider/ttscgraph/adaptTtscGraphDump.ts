import { createHash } from "node:crypto";
import path from "node:path";
import { compareOrdinal } from "@samchon/graph-sitter";

import {
  ISamchonGraphDecorator,
  ISamchonGraphDiagnostic,
  ISamchonGraphEdge,
  ISamchonGraphEvidence,
  ISamchonGraphNode,
} from "../../structures";
import {
  GraphEdgeKind,
  GraphNodeKind,
  GraphProviderAuthority,
} from "../../typings";
import { IBulkGraphSession } from "../IBulkGraphSession";
import { fileOfNodeId } from "../../utils/fileOfNodeId";
import { ITtscGraphSnapshot } from "./ITtscGraphSnapshot";

/**
 * One validated dump, in the product's own terms.
 *
 * The protocol version is the envelope's to state, not the dump's: the same
 * body can arrive over the wire or be read from a file, and only one of those
 * rode a protocol. {@link TtscGraphClient} completes the provenance with the
 * version of the frame that carried it.
 */
interface IAdaptedDump {
  target: string;
  nodes: ISamchonGraphNode[];
  edges: ISamchonGraphEdge[];
  diagnostics: ISamchonGraphDiagnostic[];
  sources: Map<string, IBulkGraphSession.ISourceDigest>;
  provenance: Omit<IBulkGraphSession.IProvenance, "protocolVersion">;
  warnings: string[];
}

/**
 * Adapt a `ttscgraph serve` dump to one strict TypeScript language slice.
 *
 * The dump already is the semantic fact source. This adapter only adds the
 * language discriminator and performs the same module-to-file export-surface
 * fold as ttsc's canonical TtscGraphMemory. It rejects malformed identities,
 * dangling endpoints, and collisions instead of repairing or deduplicating
 * compiler output.
 *
 * It also decides whether the dump has proved itself. The facts, the manifest,
 * and the diagnostics are only worth adapting together if they came from one
 * `Program`, and the dump is the only place that can say so: everything here is
 * checked against the dump's own `provenance` rather than against the disk,
 * which is a later instant and a different question. A dump whose nodes name a
 * file its manifest never loaded is not a dump with a missing entry — it is two
 * programs' output in one envelope, and no part of it can be trusted.
 */
export function adaptTtscGraphDump(
  input: unknown,
  expectedRoot: string,
): IAdaptedDump {
  const dump = objectOf(input, "dump");
  const rawProvenance = objectOf(dump.provenance, "dump.provenance");
  const schemaVersion = rawProvenance.schemaVersion;
  if (
    !Number.isSafeInteger(schemaVersion) ||
    !ITtscGraphSnapshot.SUPPORTED_DUMP_SCHEMA_VERSIONS.includes(
      schemaVersion as number,
    )
  ) {
    throw new Error(
      `ttscgraph: dump is schema ${
        Number.isSafeInteger(schemaVersion)
          ? `v${String(schemaVersion)}`
          : "unknown"
      }, this client reads ${ITtscGraphSnapshot.SUPPORTED_DUMP_SCHEMA_VERSIONS.map(
        (version) => `v${String(version)}`,
      ).join(" and ")}. Install a matching ttsc (the binary resolves from the target project, or from TTSC_GRAPH_BINARY).`,
    );
  }
  const warnings: string[] = [];
  const project = stringOf(dump.project, "dump.project");
  if (!samePath(project, expectedRoot)) {
    throw new Error(
      `ttscgraph: response project ${project} does not match ${expectedRoot}`,
    );
  }
  const target = stringOf(dump.tsconfig, "dump.tsconfig");
  validateGraphFile(target, "dump.tsconfig");
  const rawNodes = arrayOf(dump.nodes, "dump.nodes");
  const rawEdges = arrayOf(dump.edges, "dump.edges");
  const moduleIds = new Map<string, string>();
  const rawIds = new Set<string>();
  const sourceFileById = new Map<string, string>();
  const nodes: ISamchonGraphNode[] = [];
  const factFiles = new Set<string>();

  for (let index = 0; index < rawNodes.length; index++) {
    const raw = objectOf(rawNodes[index], `dump.nodes[${index}]`);
    const id = stringOf(raw.id, `dump.nodes[${index}].id`);
    if (rawIds.has(id)) throw new Error(`ttscgraph: duplicate node id: ${id}`);
    rawIds.add(id);
    const kind = nodeKindOf(raw.kind, `dump.nodes[${index}].kind`);
    const file = stringOf(raw.file, `dump.nodes[${index}].file`);
    const external = booleanOf(raw.external, `dump.nodes[${index}].external`);
    validateGraphFile(file, `dump.nodes[${index}].file`, external);
    validateNodeId(id, file, kind);
    sourceFileById.set(id, file);
    factFiles.add(file);
    if (kind === "module") {
      // `validateGraphFile` above already rejects an empty file for every node,
      // so a module reaching here always names a file.
      moduleIds.set(id, file);
      continue;
    }
    const node: ISamchonGraphNode = {
      id,
      kind,
      language: "typescript",
      name: stringOf(raw.name, `dump.nodes[${index}].name`),
      file,
      external,
    };
    optionalString(raw.qualifiedName, `${id}.qualifiedName`, (value) => {
      node.qualifiedName = value;
    });
    optionalBoolean(raw.ignored, `${id}.ignored`, (value) => {
      node.ignored = value;
    });
    optionalBoolean(raw.exported, `${id}.exported`, (value) => {
      node.exported = value;
    });
    optionalBoolean(raw.closure, `${id}.closure`, (value) => {
      node.closure = value;
    });
    if (raw.modifiers !== undefined) {
      node.modifiers = arrayOf(raw.modifiers, `${id}.modifiers`).map(
        (value, modifierIndex) =>
          modifierOf(value, `${id}.modifiers[${modifierIndex}]`),
      );
    }
    if (raw.literals !== undefined) {
      if (kind !== "type" && kind !== "enum") {
        throw new Error(
          `ttscgraph: ${id}.literals is only valid on type or enum nodes`,
        );
      }
      node.literals = stringArrayOf(raw.literals, `${id}.literals`);
    }
    if (raw.enumMembers !== undefined) {
      if (kind !== "enum") {
        throw new Error(
          `ttscgraph: ${id}.enumMembers is only valid on enum nodes`,
        );
      }
      node.enumMembers = enumMembersOf(raw.enumMembers, id);
    }
    if (raw.objectMembers !== undefined) {
      if (kind !== "variable") {
        throw new Error(
          `ttscgraph: ${id}.objectMembers is only valid on variable nodes`,
        );
      }
      node.objectMembers = objectMembersOf(raw.objectMembers, id);
    }
    if (raw.decorators !== undefined) {
      node.decorators = decoratorsOf(raw.decorators, id);
    }
    optionalString(raw.signature, `${id}.signature`, (value) => {
      node.signature = value;
    });
    if (raw.evidence !== undefined) {
      node.evidence = evidenceOf(raw.evidence, file, `${id}.evidence`, true);
      factFiles.add(node.evidence.file);
    }
    if (raw.implementation !== undefined) {
      node.implementation = evidenceOf(
        raw.implementation,
        file,
        `${id}.implementation`,
      );
      factFiles.add(node.implementation.file);
    }
    nodes.push(node);
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  // A folded file node takes the module's file path as its id, and that path can
  // never collide with a declaration node id: `validateNodeId` requires every
  // declaration id to contain a `#`, while a module file (the id prefix before
  // the first `#`) never does. No runtime collision check is therefore possible.
  // Canonical TtscGraphMemory turns every compiler module into one file node,
  // including an edge-and-declaration-free module whose module node is its only
  // trace. The strict adapter folds modules before the shared memory sees them,
  // so retain that exact structural fact here. Generic LSP/static `module`
  // declarations never enter this adapter and remain untouched.
  for (const file of new Set(moduleIds.values())) {
    nodes.push({
      id: file,
      kind: "file",
      language: "typescript",
      name: path.posix.basename(file),
      file,
      external: false,
    });
  }

  const edges: ISamchonGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  for (let index = 0; index < rawEdges.length; index++) {
    const raw = objectOf(rawEdges[index], `dump.edges[${index}]`);
    const rawFrom = stringOf(raw.from, `dump.edges[${index}].from`);
    const rawTo = stringOf(raw.to, `dump.edges[${index}].to`);
    if (!rawIds.has(rawFrom)) {
      throw new Error(`ttscgraph: edge has unknown from endpoint: ${rawFrom}`);
    }
    if (!nodeIds.has(rawTo)) {
      throw new Error(
        `ttscgraph: edge has unknown or folded to endpoint: ${rawTo}`,
      );
    }
    const from = moduleIds.get(rawFrom) ?? rawFrom;
    const kind = edgeKindOf(raw.kind, `dump.edges[${index}].kind`);
    const key = `${kind}\0${from}\0${rawTo}`;
    if (edgeKeys.has(key)) {
      throw new Error(
        `ttscgraph: duplicate edge after module folding: ${kind} ${from} -> ${rawTo}`,
      );
    }
    edgeKeys.add(key);
    const edge: ISamchonGraphEdge = { from, to: rawTo, kind };
    if (raw.evidence !== undefined) {
      edge.evidence = evidenceOf(
        raw.evidence,
        sourceFileById.get(rawFrom)!,
        `dump.edges[${index}].evidence`,
        true,
      );
      factFiles.add(edge.evidence.file);
    }
    edges.push(edge);
  }

  const capabilities = stringArrayOf(
    objectOf(dump.provenance, "dump.provenance").capabilities,
    "dump.provenance.capabilities",
  );
  const manifest = manifestOf(dump.provenance);
  mergeConfigurationSources(manifest, dump.provenance, capabilities);
  for (const file of [...factFiles].sort(compareOrdinal)) {
    if (!manifest.has(file)) {
      throw new Error(
        `ttscgraph: dump declares facts for ${file}, which its own source manifest never loaded`,
      );
    }
  }
  const sources = new Map<string, IBulkGraphSession.ISourceDigest>();
  // Preserve the complete compiler-owned manifest. Relative identities become
  // absolute keys for the bulk-session contract; identities that are already
  // absolute stay canonical, and bundled virtual identities must never pass
  // through `path.resolve`, which would turn them into unrelated disk paths.
  for (const [file, digest] of [...manifest].sort(([left], [right]) =>
    compareOrdinal(left, right),
  )) {
    sources.set(sourceManifestKey(expectedRoot, file), digest);
  }

  const diagnostics = capabilities.includes(
    ITtscGraphSnapshot.CAPABILITY_DIAGNOSTICS,
  )
    ? diagnosticsOf(dump.diagnostics, manifest)
    : refuseDiagnostics(dump.diagnostics, warnings);

  return {
    target,
    nodes,
    edges,
    diagnostics,
    sources,
    provenance: provenanceOf(
      dump.provenance,
      schemaVersion as number,
      capabilities,
    ),
    warnings,
  };
}

/**
 * The manifest, indexed by the identity the producer gave each file.
 *
 * Validating it costs one pass whether or not a caller reads every entry, and
 * that is deliberate: a manifest is evidence, and evidence checked only where
 * it happens to be consulted is evidence for nothing.
 */
function manifestOf(
  value: unknown,
): Map<string, IBulkGraphSession.ISourceDigest> {
  const provenance = objectOf(value, "dump.provenance");
  const capabilities = stringArrayOf(
    provenance.capabilities,
    "dump.provenance.capabilities",
  );
  // Without this claim the manifest is empty by construction rather than by
  // fact, and an empty manifest would make every "did the program load this
  // file?" check below pass vacuously — turning the one proof this client has
  // into a formality. There is no honest fallback: re-reading the disk to fill
  // the gap is precisely the unsound reconstruction the manifest replaced.
  if (!capabilities.includes(ITtscGraphSnapshot.CAPABILITY_SOURCE_DIGESTS)) {
    throw new Error(
      `ttscgraph: producer does not claim the ${ITtscGraphSnapshot.CAPABILITY_SOURCE_DIGESTS} capability, so its snapshot cannot prove which program produced its facts`,
    );
  }
  const hasDiskDigests = capabilities.includes(
    ITtscGraphSnapshot.CAPABILITY_DISK_DIGESTS,
  );
  const raw = arrayOf(provenance.sources, "dump.provenance.sources");
  const manifest = new Map<string, IBulkGraphSession.ISourceDigest>();
  for (let index = 0; index < raw.length; index++) {
    const label = `dump.provenance.sources[${index}]`;
    const entry = objectOf(raw[index], label);
    const file = stringOf(entry.file, `${label}.file`);
    validateGraphFile(file, `${label}.file`, true);
    if (manifest.has(file)) {
      throw new Error(`ttscgraph: duplicate source manifest entry: ${file}`);
    }
    const diskDigest = stringOf(entry.diskDigest, `${label}.diskDigest`);
    // An absent disk digest is the producer's way of saying the file vanished
    // mid-load or never had an on-disk identity; a disk digest the producer
    // never claimed to compute is a different statement, and neither is an
    // arbitrary string.
    if (diskDigest !== "") {
      if (!hasDiskDigests) {
        throw new Error(
          `ttscgraph: ${label}.diskDigest is set although the producer does not claim the ${ITtscGraphSnapshot.CAPABILITY_DISK_DIGESTS} capability`,
        );
      }
      validateDigest(diskDigest, `${label}.diskDigest`);
    }
    manifest.set(file, {
      checkerDigest: validateDigest(
        stringOf(entry.checkerDigest, `${label}.checkerDigest`),
        `${label}.checkerDigest`,
      ),
      diskDigest,
    });
  }
  return manifest;
}

/**
 * The universe fingerprint: one digest over the inputs that decide the file set.
 *
 * Hashed rather than carried because the only question anything asks of it is
 * whether it is the one from last time. The encoding length-prefixes every
 * field so that no rearrangement of config and root names can collide — without
 * it, a config named `a` with root `b/c` and a config named `a/b` with root `c`
 * would fingerprint identically, and a universe change that reshuffled exactly
 * that way would look like no change at all.
 */
function universeOf(value: unknown): string {
  const universe = objectOf(value, "dump.provenance.universe");
  const hash = createHash("sha256");
  const push = (text: string): void => {
    hash.update(`${String(text.length)}:${text}`);
  };
  const configs = arrayOf(universe.configs, "dump.provenance.universe.configs");
  // A program is always loaded from at least one config; a universe naming none
  // fingerprints every project identically, which would make the comparison
  // that guards `incremental` say "unchanged" forever.
  if (configs.length === 0) {
    throw new Error(
      "ttscgraph: dump.provenance.universe.configs names no config, so the build universe has no fingerprint",
    );
  }
  push("configs");
  const configFiles = new Set<string>();
  for (let index = 0; index < configs.length; index++) {
    const label = `dump.provenance.universe.configs[${index}]`;
    const config = objectOf(configs[index], label);
    const file = stringOf(config.file, `${label}.file`);
    validateGraphFile(file, `${label}.file`);
    if (configFiles.has(file)) {
      throw new Error(
        `ttscgraph: duplicate build-universe config identity: ${file}`,
      );
    }
    configFiles.add(file);
    push(file);
    push(
      validateDigest(
        stringOf(config.digest, `${label}.digest`),
        `${label}.digest`,
      ),
    );
  }
  const roots = arrayOf(universe.roots, "dump.provenance.universe.roots");
  push("roots");
  const rootsByConfig = new Map<string, Set<string>>();
  for (let index = 0; index < roots.length; index++) {
    const label = `dump.provenance.universe.roots[${index}]`;
    const root = objectOf(roots[index], label);
    const config = stringOf(root.config, `${label}.config`);
    validateGraphFile(config, `${label}.config`);
    if (!configFiles.has(config)) {
      throw new Error(
        `ttscgraph: ${label}.config names an unknown build-universe config: ${config}`,
      );
    }
    const file = stringOf(root.file, `${label}.file`);
    validateGraphFile(file, `${label}.file`, true);
    const configRoots = rootsByConfig.get(config);
    if (configRoots?.has(file) === true) {
      throw new Error(
        `ttscgraph: duplicate build-universe root pair: ${config} -> ${file}`,
      );
    }
    if (configRoots === undefined) rootsByConfig.set(config, new Set([file]));
    else configRoots.add(file);
    push(config);
    push(file);
  }
  return hash.digest("hex");
}

function provenanceOf(
  value: unknown,
  schemaVersion: number,
  capabilities: string[],
): Omit<IBulkGraphSession.IProvenance, "protocolVersion"> {
  const provenance = objectOf(value, "dump.provenance");
  // Read the universe even though only the fingerprint is kept: skipping the
  // walk when nothing reads the parts would let a malformed universe through on
  // every snapshot whose fingerprint nobody happened to compare.
  if (!capabilities.includes(ITtscGraphSnapshot.CAPABILITY_UNIVERSE)) {
    throw new Error(
      `ttscgraph: producer does not claim the ${ITtscGraphSnapshot.CAPABILITY_UNIVERSE} capability, so its snapshot cannot state which inputs decided its file set`,
    );
  }
  const producer = objectOf(provenance.producer, "dump.provenance.producer");
  return {
    // Stated here rather than read from the wire: which registered provider
    // this is, what its facts are grounded in, and which families it may
    // publish are the graph's own claims about a producer, not the producer's
    // claims about itself. A snapshot that could name its own authority could
    // name any authority.
    provider: adaptTtscGraphDump.PROVIDER,
    authority: adaptTtscGraphDump.AUTHORITY,
    facts: [...adaptTtscGraphDump.EDGE_KINDS],
    schemaVersion,
    tool: stringOf(producer.tool, "dump.provenance.producer.tool"),
    toolVersion: stringOf(producer.version, "dump.provenance.producer.version"),
    compilerVersion: stringOf(
      producer.typescript,
      "dump.provenance.producer.typescript",
    ),
    universe: universeOf(provenance.universe),
    capabilities: [...new Set(capabilities)].sort(compareOrdinal),
  };
}

const DIAGNOSTIC_SEVERITIES = new Set(["error", "warning"]);

function diagnosticsOf(
  value: unknown,
  manifest: ReadonlyMap<string, IBulkGraphSession.ISourceDigest>,
): ISamchonGraphDiagnostic[] {
  const raw = arrayOf(value, "dump.diagnostics");
  return raw.map((item, index) => {
    const label = `dump.diagnostics[${index}]`;
    const entry = objectOf(item, label);
    const file = stringOf(entry.file, `${label}.file`);
    const fileless = file === "";
    if (!fileless) {
      validateGraphFile(file, `${label}.file`, true);
      // The same one-program test the facts pass. A finding about a file the
      // program never loaded did not come from this generation, and a checker
      // that reports one is not describing the graph shipped beside it.
      if (!manifest.has(file)) {
        throw new Error(
          `ttscgraph: ${label} reports ${file}, which the dump's own source manifest never loaded`,
        );
      }
    }
    const severity = stringOf(entry.category, `${label}.category`);
    if (!DIAGNOSTIC_SEVERITIES.has(severity)) {
      throw new Error(`ttscgraph: unsupported ${label}.category: ${severity}`);
    }
    return {
      file,
      line: fileless
        ? zeroOf(entry.line, `${label}.line`)
        : integerOf(entry.line, `${label}.line`),
      column: fileless
        ? zeroOf(entry.column, `${label}.column`)
        : integerOf(entry.column, `${label}.column`),
      code: integerOf(entry.code, `${label}.code`),
      message: stringOf(entry.message, `${label}.message`),
      severity: severity as ISamchonGraphDiagnostic["severity"],
    };
  });
}

/**
 * A producer that does not claim `diagnostics` has none to give, and the graph
 * says so out loud rather than shipping an empty list that reads as a clean
 * bill of health. Findings sent without the claim are refused outright: a
 * producer whose envelope and payload disagree is one this client cannot quote.
 */
function refuseDiagnostics(
  value: unknown,
  warnings: string[],
): ISamchonGraphDiagnostic[] {
  if (arrayOf(value, "dump.diagnostics").length !== 0) {
    throw new Error(
      `ttscgraph: dump carries diagnostics although the producer does not claim the ${ITtscGraphSnapshot.CAPABILITY_DIAGNOSTICS} capability`,
    );
  }
  warnings.push(
    `typescript: ttscgraph did not collect compiler diagnostics (no ${ITtscGraphSnapshot.CAPABILITY_DIAGNOSTICS} capability); this graph reports none because none were asked for, not because the project has none.`,
  );
  return [];
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function validateDigest(digest: string, label: string): string {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(
      `ttscgraph: ${label} must be a hex-encoded SHA-256: ${digest}`,
    );
  }
  return digest;
}

function stringArrayOf(value: unknown, label: string): string[] {
  return arrayOf(value, label).map((item, index) =>
    stringOf(item, `${label}[${index}]`),
  );
}

const NODE_KINDS = new Set<GraphNodeKind>([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
  "method",
  "module",
]);
/* c8 ignore start -- merging a namespace onto a function compiles to an
 * `X || (X = {})` initialiser, emitted at the closing brace, whose falsy arm
 * cannot run: the function declaration above it is always evaluated first.
 * The constants inside run unconditionally, so nothing testable is hidden. */
export namespace adaptTtscGraphDump {
  /** The registry identity every `ttscgraph` snapshot is published under. */
  export const PROVIDER = "ttscgraph";

  /** What these facts are grounded in: the TypeScript checker itself. */
  export const AUTHORITY: GraphProviderAuthority = "compiler";

  /**
   * The edge families a `ttscgraph` snapshot may carry.
   *
   * Published here because the registry entry declares the same list as this
   * provider's proven facts, and the two must be one statement. A second copy
   * beside the provider would let the adapter accept a family the registry
   * never claimed — or refuse one it did — and a reader comparing a dump's
   * declared facts against its edges would be comparing against the wrong
   * list.
   */
  export const EDGE_KINDS: readonly GraphEdgeKind[] = [
    "exports",
    "calls",
    "accesses",
    "instantiates",
    "type_ref",
    "extends",
    "implements",
    "overrides",
    "renders",
  ];
}
/* c8 ignore stop */

const EDGE_KINDS = new Set<GraphEdgeKind>(adaptTtscGraphDump.EDGE_KINDS);
const MODIFIERS = new Set<NonNullable<ISamchonGraphNode["modifiers"]>[number]>([
  "export",
  "default",
  "declare",
  "abstract",
  "static",
  "readonly",
  "async",
  "const",
  "public",
  "private",
  "protected",
  "internal",
  "optional",
]);

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`ttscgraph: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayOf(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`ttscgraph: ${label} must be an array`);
  }
  return value;
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`ttscgraph: ${label} must be a string`);
  }
  return value;
}

function booleanOf(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`ttscgraph: ${label} must be a boolean`);
  }
  return value;
}

function integerOf(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`ttscgraph: ${label} must be a positive integer`);
  }
  return value as number;
}

function zeroOf(value: unknown, label: string): 0 {
  if (value !== 0) {
    throw new Error(
      `ttscgraph: ${label} must be zero for a fileless diagnostic`,
    );
  }
  return 0;
}

function nodeKindOf(value: unknown, label: string): GraphNodeKind {
  const kind = stringOf(value, label) as GraphNodeKind;
  if (!NODE_KINDS.has(kind)) {
    throw new Error(`ttscgraph: unsupported ${label}: ${kind}`);
  }
  return kind;
}

function edgeKindOf(value: unknown, label: string): GraphEdgeKind {
  const kind = stringOf(value, label) as GraphEdgeKind;
  if (!EDGE_KINDS.has(kind)) {
    throw new Error(`ttscgraph: unsupported ${label}: ${kind}`);
  }
  return kind;
}

function modifierOf(
  value: unknown,
  label: string,
): NonNullable<ISamchonGraphNode["modifiers"]>[number] {
  const modifier = stringOf(value, label) as NonNullable<
    ISamchonGraphNode["modifiers"]
  >[number];
  if (!MODIFIERS.has(modifier)) {
    throw new Error(`ttscgraph: unsupported ${label}: ${modifier}`);
  }
  return modifier;
}

function evidenceOf(
  value: unknown,
  defaultFile: string,
  label: string,
  mustMatchDefaultFile = false,
): ISamchonGraphEvidence {
  const raw = objectOf(value, label);
  const file =
    raw.file === undefined
      ? defaultFile
      : stringOf(raw.file, `${label}.file`);
  validateGraphFile(
    file,
    `${label}.file`,
    defaultFile.startsWith(BUNDLED_FILE_PREFIX),
  );
  if (mustMatchDefaultFile && file !== defaultFile) {
    throw new Error(
      `ttscgraph: ${label}.file must match its owning file: ${defaultFile}`,
    );
  }
  const evidence: ISamchonGraphEvidence = {
    file,
    startLine: integerOf(raw.startLine, `${label}.startLine`),
  };
  if (raw.startCol !== undefined) {
    evidence.startCol = integerOf(raw.startCol, `${label}.startCol`);
  }
  if (raw.endLine !== undefined) {
    evidence.endLine = integerOf(raw.endLine, `${label}.endLine`);
  }
  if (raw.endCol !== undefined) {
    evidence.endCol = integerOf(raw.endCol, `${label}.endCol`);
  }
  if (
    evidence.endCol !== undefined &&
    evidence.endLine === undefined
  ) {
    throw new Error(`ttscgraph: ${label}.endCol requires endLine`);
  }
  if (
    evidence.endLine !== undefined &&
    (evidence.endLine < evidence.startLine ||
      (evidence.endLine === evidence.startLine &&
        evidence.startCol !== undefined &&
        evidence.endCol !== undefined &&
        evidence.endCol < evidence.startCol))
  ) {
    throw new Error(`ttscgraph: ${label} has a reversed range`);
  }
  return evidence;
}

function decoratorsOf(value: unknown, id: string): ISamchonGraphDecorator[] {
  return arrayOf(value, `${id}.decorators`).map((item, index) => {
    const raw = objectOf(item, `${id}.decorators[${index}]`);
    return {
      name: stringOf(raw.name, `${id}.decorators[${index}].name`),
      arguments: arrayOf(
        raw.arguments,
        `${id}.decorators[${index}].arguments`,
      ).map((argument, argumentIndex) => {
        const rawArgument = objectOf(
          argument,
          `${id}.decorators[${index}].arguments[${argumentIndex}]`,
        );
        if (rawArgument.literal === undefined) return {};
        if (
          typeof rawArgument.literal !== "string" &&
          typeof rawArgument.literal !== "number" &&
          typeof rawArgument.literal !== "boolean"
        ) {
          throw new Error(
            `ttscgraph: ${id}.decorators[${index}].arguments[${argumentIndex}].literal must be scalar`,
          );
        }
        return { literal: rawArgument.literal };
      }),
    };
  });
}

function enumMembersOf(
  value: unknown,
  id: string,
): ISamchonGraphNode.IEnumMember[] {
  return arrayOf(value, `${id}.enumMembers`).map((item, index) => {
    const label = `${id}.enumMembers[${index}]`;
    const raw = objectOf(item, label);
    const member: ISamchonGraphNode.IEnumMember = {
      name: stringOf(raw.name, `${label}.name`),
    };
    optionalString(raw.value, `${label}.value`, (entry) => {
      member.value = entry;
    });
    return member;
  });
}

function objectMembersOf(
  value: unknown,
  id: string,
): ISamchonGraphNode.IObjectMember[] {
  return arrayOf(value, `${id}.objectMembers`).map((item, index) => {
    const label = `${id}.objectMembers[${index}]`;
    const raw = objectOf(item, label);
    const kind = stringOf(raw.kind, `${label}.kind`);
    if (kind !== "property" && kind !== "method") {
      throw new Error(`ttscgraph: unsupported ${label}.kind: ${kind}`);
    }
    const member: ISamchonGraphNode.IObjectMember = {
      name: stringOf(raw.name, `${label}.name`),
      kind,
    };
    if (raw.line !== undefined) {
      member.line = integerOf(raw.line, `${label}.line`);
    }
    optionalString(raw.signature, `${label}.signature`, (entry) => {
      member.signature = entry;
    });
    return member;
  });
}

function optionalString(
  value: unknown,
  label: string,
  assign: (value: string) => void,
): void {
  if (value !== undefined) assign(stringOf(value, label));
}

function optionalBoolean(
  value: unknown,
  label: string,
  assign: (value: boolean) => void,
): void {
  if (value !== undefined) assign(booleanOf(value, label));
}

const BUNDLED_FILE_PREFIX = "bundled:///";

function validateGraphFile(
  file: string,
  label: string,
  allowBundled = false,
): void {
  if (allowBundled && isNormalizedBundledFile(file)) return;
  const segments = file.split("/");
  if (
    file === "" ||
    file.includes("\\") ||
    /^[A-Za-z]:\//.test(file) ||
    path.posix.normalize(file) !== file ||
    path.posix.isAbsolute(file) ||
    segments.some((segment, index) =>
      segment === "" ||
      segment === "." ||
      (segment === ".." &&
        segments.slice(index + 1).every((rest) => rest === ".."))
    )
  ) {
    throw new Error(
      `ttscgraph: ${label} must be a normalized schema-v6 path relative to the project: ${file}`,
    );
  }
}

/**
 * Bind compiler diagnostics on tsconfig files to the exact config bytes that
 * the producer already carried in its build-universe proof.
 */
function mergeConfigurationSources(
  manifest: Map<string, IBulkGraphSession.ISourceDigest>,
  value: unknown,
  capabilities: readonly string[],
): void {
  const provenance = objectOf(value, "dump.provenance");
  const universe = objectOf(
    provenance.universe,
    "dump.provenance.universe",
  );
  const configs = arrayOf(
    universe.configs,
    "dump.provenance.universe.configs",
  );
  const hasDiskDigests = capabilities.includes(
    ITtscGraphSnapshot.CAPABILITY_DISK_DIGESTS,
  );
  for (let index = 0; index < configs.length; index++) {
    const label = `dump.provenance.universe.configs[${index}]`;
    const config = objectOf(configs[index], label);
    const file = stringOf(config.file, `${label}.file`);
    validateGraphFile(file, `${label}.file`);
    const digest = validateDigest(
      stringOf(config.digest, `${label}.digest`),
      `${label}.digest`,
    );
    const existing = manifest.get(file);
    if (existing !== undefined) {
      if (
        existing.checkerDigest !== digest ||
        (hasDiskDigests && existing.diskDigest !== digest)
      ) {
        throw new Error(
          `ttscgraph: ${label} disagrees with the source manifest for ${file}`,
        );
      }
      continue;
    }
    manifest.set(file, {
      checkerDigest: digest,
      diskDigest: hasDiskDigests ? digest : "",
    });
  }
}

/**
 * Virtual compiler libraries are the only non-relative schema-v6 identity.
 * They retain their `bundled:///` scheme and can never traverse.
 */
function isNormalizedBundledFile(file: string): boolean {
  if (!file.startsWith(BUNDLED_FILE_PREFIX)) return false;
  const relative = file.slice(BUNDLED_FILE_PREFIX.length);
  return (
    relative !== "" &&
    !relative.includes("\\") &&
    !path.posix.isAbsolute(relative) &&
    path.posix.normalize(relative) === relative &&
    relative
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function sourceManifestKey(project: string, file: string): string {
  return isNormalizedBundledFile(file)
    ? file
    : path.resolve(project, file);
}

function validateNodeId(id: string, file: string, kind: GraphNodeKind): void {
  const parsed = fileOfNodeId.parseLegacy(id);
  if (
    parsed === undefined ||
    parsed.file !== file ||
    parsed.kind !== kind
  ) {
    throw new Error(
      `ttscgraph: node id does not match its file and kind: ${id}`,
    );
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  // Only one arm of this comparison runs on a given operating system.
  /* c8 ignore next 3 */
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
