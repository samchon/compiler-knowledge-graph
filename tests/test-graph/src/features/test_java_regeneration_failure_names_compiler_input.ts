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
    const current = path.join(target, "CURRENT");
    const coldGeneration = "b".repeat(64);
    const coldCommitted = path.join(target, "generations", coldGeneration);
    const coldInvocation = path.join(
      coldCommitted,
      ".universe",
      `${"c".repeat(64)}.args.d`,
      `${"d".repeat(64)}.args`,
    );
    fs.mkdirSync(path.dirname(coldInvocation), { recursive: true });
    fs.writeFileSync(current, `${coldGeneration}\n`);
    fs.writeFileSync(
      path.join(coldCommitted, "UNIVERSE"),
      "java.version=21\ncompilerTarget=first\n",
    );
    fs.writeFileSync(
      coldInvocation,
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

    const retryGeneration = "f".repeat(64);
    const retryCommitted = path.join(target, "generations", retryGeneration);
    const retryInvocation = path.join(
      retryCommitted,
      ".universe",
      `${"c".repeat(64)}.args.d`,
      `${"d".repeat(64)}.args`,
    );
    fs.mkdirSync(path.dirname(retryInvocation), { recursive: true });
    fs.writeFileSync(current, `${retryGeneration}\n`);
    fs.writeFileSync(
      path.join(retryCommitted, "UNIVERSE"),
      "java.version=21\ncompilerTarget=retry\n",
    );
    fs.writeFileSync(
      retryInvocation,
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
    TestValidator.equals(
      "added compiler input is named",
      firstEvidenceDifference(["row-a"], ["row-a", "row-b"]),
      "missing -> row-b",
    );
    const longPrefix = "x".repeat(500);
    const longDifference = firstEvidenceDifference(
      [`${longPrefix}OLD`],
      [`${longPrefix}NEW`],
    );
    TestValidator.predicate(
      "difference after the diagnostic bound stays visible",
      longDifference.includes("OLD") &&
        longDifference.includes("NEW") &&
        longDifference.includes("...") &&
        longDifference.length <= 964,
    );
    const unicodePrefix = "😀".repeat(250);
    const unicodeDifference = firstEvidenceDifference(
      [`${unicodePrefix}OLD${unicodePrefix}`],
      [`${unicodePrefix}NEW${unicodePrefix}`],
    );
    TestValidator.predicate(
      "bounded diagnostics preserve Unicode code points",
      unicodeDifference.includes("OLD") &&
        unicodeDifference.includes("NEW") &&
        unicodeDifference.includes("...") &&
        unicodeDifference.length <= 964 &&
        hasNoLoneSurrogate(unicodeDifference),
    );
    TestValidator.error(
      "store root cannot escape the isolated corpus",
      () => captureGenerationEvidence(root, ".."),
      Error,
    );
    const foreign = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-java-universe-foreign-"),
    );
    try {
      const compiler = path.join(retryCommitted, ".universe");
      fs.rmSync(compiler, { force: true, recursive: true });
      if (process.platform === "win32") {
        fs.symlinkSync(foreign, compiler, "junction");
      } else {
        fs.symlinkSync(foreign, compiler, "dir");
      }
      TestValidator.error(
        "compiler universe cannot escape through a link",
        () => captureGenerationEvidence(root, "target/scip-targetroot"),
        Error,
      );
    } finally {
      fs.rmSync(foreign, { force: true, recursive: true });
    }
    fs.writeFileSync(current, "not-a-generation\n");
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

function hasNoLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
