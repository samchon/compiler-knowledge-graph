import { TestValidator } from "@nestia/e2e";

import { runView } from "@samchon/graph";

import { parseGraphArgs } from "../../../../packages/graph/src/parseGraphArgs";

export const test_graph_argument_parser_covers_every_cli_form = async () => {
  const parsed = parseGraphArgs([
    "--cwd",
    "fixture",
    "--mode=lsp",
    "--language",
    "typescript",
    "--language=go",
    "--server",
    "custom-lsp",
    "--server-arg=--stdio",
    "--server-arg",
    "--trace",
    "--lsp-concurrency",
    "4",
    "--lsp-ready-quiet-ms=250",
    "--graph-file",
    "dump.json",
    "--no-strict",
  ]);
  TestValidator.equals("cwd parses", parsed.cwd, "fixture");
  TestValidator.equals("mode parses", parsed.mode, "lsp");
  TestValidator.equals("languages accumulate", parsed.languages, ["typescript", "go"]);
  TestValidator.equals("server parses", parsed.server, "custom-lsp");
  TestValidator.equals("server arguments accumulate", parsed.serverArgs, ["--stdio", "--trace"]);
  TestValidator.equals("integer arguments parse", parsed.lspConcurrency, 4);
  TestValidator.equals("equals integers parse", parsed.lspReadyQuietMs, 250);
  TestValidator.equals("graph files parse", parsed.graphFile, "dump.json");
  // The measurement instrument, not a fallback: every other way of
  // disabling a strict provider works by tripping its refusal, which
  // measures the refusal instead of the lane underneath.
  TestValidator.equals("strict providers can be stood down", parsed.strict, false);

  const equals = parseGraphArgs([
    "--cwd=fixture-two",
    "--mode=static",
    "--server=server-two",
    "--lsp-concurrency=3",
    "--lsp-ready-quiet-ms",
    "300",
    "--graph-file=dump-two.json",
  ]);
  TestValidator.equals("all equals forms parse", equals, {
    cwd: "fixture-two",
    mode: "static",
    server: "server-two",
    lspConcurrency: 3,
    lspReadyQuietMs: 300,
    graphFile: "dump-two.json",
  });

  await TestValidator.error("missing values fail", () => parseGraphArgs(["--cwd"]));
  await TestValidator.error("unknown options fail", () => parseGraphArgs(["--wat"]));
  await TestValidator.error("invalid modes fail", () => parseGraphArgs(["--mode=fast"]));
  await TestValidator.error("invalid languages fail", () => parseGraphArgs(["--language=nope"]));
  await TestValidator.error("unknown is not an explicit language", () =>
    parseGraphArgs(["--language=unknown"]),
  );
  await TestValidator.error("zero integers fail", () => parseGraphArgs(["--lsp-concurrency=0"]));
  await TestValidator.error("fractional integers fail", () =>
    parseGraphArgs(["--lsp-concurrency=1.5"]),
  );
  await TestValidator.error("non-numeric integers fail", () =>
    parseGraphArgs(["--lsp-ready-quiet-ms=nope"]),
  );
  await TestValidator.error("missing viewer values fail", () =>
    runView(["--port"]),
  );
  await TestValidator.error("fractional viewer ports fail", () =>
    runView(["--port=1.5"]),
  );
  await TestValidator.error("out-of-range viewer ports fail", () =>
    runView(["--port=65536"]),
  );
  await TestValidator.error("non-positive viewer caps fail", () =>
    runView(["--max-nodes=0"]),
  );
};
