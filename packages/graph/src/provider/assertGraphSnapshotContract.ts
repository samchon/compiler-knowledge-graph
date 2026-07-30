import path from "node:path";

import { GraphLanguage } from "../typings";
import { assertGraphSnapshotPayload } from "./assertGraphSnapshotPayload";
import { GraphSnapshotProtocol } from "./GraphSnapshotProtocol";
import { IBulkGraphSession } from "./IBulkGraphSession";
import { IGraphProvider } from "./IGraphProvider";

/**
 * Hold a published snapshot to the contract its provider registered.
 *
 * A provider states what it owns and what it can prove before it runs. Without
 * this check those statements are decoration: a payload could carry a `calls`
 * edge from a provider registered to prove none, or facts for a language this
 * candidate never claimed, and the dump would publish both under a provenance
 * row asserting the opposite. The audit that rides on every MCP result would
 * then be describing a graph that does not exist.
 *
 * Rejecting is right rather than dropping the offending facts. A provider that
 * publishes outside its declared contract has a defect, and quietly deleting
 * its surplus edges would leave a snapshot that is neither what the provider
 * produced nor what it promised — and would hide the defect from the only
 * party positioned to notice it.
 */
export function assertGraphSnapshotContract(
  snapshot: IBulkGraphSession.ISnapshot,
  provider: Pick<IGraphProvider, "name" | "authority" | "facts">,
  languages: readonly GraphLanguage[],
  root: string = process.cwd(),
): void {
  const label = `@samchon/graph: provider "${provider.name}"`;
  const project = path.resolve(root);
  assertGraphSnapshotPayload(snapshot, project, label);
  const claimed = new Set(languages);
  for (const language of snapshot.languages) {
    if (!claimed.has(language)) {
      throw new Error(
        `${label} published a ${language} slice, which this candidate does not own`,
      );
    }
  }

  // A slice replaces its languages whole. A node in a language the slice does
  // not name would be published by this generation and deleted by no later one,
  // because nothing that refreshes this session is responsible for it.
  const nodeIds = new Set<string>();
  const files = new Set<string>();
  for (const node of snapshot.nodes) {
    nodeIds.add(node.id);
    if (node.file !== "") files.add(node.file);
  }

  const provable = new Set(provider.facts);
  for (const edge of snapshot.edges) {
    if (
      (!nodeIds.has(edge.from) && !files.has(edge.from)) ||
      (!nodeIds.has(edge.to) && !files.has(edge.to))
    ) {
      throw new Error(
        `${label} published an edge with an absent endpoint: ${edge.from} -> ${edge.to}`,
      );
    }
    if (!provable.has(edge.kind)) {
      throw new Error(
        `${label} published a "${edge.kind}" edge although it is not registered to prove that family: ${edge.from} -> ${edge.to}`,
      );
    }
  }

  const provenance = snapshot.provenance;
  if (provenance.provider !== provider.name) {
    throw new Error(
      `${label} published provenance attributing its facts to "${provenance.provider}"`,
    );
  }
  if (provenance.authority !== provider.authority) {
    throw new Error(
      `${label} published provenance claiming ${provenance.authority} authority although it is registered as ${provider.authority}`,
    );
  }
  if (!sameFacts(provenance.facts, provider.facts)) {
    throw new Error(
      `${label} published provenance claiming fact families [${provenance.facts.join(", ")}] although it is registered to prove [${provider.facts.join(", ")}]`,
    );
  }

  assertProtocol(snapshot, label);
}

function assertProtocol(
  snapshot: IBulkGraphSession.ISnapshot,
  label: string,
): void {
  const protocol = snapshot.protocol;
  if (protocol === undefined) return;
  if (
    protocol.version !== GraphSnapshotProtocol.VERSION ||
    protocol.generation === "" ||
    protocol.targets.length === 0 ||
    new Set(protocol.targets).size !== protocol.targets.length ||
    !SHA256.test(protocol.manifest) ||
    !SHA256.test(protocol.factDigest) ||
    snapshot.coverage === undefined ||
    snapshot.unresolved === undefined
  ) {
    throw new Error(`${label} published an invalid protocol generation`);
  }
  const shards = new Set<string>();
  for (const shard of protocol.shards) {
    if (
      shard.key === "" ||
      shards.has(shard.key) ||
      !SHA256.test(shard.digest)
    ) {
      throw new Error(`${label} published an invalid protocol shard manifest`);
    }
    shards.add(shard.key);
  }
  if (GraphSnapshotProtocol.factDigest(snapshot) !== protocol.factDigest) {
    throw new Error(`${label} published a mismatched protocol fact digest`);
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

function sameFacts(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  // parseGraphDump has already established that the published family list is
  // unique. The registry is trusted coordinator configuration, but still
  // reject a duplicated entry there: it must not make a distinct published
  // family set appear equivalent by length and membership alone.
  const expected = new Set(right);
  if (expected.size !== right.length) return false;
  return left.every((fact) => expected.has(fact));
}
