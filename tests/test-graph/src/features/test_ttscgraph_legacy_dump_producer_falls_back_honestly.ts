import { TestValidator } from "@nestia/e2e";
import { buildGraphDump } from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/**
 * A `ttscgraph` that predates protocol v1 answers a well-formed envelope —
 * right id, `protocolVersion: 1`, `mode: "initial"`, `changed: true` — and
 * carries a complete `dump` where the shard transaction belongs. Nothing in the
 * version pin can see that, so the body is what has to refuse it; and the
 * refusal is worth nothing if the route then reports compiler authority for
 * facts a fallback produced.
 *
 * 1. Point the resolver at a producer that answers the pre-v1 frame.
 * 2. Require the strict route to decline it and say which grade it gave up.
 * 3. Require the fallback to still index, publishing no strict provenance.
 */
export const test_ttscgraph_legacy_dump_producer_falls_back_honestly =
  async () => {
    const root = GraphPaths.createTempDirectory(
      "samchon-graph-ttscgraph-legacy-",
    );
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true },
        include: ["src/**/*.ts"],
      }),
    );
    fs.writeFileSync(
      path.join(root, "src", "model.ts"),
      'export type Status = "ready" | "done";\n',
    );

    // A launchable stand-in for the published binary: the resolver's override
    // takes an absolute spawnable file, and cmd.exe/sh forward the client's
    // own `serve --cwd <root>` through to the fake producer unchanged.
    const windows = process.platform === "win32";
    const shim = path.join(root, windows ? "ttscgraph.cmd" : "ttscgraph");
    fs.writeFileSync(
      shim,
      windows
        ? `@echo off\r\n"${process.execPath}" "${GraphPaths.fakeTtscGraphServer}" --legacy-dump %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${GraphPaths.fakeTtscGraphServer}" --legacy-dump "$@"\n`,
    );
    if (!windows) fs.chmodSync(shim, 0o755);

    const previous = process.env.TTSC_GRAPH_BINARY;
    process.env.TTSC_GRAPH_BINARY = shim;
    try {
      const dump = await buildGraphDump({
        cwd: root,
        mode: "lsp",
        languages: ["typescript"],
      });
      const warnings = dump.warnings ?? [];
      TestValidator.predicate(
        "the legacy full-dump producer is refused rather than adapted",
        warnings.some(
          (warning) =>
            warning.includes("ttscgraph compiler provider failed") &&
            warning.includes("legacy full dump"),
        ),
      );
      // The refusal has to name the grade that was lost. A reader told only
      // that a provider failed cannot tell whether the facts now in hand came
      // from a compiler or from a best-effort text scan.
      TestValidator.predicate(
        "no compiler-owned provenance survives the refusal",
        (dump.provenance ?? []).every((row) => row.provider !== "ttscgraph"),
      );
      TestValidator.predicate(
        "the compatibility fallback still indexes the project source",
        dump.nodes.some((node) => node.file === "src/model.ts"),
      );
    } finally {
      if (previous === undefined) delete process.env.TTSC_GRAPH_BINARY;
      else process.env.TTSC_GRAPH_BINARY = previous;
    }
  };
