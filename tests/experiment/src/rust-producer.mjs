export const RUST_GRAPH_PRODUCER_UNIT_TEST =
  "static_index::tests::graph_covers_trait_generic_async_and_macro_semantics";
export const RUST_GRAPH_PRODUCER_SLOW_TEST =
  "graph_snapshot_covers_semantic_breadth_and_build_universe";

/** Run the two exact acceptance fixtures and reject Cargo's zero-test success. */
export function verifyRustGraphProducer({
  cargo,
  producerRoot,
  run,
  emit = emitTestOutput,
}) {
  const tests = [
    {
      label: "Rust HIR unit fixture",
      args: [
        "test",
        "--locked",
        "--release",
        "-p",
        "ide",
        "--lib",
        RUST_GRAPH_PRODUCER_UNIT_TEST,
        "--",
        "--exact",
      ],
    },
    {
      label: "Rust HIR slow fixture",
      args: [
        "test",
        "--locked",
        "--release",
        "-p",
        "rust-analyzer",
        "--test",
        "slow-tests",
        RUST_GRAPH_PRODUCER_SLOW_TEST,
        "--",
        "--exact",
      ],
      env: { RUN_SLOW_TESTS: "1" },
    },
  ];
  for (const test of tests) {
    const result = run(cargo, test.args, {
      cwd: producerRoot,
      stdio: "pipe",
      check: false,
      ...(test.env === undefined ? {} : { env: test.env }),
    });
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    emit(stdout, stderr);
    if (result.status !== undefined && result.status !== 0) {
      throw new Error(
        `${test.label} failed at the pinned producer commit with exit code ${String(result.status)}`,
      );
    }
    const summaries = `${stdout}\n${stderr}`.match(
      /(?:^|\r?\n)test result: ok\. 1 passed; 0 failed;/gu,
    );
    if (summaries?.length !== 1) {
      throw new Error(
        `${test.label} did not run exactly one passing test at the pinned producer commit`,
      );
    }
  }
}

function emitTestOutput(stdout, stderr) {
  if (stdout !== "") process.stdout.write(stdout);
  if (stderr !== "") process.stderr.write(stderr);
}
