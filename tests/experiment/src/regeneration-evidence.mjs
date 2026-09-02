import fs from "node:fs";
import path from "node:path";

const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * Read the producer-owned universe rows behind every current generation.
 *
 * The public dump intentionally carries only universe digests. When a strict
 * regeneration check fails, those digests prove that something moved but hide
 * which producer input moved. This reader stays inside the isolated experiment
 * corpus and reports only the committed universe records that produced the
 * rejected public result.
 */
export function captureGenerationEvidence(projectRoot, relativeStoreRoot) {
  if (
    typeof relativeStoreRoot !== "string" ||
    relativeStoreRoot.trim() === ""
  ) {
    throw new Error("regeneration evidence requires a non-empty store root");
  }
  const project = fs.realpathSync(projectRoot);
  const requestedStore = path.resolve(project, relativeStoreRoot);
  assertDescendant(project, requestedStore, "regeneration evidence store");
  if (!fs.statSync(requestedStore, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `regeneration evidence store does not exist: ${requestedStore}`,
    );
  }
  const store = fs.realpathSync(requestedStore);
  assertDescendant(project, store, "regeneration evidence store");

  const currents = walkFiles(store).filter(
    (file) => path.basename(file) === "CURRENT",
  );
  if (currents.length === 0) {
    throw new Error(`regeneration evidence store has no CURRENT pointer: ${store}`);
  }

  const rows = [];
  for (const current of currents) {
    const generation = fs.readFileSync(current, "utf8").trim();
    if (!SHA256.test(generation)) {
      throw new Error(`regeneration evidence has an invalid CURRENT: ${current}`);
    }
    const target = path.dirname(current);
    const requestedGeneration = path.resolve(target, "generations", generation);
    assertDescendant(
      target,
      requestedGeneration,
      "regeneration evidence generation",
    );
    if (
      !fs.statSync(requestedGeneration, { throwIfNoEntry: false })?.isDirectory()
    ) {
      throw new Error(
        `regeneration evidence CURRENT names no generation: ${current}`,
      );
    }
    const committed = fs.realpathSync(requestedGeneration);
    assertDescendant(target, committed, "regeneration evidence generation");
    const requestedUniverse = path.join(committed, "UNIVERSE");
    if (!fs.statSync(requestedUniverse, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`regeneration evidence generation has no UNIVERSE: ${committed}`);
    }
    const universe = fs.realpathSync(requestedUniverse);
    assertDescendant(committed, universe, "regeneration evidence universe");
    const files = [universe];
    const requestedCompiler = path.join(committed, ".universe");
    if (
      fs.statSync(requestedCompiler, { throwIfNoEntry: false })?.isDirectory()
    ) {
      const compiler = fs.realpathSync(requestedCompiler);
      assertDescendant(
        committed,
        compiler,
        "regeneration compiler universe",
      );
      files.push(...walkFiles(compiler));
    }
    for (const file of files.sort(compareUtf8)) {
      const targetRelative = path
        .relative(store, target)
        .replaceAll(path.sep, "/");
      const committedRelative = path
        .relative(committed, file)
        .replaceAll(path.sep, "/");
      const relative = `${targetRelative}/${committedRelative}`;
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/u);
      if (lines.at(-1) === "") lines.pop();
      for (let index = 0; index < lines.length; index++) {
        rows.push(
          `${relative}:${String(index + 1)}:${diagnosticLine(file, lines[index])}`,
        );
      }
    }
  }
  return rows.sort(compareUtf8);
}

/** Name the first exact committed producer row that moved. */
export function firstEvidenceDifference(left, right) {
  if (left === undefined && right === undefined) {
    return "no producer evidence was configured";
  }
  if (left === undefined || right === undefined) {
    return `producer evidence ${left === undefined ? "appeared" : "disappeared"}`;
  }
  const leftRows = new Set(left);
  const rightRows = new Set(right);
  const removed = left.find((row) => !rightRows.has(row));
  const added = right.find((row) => !leftRows.has(row));
  if (removed !== undefined || added !== undefined) {
    const focus = firstDifferenceIndex(removed, added);
    return `${bounded(removed, focus)} -> ${bounded(added, focus)}`;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      const focus = firstDifferenceIndex(left[index], right[index]);
      return `${bounded(left[index], focus)} -> ${bounded(right[index], focus)}`;
    }
  }
  return "committed producer universe rows are equal";
}

function diagnosticLine(file, line) {
  if (!file.endsWith(".args") || line.startsWith("@")) return line;
  let decoded;
  try {
    decoded = Buffer.from(line, "base64url").toString("utf8");
  } catch {
    return line;
  }
  if (Buffer.from(decoded, "utf8").toString("base64url") !== line) return line;
  return decoded.replaceAll(/\|literal:([^|]*)/gu, (_, token) => {
    const literal = Buffer.from(token, "base64url").toString("utf8");
    return `|literal:${JSON.stringify(literal)}`;
  });
}

function walkFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort(compareUtf8);
}

function assertDescendant(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escapes its project: ${candidate}`);
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function firstDifferenceIndex(left, right) {
  if (left === undefined || right === undefined) return undefined;
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    if (left[index] !== right[index]) return index;
  }
  return limit;
}

function bounded(value, focus) {
  if (value === undefined) return "missing";
  const limit = 480;
  if (value.length <= limit) return value;
  if (focus === undefined) {
    const half = (limit - 3) / 2;
    return `${codePointSlice(value, 0, Math.ceil(half))}...${codePointSlice(value, value.length - Math.floor(half), value.length)}`;
  }
  const contentLimit = limit - 6;
  const initialStart = Math.max(0, focus - Math.floor(contentLimit / 2));
  const end = Math.min(value.length, initialStart + contentLimit);
  const start = Math.max(0, end - contentLimit);
  return `${start > 0 ? "..." : ""}${codePointSlice(value, start, end)}${end < value.length ? "..." : ""}`;
}

function codePointSlice(value, requestedStart, requestedEnd) {
  let start = requestedStart;
  let end = requestedEnd;
  if (
    start > 0 &&
    start < value.length &&
    isLowSurrogate(value.charCodeAt(start)) &&
    isHighSurrogate(value.charCodeAt(start - 1))
  ) {
    start++;
  }
  if (
    end > 0 &&
    end < value.length &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end--;
  }
  return value.slice(start, end);
}

function isHighSurrogate(value) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value) {
  return value >= 0xdc00 && value <= 0xdfff;
}
