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

function main() {
  let decision = {
    run: true,
    reason: "latest-update classification failed open",
  };
  try {
    const patterns = parsePatterns(process.argv.slice(2));
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
if (invokedPath === fileURLToPath(import.meta.url)) main();
