import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  captureGenerationEvidence,
  firstEvidenceDifference,
} from "../../../experiment/src/regeneration-evidence.mjs";

/** Java regeneration diagnostics must expose the exact producer input row. */
export const test_java_regeneration_failure_names_compiler_input = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-java-universe-"));
  try {
    const store = path.join(root, "target", "scip-targetroot");
    const target = path.join(
      store,
      "META-INF",
      "scip-graph-store",
      "targets",
      "a".repeat(64),
    );
    const generation = "b".repeat(64);
    const committed = path.join(target, "generations", generation);
    const invocation = path.join(
      committed,
      ".universe",
      `${"c".repeat(64)}.args.d`,
      `${"d".repeat(64)}.args`,
    );
    fs.mkdirSync(path.dirname(invocation), { recursive: true });
    fs.writeFileSync(path.join(target, "CURRENT"), `${generation}\n`);
    fs.writeFileSync(
      path.join(committed, "UNIVERSE"),
      "java.version=21\ncompilerTarget=first\n",
    );
    fs.writeFileSync(
      invocation,
      [
        "@invocation",
        "@plugin",
        Buffer.from("e".repeat(64)).toString("base64url"),
        encodedIdentity("-classpath", "first.jar"),
        "",
      ].join("\n"),
    );

    const cold = captureGenerationEvidence(root, "target/scip-targetroot");
    TestValidator.predicate(
      "normalized compiler input is decoded",
      cold.some((row: string) =>
        row.endsWith('v1|literal:"-classpath"|tool|literal:"first.jar"'),
      ),
    );

    fs.writeFileSync(
      invocation,
      [
        "@invocation",
        "@plugin",
        Buffer.from("e".repeat(64)).toString("base64url"),
        encodedIdentity("-classpath", "retry.jar"),
        "",
      ].join("\n"),
    );
    const retry = captureGenerationEvidence(root, "target/scip-targetroot");
    const difference = firstEvidenceDifference(cold, retry);
    TestValidator.predicate(
      "first moved compiler input is actionable",
      difference.includes('first.jar"') && difference.includes('retry.jar"'),
    );
    TestValidator.error(
      "store root cannot escape the isolated corpus",
      () => captureGenerationEvidence(root, ".."),
      Error,
    );
    fs.writeFileSync(path.join(target, "CURRENT"), "not-a-generation\n");
    TestValidator.error(
      "malformed current generation is rejected",
      () => captureGenerationEvidence(root, "target/scip-targetroot"),
      Error,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
};

function encodedIdentity(prefix: string, suffix: string): string {
  const literal = (value: string): string =>
    Buffer.from(value, "utf8").toString("base64url");
  return Buffer.from(
    `v1|literal:${literal(prefix)}|tool|literal:${literal(suffix)}`,
    "utf8",
  ).toString("base64url");
}
