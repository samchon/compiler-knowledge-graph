import { TestValidator } from "@nestia/e2e";

// `TtscGraphClient` is internal to the package, so it is reached by path rather
// than through the public barrel.
import { TtscGraphClient } from "../../../../packages/graph/src/provider/ttscgraph/TtscGraphClient";
import { GraphPaths } from "../internal/GraphPaths";

/**
 * The faults a live serve stream can inflict that the envelope parser never
 * sees.
 *
 * Every malformed *envelope* — a non-object, a missing id, a wrong-typed field,
 * a changed frame with no dump — is now proved directly against the parser in
 * `test_ttscgraph_serve_envelope_is_validated_before_it_is_routed`, which can
 * feed it frames a fake server emitting one shape per process cannot. What only
 * a live stream can produce, and so is proved here, is the client's own reaction
 * to conditions the parser is never handed: a line that is not JSON at all, a
 * well-formed frame routed to an id nobody awaits, and a first answer that
 * claims an unchanged snapshot when none has been published yet. Each must fail
 * the refresh loudly and leave the client with no snapshot and generation zero —
 * never a silently empty success.
 */
export const test_ttscgraph_provider_rejects_malformed_serve_responses =
  async () => {
    const root = GraphPaths.createTempDirectory("samchon-graph-ttscgraph-bad-");

    // A non-JSON serve line is a framing fault the client parses itself, so it
    // is surfaced as an error rather than resolving a request.
    // The line itself has to travel with the error. "invalid NDJSON" is true of
    // every possible cause, and what a producer printed onto its protocol stream
    // — a stack trace, a deprecation notice, a shell error — is the diagnosis.
    const shortLine = await assertRejected(
      root,
      "--nonjson",
      "a non-JSON serve line",
    );
    TestValidator.predicate(
      "a short stray line is reported whole",
      shortLine.includes("this is not a ttscgraph frame") &&
        !shortLine.includes("…"),
    );
    // Bounded, because this stream is also the artifact channel and a partial
    // snapshot is not something to put in an error message.
    const longLine = await assertRejected(
      root,
      "--nonjson-long",
      "an oversized non-JSON serve line",
    );
    TestValidator.predicate(
      "an oversized stray line is cut and marked",
      longLine.includes("NOT-A-FRAME") &&
        longLine.includes("…") &&
        longLine.length < 1000,
    );
    await assertRejected(
      root,
      ["--nonjson", "--late-after-nonjson"],
      "late output from a retired protocol generation",
    );
    // A well-formed frame carrying an id no request is waiting on cannot be
    // routed, and an unroutable frame fails every outstanding request rather
    // than hanging until the process exits.
    await assertRejected(root, "--unknown-id", "a response with an unsolicited id");
    // A first unchanged response has no prior snapshot to reuse; the client
    // refuses to publish one it never received.
    await assertRejected(
      root,
      "--first-unchanged",
      "a first unchanged response with no prior snapshot",
    );
  };

async function assertRejected(
  root: string,
  serveFlag: string | readonly string[],
  label: string,
): Promise<string> {
  let message = "";
  const client = new TtscGraphClient({
    root,
    command: process.execPath,
    args: [
      GraphPaths.fakeTtscGraphServer,
      ...(typeof serveFlag === "string" ? [serveFlag] : serveFlag),
    ],
  });
  try {
    let error: unknown;
    try {
      await client.refresh();
    } catch (caught) {
      error = caught;
    }
    TestValidator.predicate(`${label} fails the refresh`, error instanceof Error);
    message = error instanceof Error ? error.message : String(error);
    TestValidator.predicate(
      `${label} publishes no snapshot`,
      client.current === undefined && client.generation === 0,
    );
  } finally {
    await client.close();
  }
  return message;
}
