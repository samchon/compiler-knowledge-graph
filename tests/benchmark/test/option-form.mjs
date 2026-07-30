import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Every option a workflow passes to a runner must be spelled the way that
 * runner's parser reads it.
 *
 * `index-time.mjs` takes `--name=value`. It special-cases `--project`, and
 * otherwise a bare `--name` is filed as a valueless flag while the token after
 * it becomes a positional — which `selectProjects` then rejects as an unknown
 * project name. Twice now that has cost a whole run: once as
 * `--tools samchon-graph`, which asked for a corpus project called
 * `samchon-graph`, and once as `--publish "$report"` in the collect job, four
 * lines under a comment explaining why the step above it used `=`.
 *
 * The second one is why this exists rather than a third careful reading. It sat
 * in a loop guarded by `nullglob`, so with no reports the loop never ran and the
 * step passed; it would have failed on the first language that ever measured,
 * which is the only run the workflow exists to produce. A mistake that only
 * appears on success is not one review catches.
 *
 * Both vocabularies are read out of the runner rather than restated here. A
 * list maintained beside the parser is a list that drifts from it, and this
 * check would then be enforcing a spelling nobody uses.
 */
export function assertWorkflowOptionForms(runnerPath, workflowPath) {
  const runner = fs.readFileSync(runnerPath, "utf8");
  const valued = new Set(
    [...runner.matchAll(/parsed\.values(?:\.([A-Za-z][\w$]*)|\["([^"]+)"\])/g)]
      .map((match) => match[1] ?? match[2])
      .filter((name) => name !== "project"),
  );
  const valueless = new Set(
    [...runner.matchAll(/flags\.has\("--([^"]+)"\)/g)].map((match) => match[1]),
  );
  assert.ok(valued.size > 0, "no valued options found in the runner");
  assert.ok(valueless.size > 0, "no valueless flags found in the runner");

  const basename = runnerPath.split(/[\\/]/).pop();
  const problems = [];
  for (const invocation of invocations(workflowPath, basename))
    for (const token of invocation.split(/\s+/)) {
      if (!token.startsWith("--")) continue;
      const [name] = token.slice(2).split("=");
      const assigns = token.includes("=");
      if (name === "project") continue;
      if (valued.has(name) && !assigns)
        problems.push(
          `${token}: read from parsed.values, so it must be spelled --${name}=<value>; ` +
            `bare, the parser files it as a flag and its value becomes a positional`,
        );
      else if (valueless.has(name) && assigns)
        problems.push(
          `${token}: read from parsed.flags, so it takes no value; ` +
            `spelled with '=' the parser never records the flag at all`,
        );
      else if (!valued.has(name) && !valueless.has(name))
        problems.push(`${token}: ${basename} reads no such option`);
    }

  assert.deepEqual(problems, [], `${workflowPath}\n  ${problems.join("\n  ")}`);
}

/**
 * The command lines in a workflow that run the given script.
 *
 * Shell continuations are joined so a command split across lines is read whole,
 * and `${{ … }}` expressions collapse to a placeholder first — they contain
 * spaces, and splitting inside one would tear `--project=${{ matrix.project }}`
 * into tokens that mean nothing.
 */
function invocations(workflowPath, basename) {
  const text = fs
    .readFileSync(workflowPath, "utf8")
    .replace(/\$\{\{[^}]*\}\}/g, "EXPR")
    .replace(/\\\r?\n\s*/g, " ");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#") && line.includes(basename));
}
