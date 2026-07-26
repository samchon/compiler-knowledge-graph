#!/usr/bin/env node
"use strict";

// A dispatcher shim, like the ones every real toolchain probe actually hits.
//
// `rustc`, `python3`, `ruby`, `java`, and `dotnet` are normally rustup, pyenv,
// rbenv, jenv, or muxer shims: the version they report is decided by the
// working directory and the environment, not by the shim file, and an in-place
// upgrade changes the answer while leaving the file byte-identical. This
// fixture reports whatever `toolchain-version` beside it says, so a test can
// upgrade the toolchain without touching the program.
//
// Launches are logged because counting them is the only way to distinguish a
// probe that ran from one whose answer was reused.

const fs = require("node:fs");
const path = require("node:path");

const log = process.env.SAMCHON_GRAPH_FIXTURE_PROBE_LOG;
if (log !== undefined) fs.appendFileSync(log, `${process.argv.slice(2).join(" ")}\n`);

// Both switches are files rather than environment variables, so a test can flip
// one without changing the environment the probe inherits — which is what a real
// transient failure looks like.
if (fs.existsSync(path.join(process.cwd(), "toolchain-refuse"))) {
  process.stderr.write("fake toolchain: probe refused\n");
  process.exit(1);
}

let version = "1.2.3";
try {
  version = fs.readFileSync(path.join(process.cwd(), "toolchain-version"), "utf8").trim();
} catch {
  // The marker is optional; without one the shim reports its default.
}

// Three lines, like `java --version` and `clang --version`. The lines after the
// first carry facts that decide what a compiled artifact means, so a publisher
// that keeps only the first drops them and one that keeps the newlines puts a
// multi-line value in a single-line provenance field.
process.stdout.write(`fake-toolchain ${version}\n`);
process.stdout.write(`Runtime Environment (build ${version}+7)\n`);
process.stdout.write("64-Bit Server VM\n");
process.exit(0);
