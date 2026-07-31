import { TestValidator } from "@nestia/e2e";

import { ITtscGraphSnapshot } from "../../../../packages/graph/src/provider/ttscgraph/ITtscGraphSnapshot";
import { parseTtscGraphSnapshot } from "../../../../packages/graph/src/provider/ttscgraph/parseTtscGraphSnapshot";

/**
 * The envelope is a contract with another repository's prebuilt binary, so every
 * field it carries is checked rather than cast.
 *
 * The frames below are the ones a fake server cannot usefully produce: a fake
 * that emits a malformed envelope on every request cannot also exercise the
 * happy path, and one that emits a well-formed one — which is what the fake
 * `ttscgraph` does, because it stands in for a correct producer — never reaches
 * any of this. Calling the parser directly is the only way these branches are
 * reachable at all, and each is a real frame some version of the binary could
 * send: `mode` was `omitempty` upstream until v1, so a dropped mode is exactly
 * what the previous producer did on the error path.
 */
export const test_ttscgraph_serve_envelope_is_validated_before_it_is_routed =
  async () => {
    const base = {
      id: 1,
      protocolVersion: ITtscGraphSnapshot.PROTOCOL_VERSION,
      capabilities: ["universe", "sourceDigests"],
    };

    // A frame the producer answered, with the graph unmoved.
    const unchanged = parseTtscGraphSnapshot({
      ...base,
      mode: "unchanged",
      changed: false,
    });
    TestValidator.equals("an unchanged frame keeps its reported mode", unchanged.mode, "unchanged");
    TestValidator.equals(
      "an unchanged frame carries no shard transaction",
      unchanged.snapshot,
      undefined,
    );
    TestValidator.equals(
      "the envelope's capabilities survive parsing",
      unchanged.capabilities,
      ["universe", "sourceDigests"],
    );

    const changed = parseTtscGraphSnapshot({
      ...base,
      mode: "rebuild",
      changed: true,
      snapshot: { any: "body" },
    });
    TestValidator.equals(
      "a changed frame keeps the compiler's own word for what it did",
      changed.mode,
      "rebuild",
    );
    TestValidator.equals(
      "a changed frame hands its shard transaction on untouched, for the store to judge",
      changed.snapshot,
      { any: "body" },
    );

    const failed = parseTtscGraphSnapshot({
      ...base,
      mode: "error",
      changed: false,
      error: "boom",
    });
    TestValidator.equals("an error frame reports the error mode", failed.mode, "error");
    TestValidator.equals("an error frame carries its reason", failed.error, "boom");

    // The version is read before the shape. A producer on another protocol is
    // entitled to another shape, so a version complaint must not arrive dressed
    // as a field complaint about a contract the other side never agreed to.
    rejects("a frame that is not an object", null);
    rejects("an array frame", []);
    rejects("a frame from a producer that predates the version field", {
      id: 1,
      changed: false,
      mode: "unchanged",
    });
    rejects("a producer below the pinned protocol", {
      ...base,
      protocolVersion: 0,
      mode: "unchanged",
      changed: false,
    });
    rejects("a non-integer protocol version", {
      ...base,
      protocolVersion: 1.5,
      mode: "unchanged",
      changed: false,
    });
    // A version complaint names the versions, so the reader knows which half of
    // the pair to move rather than being told a field is wrong.
    const protocolReason = reason({
      ...base,
      protocolVersion: 0,
      mode: "unchanged",
      changed: false,
    });
    TestValidator.predicate(
      "the protocol error names both versions and how to fix the pair",
      protocolReason.includes("this client speaks serve protocol v1") &&
        protocolReason.includes("Install a matching ttsc"),
    );

    // Upstream moves the protocol number for additions, removals, and semantic
    // changes. A field validator cannot distinguish an additive v2 from a v2
    // that kept the JSON type but changed its meaning, so both directions fail
    // closed until this client deliberately adopts the new contract.
    rejects("a producer above the pinned protocol", {
      ...base,
      protocolVersion: ITtscGraphSnapshot.PROTOCOL_VERSION + 1,
      mode: "unchanged",
      changed: false,
      somethingNew: true,
    });

    rejects("a frame with no id to route it back to its caller", {
      ...base,
      id: undefined,
      mode: "unchanged",
      changed: false,
    });
    rejects("a non-boolean changed flag", {
      ...base,
      mode: "unchanged",
      changed: "yes",
    });
    rejects("a mode the wire does not define", {
      ...base,
      mode: "partial",
      changed: false,
    });
    rejects("a frame whose mode was dropped", { ...base, changed: false });
    rejects("a non-string error", {
      ...base,
      mode: "error",
      changed: false,
      error: 500,
    });
    rejects("capabilities that are not a list", {
      ...base,
      capabilities: "universe",
      mode: "unchanged",
      changed: false,
    });
    rejects("a capability that is not a string", {
      ...base,
      capabilities: ["universe", 7],
      mode: "unchanged",
      changed: false,
    });

    // `error` and `mode: "error"` are one fact stated twice, and a frame where
    // they disagree has no honest reading. Refusing it here is what lets every
    // reader downstream narrow on either one.
    rejects("a failure that forgot to say it failed", {
      ...base,
      mode: "unchanged",
      changed: false,
      error: "boom",
    });
    rejects("an error mode with no reason", {
      ...base,
      mode: "error",
      changed: false,
    });
    rejects("a failure that also claims the graph moved", {
      ...base,
      mode: "error",
      changed: true,
      error: "boom",
    });
    rejects("a failure that also carries a dump", {
      ...base,
      mode: "error",
      changed: false,
      error: "boom",
      dump: {},
    });

    // `changed` decides whether a shard transaction rides along. The producer
    // stakes its atomicity claim on that pairing, so a broken one is refused
    // here rather than surfacing later as absent state.
    rejects("a changed frame with no shard transaction", {
      ...base,
      mode: "initial",
      changed: true,
    });
    rejects("an unchanged frame carrying a shard transaction anyway", {
      ...base,
      mode: "unchanged",
      changed: false,
      snapshot: {},
    });
    rejects("an unchanged mode that claims the graph moved", {
      ...base,
      mode: "unchanged",
      changed: true,
      snapshot: {},
    });
    rejects("a rebuild mode that claims nothing moved", {
      ...base,
      mode: "rebuild",
      changed: false,
    });
  };

function reason(frame: unknown): string {
  try {
    parseTtscGraphSnapshot(frame);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

function rejects(label: string, frame: unknown): void {
  let error: unknown;
  try {
    parseTtscGraphSnapshot(frame);
  } catch (caught) {
    error = caught;
  }
  TestValidator.predicate(`${label} is refused`, error instanceof Error);
}
