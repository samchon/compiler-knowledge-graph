import { ITtscGraphSnapshot } from "./ITtscGraphSnapshot";

/**
 * Validate one `ttscgraph serve` frame into {@link ITtscGraphSnapshot}.
 *
 * The version is read before the shape, because a producer speaking another
 * protocol is entitled to another shape. Checking the shape first would report
 * a version mismatch as a field complaint — "response.mode must be one of …" —
 * about a contract the other side never agreed to, which is the misparse the
 * version field exists to prevent. Ask which protocol it is, then hold it to
 * that protocol.
 *
 * Every field the client later branches on is checked here, not cast. The
 * envelope used to be a bare cast whose `mode` was typed `string | undefined`
 * and defaulted to `""`, so the one field that says whether the compiler reused
 * its program or rebuilt it could be absent, wrong, or invented without anybody
 * noticing — and it was, on the error path, where the old producer's
 * `omitempty` dropped it.
 */
export function parseTtscGraphSnapshot(value: unknown): ITtscGraphSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ttscgraph: response must be an object");
  }
  const raw = value as Record<string, unknown>;

  const protocolVersion = raw.protocolVersion;
  if (
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion !== ITtscGraphSnapshot.PROTOCOL_VERSION
  ) {
    throw new Error(
      `ttscgraph: this client speaks serve protocol v${String(
        ITtscGraphSnapshot.PROTOCOL_VERSION,
      )}, but the binary speaks ${
        Number.isSafeInteger(protocolVersion)
          ? `v${String(protocolVersion)}`
          : "an unknown version"
      }. Install a matching ttsc (the binary resolves from the target project, or from TTSC_GRAPH_BINARY).`,
    );
  }

  const id = raw.id;
  if (!Number.isSafeInteger(id)) {
    throw new Error("ttscgraph: response omitted a valid id");
  }
  if (typeof raw.changed !== "boolean") {
    throw new Error("ttscgraph: response.changed must be boolean");
  }
  const mode = raw.mode;
  if (
    typeof mode !== "string" ||
    !ITtscGraphSnapshot.MODES.includes(mode as ITtscGraphSnapshot.Mode)
  ) {
    throw new Error(
      `ttscgraph: response.mode must be one of ${ITtscGraphSnapshot.MODES.join(
        ", ",
      )}: ${String(mode)}`,
    );
  }
  if (raw.error !== undefined && typeof raw.error !== "string") {
    throw new Error("ttscgraph: response.error must be a string");
  }
  const capabilities = raw.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((capability) => typeof capability !== "string")
  ) {
    throw new Error("ttscgraph: response.capabilities must be a string array");
  }

  const base = {
    id: id as number,
    protocolVersion: protocolVersion as number,
    capabilities: capabilities as string[],
  };

  // A frame that says it failed but names no reason, or one that names a reason
  // while claiming to have computed something, is not a frame this client can
  // report honestly either way. Refusing the disagreement here is what lets
  // every reader downstream treat `mode: "error"` and a present `error` as the
  // same fact, and narrow on either.
  if ((raw.error !== undefined) !== (mode === "error")) {
    throw new Error(
      `ttscgraph: response.error and mode ${mode} disagree about whether the request produced a snapshot`,
    );
  }
  if (raw.error !== undefined) {
    // A failure that also claims the graph moved is claiming a snapshot it did
    // not produce; there is no honest reading of it.
    if (raw.changed) {
      throw new Error(
        "ttscgraph: error response cannot also report a changed graph",
      );
    }
    if (raw.dump !== undefined || raw.snapshot !== undefined) {
      throw new Error(
        "ttscgraph: error response unexpectedly included snapshot state",
      );
    }
    return { ...base, mode: "error", error: raw.error, changed: false };
  }

  if ((mode === "unchanged") !== !raw.changed) {
    throw new Error(
      `ttscgraph: response.mode ${mode} contradicts changed ${String(raw.changed)}`,
    );
  }

  // `changed` decides whether a shard transaction rides along; the producer
  // stakes its whole atomicity claim on that pairing, so a frame that breaks it
  // is rejected here rather than surfacing later as absent state.
  if (raw.dump !== undefined) {
    throw new Error(
      "ttscgraph: binary returned a legacy full dump instead of graph snapshot protocol v1; install a matching ttsc",
    );
  }
  if (raw.changed && raw.snapshot === undefined) {
    throw new Error(
      `ttscgraph: changed ${mode} response omitted its native shard transaction`,
    );
  }
  if (!raw.changed && raw.snapshot !== undefined) {
    throw new Error(
      `ttscgraph: unchanged ${mode} response unexpectedly included a native shard transaction`,
    );
  }
  return {
    ...base,
    mode: mode as ITtscGraphSnapshot.ComputationMode,
    changed: raw.changed,
    ...(raw.snapshot === undefined ? {} : { snapshot: raw.snapshot }),
  };
}
