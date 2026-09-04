import fs from "node:fs";
import path from "node:path";

/** Publish the latest KGP invalidation decision without leaking host paths. */
export function captureKotlinBuildReport(projectRoot, relativeReportRoot) {
  const project = fs.realpathSync(projectRoot);
  const requested = path.resolve(project, relativeReportRoot);
  assertDescendant(project, requested);
  if (!fs.statSync(requested, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Kotlin build-report directory does not exist: ${requested}`);
  }
  const reportRoot = fs.realpathSync(requested);
  assertDescendant(project, reportRoot);
  const reports = walkFiles(reportRoot).filter((file) => file.endsWith(".json"));
  if (reports.length === 0) {
    throw new Error(`Kotlin build-report directory contains no JSON report: ${reportRoot}`);
  }
  reports.sort((left, right) => {
    const elapsed = fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs;
    return elapsed === 0 ? compareUtf8(left, right) : elapsed;
  });
  const report = JSON.parse(fs.readFileSync(reports.at(-1), "utf8"));
  if (!isRecord(report) || !Array.isArray(report.buildOperationRecord)) {
    throw new Error("Kotlin build report contains no buildOperationRecord list");
  }
  const tasks = report.buildOperationRecord
    .filter(
      (operation) =>
        isRecord(operation) &&
        typeof operation.path === "string" &&
        /compile.*Kotlin$/iu.test(operation.path),
    )
    .map((operation) => summarizeTask(project, operation));
  if (tasks.length === 0) {
    throw new Error("Kotlin build report contains no Kotlin compilation task");
  }
  return { tasks };
}

function summarizeTask(project, operation) {
  const lines = Array.isArray(operation.icLogLines)
    ? operation.icLogLines.filter((line) => typeof line === "string")
    : [];
  const nonIncremental = lines.find((line) =>
    line.startsWith("Non-incremental compilation will be performed:"),
  );
  const classpath = lines.find((line) =>
    line.startsWith("Classpath changes info passed from Gradle task:"),
  );
  const completedIncrementally = lines.includes("Incremental compilation completed");
  const attributes = operation.buildMetrics?.buildAttributes?.myAttributes;
  return {
    task: operation.path,
    didWork: operation.didWork === true,
    ...(typeof operation.skipMessage === "string"
      ? { skipMessage: operation.skipMessage }
      : {}),
    ...(Number.isFinite(operation.totalTimeMs)
      ? { elapsedMs: operation.totalTimeMs }
      : {}),
    ...(nonIncremental !== undefined
      ? { incremental: false, invalidation: nonIncremental }
      : completedIncrementally
        ? { incremental: true }
        : {}),
    ...(classpath === undefined ? {} : { classpath }),
    ...changedFiles(project, operation.changedFiles),
    ...(isRecord(attributes)
      ? {
          buildAttributes: Object.keys(attributes)
            .filter((key) => Number(attributes[key]) > 0)
            .sort(compareUtf8),
        }
      : {}),
    daemon: lines.some((line) => line.includes("DAEMON strategy")),
  };
}

function changedFiles(project, value) {
  if (!isRecord(value)) return {};
  const normalize = (rows) =>
    Array.isArray(rows)
      ? rows
          .filter((file) => typeof file === "string")
          .map((file) => {
            const relative = path.relative(project, path.resolve(file));
            return relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
              ? "<outside-project>"
              : relative.split(path.sep).join("/");
          })
          .filter((file, index, files) => files.indexOf(file) === index)
          .sort(compareUtf8)
      : [];
  const modified = normalize(value.modifiedFiles);
  const removed = normalize(value.removedFiles);
  return modified.length === 0 && removed.length === 0
    ? {}
    : { changedFiles: { modified, removed } };
}

function walkFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

function assertDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Kotlin build-report directory escapes its project: ${candidate}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
