import { TestValidator } from "@nestia/e2e";

import { measureLifecyclePerformance } from "../../../experiment/src/lifecycle-performance.mjs";

/** Sampling must preserve resident identity on no-op and restore source state. */
export const test_strict_lifecycle_performance_sampling_is_atomic = async () => {
  const original = "fn run() { channel(1); }";
  let text = original;
  let current = { generation: "initial" };
  let identity = "initial";
  let edited = false;
  const writes: string[] = [];
  const load = async () => {
    if (text === original) {
      if (edited) {
        current = { generation: "restored" };
        identity = "initial";
        return {
          dump: current,
          identity,
          mode: "incremental",
          elapsedMs: 20,
        };
      }
      return {
        dump: current,
        identity,
        mode: "unchanged",
        elapsedMs: 5,
      };
    }
    edited = true;
    current = { generation: text };
    identity = text;
    return {
      dump: current,
      identity,
      mode: "incremental",
      elapsedMs: text.includes("channel(2)") ? 10 : 20,
    };
  };
  const measured = await measureLifecyclePerformance({
    language: "fixture",
    sourceText: original,
    editFind: "channel(1)",
    editReplacements: ["channel(2)", "channel(3)"],
    noopSamples: 2,
    editSamples: 4,
    noopP95MaxMs: 250,
    editP95MaxMs: 2_000,
    changedModes: ["incremental"],
    currentDump: current,
    currentIdentity: identity,
    writeSource: (next: string) => {
      text = next;
      writes.push(next);
    },
    load,
  });
  TestValidator.equals(
    "performance sampling alternates body edits and restores the original",
    writes,
    [
      "fn run() { channel(2); }",
      "fn run() { channel(3); }",
      "fn run() { channel(2); }",
      "fn run() { channel(3); }",
      original,
    ],
  );
  TestValidator.equals(
    "performance sampling reports every observation and nearest-rank p95",
    measured.row,
    {
      name: "performance",
      status: "passed",
      noopSamples: [5, 5],
      editSamples: [10, 20, 10, 20],
      noopP95Ms: 5,
      editP95Ms: 20,
      noopP95MaxMs: 250,
      editP95MaxMs: 2_000,
    },
  );
  TestValidator.equals(
    "performance sampling returns the restored resident generation",
    [measured.dump, measured.identity, text],
    [current, "initial", original],
  );

  let staleText = original;
  let staleEdited = false;
  const staleInitial = { generation: "stale-initial" };
  await TestValidator.error(
    "restoring source text refuses a stale edited provenance identity",
    () =>
      measureLifecyclePerformance({
        language: "fixture",
        sourceText: original,
        editFind: "channel(1)",
        editReplacements: ["channel(2)", "channel(3)"],
        noopSamples: 1,
        editSamples: 1,
        noopP95MaxMs: 250,
        editP95MaxMs: 2_000,
        changedModes: ["incremental"],
        currentDump: staleInitial,
        currentIdentity: "stale-initial",
        writeSource: (next: string) => {
          staleText = next;
        },
        load: async () => {
          if (!staleEdited) {
            staleEdited = staleText !== original;
            if (!staleEdited) {
              return {
                dump: staleInitial,
                identity: "stale-initial",
                mode: "unchanged",
                elapsedMs: 5,
              };
            }
          }
          return {
            dump: { generation: staleText },
            identity: "edited-stale",
            mode: "incremental",
            elapsedMs: 10,
          };
        },
      }),
  );

  text = original;
  current = { generation: "threshold" };
  identity = "initial";
  edited = false;
  let thresholdError: unknown;
  try {
    await measureLifecyclePerformance({
      language: "fixture",
      sourceText: original,
      editFind: "channel(1)",
      editReplacements: ["channel(2)", "channel(3)"],
      noopSamples: 1,
      editSamples: 1,
      noopP95MaxMs: 5,
      editP95MaxMs: 2_000,
      changedModes: ["incremental"],
      currentDump: current,
      currentIdentity: identity,
      writeSource: (next: string) => {
        text = next;
      },
      load,
    });
  } catch (error) {
    thresholdError = error;
  }
  TestValidator.predicate(
    "a sample at the strict less-than ceiling rejects the row",
    thresholdError instanceof Error &&
      thresholdError.message.includes("lifecycle performance missed its target"),
  );
  let invalidConfigurationError: unknown;
  try {
    await measureLifecyclePerformance({
      language: "fixture",
      sourceText: original,
      editFind: "absent()",
      editReplacements: ["channel(2)", "channel(3)"],
      noopSamples: 1,
      editSamples: 1,
      noopP95MaxMs: 250,
      editP95MaxMs: 2_000,
      changedModes: ["incremental"],
      currentDump: { generation: "invalid-config" },
      currentIdentity: "invalid-config",
      writeSource: () => {
        throw new Error("invalid configuration reached writeSource");
      },
      load: async () => {
        throw new Error("invalid configuration reached load");
      },
    });
  } catch (error) {
    invalidConfigurationError = error;
  }
  TestValidator.predicate(
    "sampling rejects a replacement that cannot edit the source",
    invalidConfigurationError instanceof Error &&
      invalidConfigurationError.message ===
        "fixture: lifecycle performance requires two real body-edit replacements",
  );
};
