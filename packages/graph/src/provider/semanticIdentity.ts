import { createHash } from "node:crypto";

import { ISamchonGraphNode } from "../structures";
import { GraphLanguage, GraphNodeKind } from "../typings";

/**
 * The provider-owned facts from which a semantic node id is derived.
 *
 * This record is deliberately not carried on {@link ISamchonGraphNode}. It is
 * an indexing input, not an MCP result, so the application contract remains
 * identical to the canonical ttsc contract. The resulting id is the durable
 * wire fact.
 */
export interface IGraphSemanticIdentity {
  version: 2;
  language: GraphLanguage;
  symbol: string;
  role: GraphNodeKind;
  native?: IGraphSemanticIdentity.INative;
  scope?: IGraphSemanticIdentity.IScope;
  overload?: string;
  stability: "persistent" | "generation";
  generation?: string;
}

export namespace IGraphSemanticIdentity {
  /** A provider symbol and whether edits can reorder its key. */
  export interface INative {
    key: string;
    stability: "semantic" | "positional";
  }

  /** Build coordinates that are part of identity, not provider provenance. */
  export interface IScope {
    module?: string;
    target?: string;
    translationUnit?: string;
    document?: string;
  }
}

/** Derive a deterministic public id from one validated semantic identity. */
export function semanticGraphNodeId(
  identity: IGraphSemanticIdentity,
  displayName: string,
): string {
  validateIdentity(identity);
  if (displayName === "") {
    throw new Error("@samchon/graph: semantic identity display name is empty");
  }
  const prefix = identity.stability === "persistent" ? "@v2" : "@g2";
  return `${prefix}/${identity.language}/${semanticIdentityDigest(identity, displayName)}#${encodeURIComponent(displayName)}:${identity.role}`;
}

/** Full SHA-256 of the length-prefixed identity fields. */
export function semanticIdentityDigest(
  identity: IGraphSemanticIdentity,
  displayName?: string,
): string {
  validateIdentity(identity);
  const fields: Array<readonly [string, string]> = [
    ["version", String(identity.version)],
    ["language", identity.language],
    ["role", identity.role],
    ["symbol", identity.symbol],
    ["stability", identity.stability],
  ];
  append(fields, "scope.module", identity.scope?.module);
  append(fields, "scope.target", identity.scope?.target);
  append(fields, "scope.translationUnit", identity.scope?.translationUnit);
  append(fields, "scope.document", identity.scope?.document);
  append(fields, "overload", identity.overload);
  if (identity.native !== undefined) {
    fields.push(["native.stability", identity.native.stability]);
    if (
      identity.native.stability === "semantic" ||
      identity.stability === "generation"
    ) {
      fields.push(["native.key", identity.native.key]);
    }
  }
  append(fields, "generation", identity.generation);
  append(fields, "display", displayName);
  const encoded = fields
    .flatMap(([name, value]) => [lengthPrefix(name), lengthPrefix(value)])
    .join("");
  return createHash("sha256").update(encoded).digest("hex");
}

/** True for an intrinsic persistent or explicitly generation-scoped id. */
export function isSemanticGraphNodeId(id: string): boolean {
  return SEMANTIC_NODE_ID.test(id);
}

/** Fail closed when a semantic id contradicts its node's language or kind. */
export function validateSemanticGraphNode(
  node: Pick<
    ISamchonGraphNode,
    "id" | "language" | "kind" | "name" | "qualifiedName"
  >,
): void {
  if (!isSemanticGraphNodeId(node.id)) return;
  const match = SEMANTIC_NODE_ID.exec(node.id)!;
  let display: string;
  try {
    display = decodeURIComponent(match[4]!);
  } catch {
    throw new Error(
      `@samchon/graph: semantic node id has an invalid display escape: ${node.id}`,
    );
  }
  if (
    match[2] !== node.language ||
    match[5] !== node.kind ||
    encodeURIComponent(display) !== match[4] ||
    display !== (node.qualifiedName ?? node.name)
  ) {
    throw new Error(
      `@samchon/graph: semantic node id does not match its language, kind, and display: ${node.id}`,
    );
  }
}

/**
 * Legacy file-qualified handles by which a v2 node used to be addressed.
 *
 * A decorated callable also advertises its undecorated base. That alias is
 * intentionally one-to-many for overloads; the resolver returns deterministic
 * candidates rather than silently choosing one.
 */
export function legacyGraphNodeIds(node: ISamchonGraphNode): string[] {
  if (!isSemanticGraphNodeId(node.id)) return [];
  const files = new Set<string>([
    node.file,
    ...(node.evidence?.file === undefined ? [] : [node.evidence.file]),
    ...(node.implementation?.file === undefined
      ? []
      : [node.implementation.file]),
  ]);
  files.delete("");
  const exact = node.qualifiedName ?? node.name;
  const names = new Set([exact]);
  if (CALLABLE_KINDS.has(node.kind)) names.add(callableBaseOf(exact));
  return [...files]
    .flatMap((file) =>
      [...names].map((name) => `${file}#${name}:${node.kind}`),
    )
    .sort(compareText);
}

/** The stable callable spelling before a provider's parameter decoration. */
export function callableBaseOf(name: string): string {
  const open = name.indexOf("(");
  return open <= 0 ? name : name.slice(0, open).trimEnd();
}

/** Signature-aware member key used for override and implementation pairing. */
export function semanticMemberKey(node: ISamchonGraphNode): string {
  return normalizeSignature(node.name);
}

function validateIdentity(identity: IGraphSemanticIdentity): void {
  if (identity.version !== 2) {
    throw new Error("@samchon/graph: unsupported semantic identity version");
  }
  for (const [label, value] of [
    ["language", identity.language],
    ["symbol", identity.symbol],
    ["role", identity.role],
  ] as const) {
    if (value === "") {
      throw new Error(`@samchon/graph: semantic identity ${label} is empty`);
    }
  }
  if (identity.native?.key === "") {
    throw new Error("@samchon/graph: semantic identity native key is empty");
  }
  if (
    identity.stability === "persistent" &&
    identity.native?.stability === "positional" &&
    identity.overload === undefined
  ) {
    throw new Error(
      "@samchon/graph: positional provider identities require a structural overload discriminator",
    );
  }
  if (
    identity.stability === "generation" &&
    (identity.generation === undefined || identity.generation === "")
  ) {
    throw new Error(
      "@samchon/graph: generation-scoped identities require a generation key",
    );
  }
  if (
    identity.native?.key.startsWith("local ") === true &&
    identity.scope?.document === undefined
  ) {
    throw new Error(
      "@samchon/graph: document-local provider identities require document scope",
    );
  }
}

function append(
  fields: Array<readonly [string, string]>,
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined) fields.push([name, value]);
}

function lengthPrefix(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function normalizeSignature(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compareText(left: string, right: string): number {
  // Two-way: callers sort distinct ids or handles, so the equal arm cannot run,
  // and an ignore directive over it would take the two reachable arms out of
  // the coverage gate with it -- which is how a reversed ordering stops being a
  // failing test.
  return left < right ? -1 : 1;
}

const SEMANTIC_NODE_ID = /^@(v2|g2)\/([^/]+)\/([0-9a-f]{64})#([^#]+):([^:]+)$/;

const CALLABLE_KINDS = new Set<GraphNodeKind>([
  "function",
  "method",
  "constructor",
]);
