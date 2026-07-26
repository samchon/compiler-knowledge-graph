#!/usr/bin/env node
"use strict";

// A toolchain whose version probe is observable and can be made to fail.
//
// Counting launches is the only way to prove a probe did not run: an assertion
// on the returned row passes just as well when the tool was relaunched and gave
// the same answer, which is exactly the cost this fixture exists to catch.

const fs = require("node:fs");

const log = process.env.SAMCHON_GRAPH_FIXTURE_PROBE_LOG;
if (log !== undefined) fs.appendFileSync(log, `${process.argv.slice(2).join(" ")}\n`);

if (process.env.SAMCHON_GRAPH_FIXTURE_PROBE_FAIL === "1") {
  process.stderr.write("fake toolchain: probe refused\n");
  process.exit(1);
}

// Three lines, like `java --version` and `clang --version`. The lines after the
// first carry facts that decide what a compiled artifact means, so a publisher
// that keeps only the first drops them and one that keeps the newlines puts a
// multi-line value in a single-line provenance field.
process.stdout.write("fake-toolchain 1.2.3\n");
process.stdout.write("Runtime Environment (build 1.2.3+7)\n");
process.stdout.write("64-Bit Server VM\n");
process.exit(0);
