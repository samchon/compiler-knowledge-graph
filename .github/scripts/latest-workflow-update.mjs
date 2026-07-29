#!/usr/bin/env node
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Decide from the event boundary and `git diff --quiet` status.
 *
 * Pull-request path filters compare the base branch with the whole topic
 * branch. A synchronize event additionally names the exact old and new heads,
 * which lets expensive workflows ignore a publication-only follow-up commit.
 */
export function latestWorkflowUpdateDecision({
  eventName,
  action,
  before,
  after,
  diffStatus,
}) {
  if (eventName !== "pull_request" || action !== "synchronize") {
    return { run: true, reason: "not a pull-request synchronize event" };
  }
  if (!COMMIT_SHA.test(before ?? "") || !COMMIT_SHA.test(after ?? "")) {
    return { run: true, reason: "invalid synchronize commit boundary" };
  }
  if (diffStatus === 0) {
    return { run: false, reason: "latest update has no relevant changes" };
  }
  if (diffStatus === 1) {
    return { run: true, reason: "latest update has relevant changes" };
  }
  return { run: true, reason: "latest-update diff could not be classified" };
}

/**
 * An irrelevant update may inherit a completed predecessor's evidence, and only
 * a completed one.
 *
 * Two callers need this for two reasons, and the rule is the same either way:
 * a skip is a claim about the head being skipped for, so it is honest only when
 * that head already has a verdict to stand on.
 *
 * The measurement's reason is concurrency. It preserves the running run but
 * keeps only one pending member, so a relevant pending head replaced by a later
 * result-only push would lose the only run that covered the relevant change.
 *
 * The experiment lane has no concurrency group at all, and its reason is the
 * merge gate. Its check reports success on the skipped head while the run that
 * covered the change is still open — or has already failed — so a reader looking
 * at the head sees green for work nothing verified.
 */
export function carryForwardWorkflowDecision(
  decision,
  previousRunSucceeded,
) {
  if (decision.run || previousRunSucceeded) return decision;
  return {
    run: true,
    reason: "previous head has no successful workflow evidence to carry forward",
  };
}

async function main() {
  let decision = {
    run: true,
    reason: "latest-update classification failed open",
  };
  try {
    const { patterns, carryForwardWorkflow } = parseArguments(
      process.argv.slice(2),
    );
    const eventName = process.env.GITHUB_EVENT_NAME ?? "";
    const event = JSON.parse(
      fs.readFileSync(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"),
    );
    const before = event.before;
    const after = event.after;
    const boundary = latestWorkflowUpdateDecision({
      eventName,
      action: event.action,
      before,
      after,
      diffStatus: undefined,
    });

    if (
      eventName === "pull_request" &&
      event.action === "synchronize" &&
      COMMIT_SHA.test(before ?? "") &&
      COMMIT_SHA.test(after ?? "")
    ) {
      const diff = cp.spawnSync(
        "git",
        [
          "diff",
          "--quiet",
          "--no-ext-diff",
          before,
          after,
          "--",
          ...patterns,
        ],
        {
          cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(),
          stdio: "inherit",
          windowsHide: true,
        },
      );
      if (diff.error !== undefined) throw diff.error;
      decision = latestWorkflowUpdateDecision({
        eventName,
        action: event.action,
        before,
        after,
        diffStatus: diff.status,
      });
      if (diff.status !== 0 && diff.status !== 1) {
        process.stdout.write(
          `::warning::git diff exited ${String(diff.status)}; running the workflow fail-open\n`,
        );
      }
      if (!decision.run && carryForwardWorkflow !== undefined) {
        decision = carryForwardWorkflowDecision(
          decision,
          await previousWorkflowRunSucceeded(
            carryForwardWorkflow,
            before,
          ),
        );
      }
    } else {
      decision = boundary;
      if (
        eventName === "pull_request" &&
        event.action === "synchronize"
      ) {
        process.stdout.write(
          "::warning::invalid synchronize commit boundary; running the workflow fail-open\n",
        );
      }
    }
  } catch (error) {
    const message = errorMessage(error);
    decision = {
      run: true,
      reason: "latest-update classification failed open",
    };
    process.stdout.write(
      "::warning::latest-update classification failed; " +
        `running the workflow fail-open: ${message}\n`,
    );
  }

  fs.appendFileSync(
    requiredEnvironment("GITHUB_OUTPUT"),
    `run=${decision.run ? "true" : "false"}\n`,
  );
  process.stdout.write(
    `[latest-workflow-update] run=${String(decision.run)}; ${decision.reason}\n`,
  );
}

function parseArguments(args) {
  const carryForward = args.filter((argument) =>
    argument.startsWith("--carry-forward-workflow="),
  );
  if (carryForward.length > 1) {
    throw new Error("--carry-forward-workflow may be specified only once");
  }
  const carryForwardWorkflow = carryForward[0]?.slice(
    "--carry-forward-workflow=".length,
  );
  if (
    carryForwardWorkflow !== undefined &&
    !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(carryForwardWorkflow)
  ) {
    throw new Error(
      `unsafe carry-forward workflow name: ${carryForwardWorkflow}`,
    );
  }
  return {
    patterns: parsePatterns(
      args.filter(
        (argument) =>
          !argument.startsWith("--carry-forward-workflow="),
      ),
    ),
    carryForwardWorkflow,
  };
}

function parsePatterns(args) {
  const includes = [];
  const excludes = [];
  for (const argument of args) {
    const match = /^--(include|exclude)=(.+)$/.exec(argument);
    if (match === null) {
      throw new Error(
        `expected --include=path or --exclude=path, got ${argument}`,
      );
    }
    const pattern = match[2].replaceAll("\\", "/");
    if (
      pattern.startsWith("/") ||
      pattern.split("/").includes("..") ||
      /[\0\r\n]/.test(pattern)
    ) {
      throw new Error(`unsafe repository path pattern: ${argument}`);
    }
    (match[1] === "include" ? includes : excludes).push(pattern);
  }
  if (includes.length === 0) {
    throw new Error("at least one --include path is required");
  }
  return [
    ...includes.map((pattern) => `:(top,glob)${pattern}`),
    ...excludes.map((pattern) => `:(top,glob,exclude)${pattern}`),
  ];
}

async function previousWorkflowRunSucceeded(workflow, headSha) {
  const repository = requiredEnvironment("GITHUB_REPOSITORY").split("/");
  if (
    repository.length !== 2 ||
    repository.some((component) => !/^[A-Za-z0-9_.-]+$/.test(component))
  ) {
    throw new Error("GITHUB_REPOSITORY is not an owner/name pair");
  }
  const api = (
    process.env.GITHUB_API_URL ?? "https://api.github.com"
  ).replace(/\/+$/, "");
  const url = new URL(
    `${api}/repos/${encodeURIComponent(repository[0])}/${encodeURIComponent(repository[1])}` +
      `/actions/workflows/${encodeURIComponent(workflow)}/runs`,
  );
  url.searchParams.set("head_sha", headSha);
  url.searchParams.set("event", "pull_request");
  url.searchParams.set("status", "success");
  url.searchParams.set("per_page", "1");
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub workflow evidence query returned HTTP ${String(response.status)}`,
    );
  }
  const body = await response.json();
  const count = body?.total_count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("GitHub workflow evidence query returned no valid count");
  }
  return count > 0;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
