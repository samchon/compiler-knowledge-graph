import fs from "node:fs";
import path from "node:path";

/**
 * Keep a lifecycle fixture's compilation database synchronized with its
 * project boundary.
 *
 * A compilation-database producer indexes translation units, not arbitrary
 * files discovered on disk. Creating a source without registering it would
 * test a project the build system does not own and then blame the indexer for
 * agreeing with that boundary.
 */
export const compilationDatabaseLifecycle = {
  add(databaseFile, templateFile, addedFile) {
    const database = readDatabase(databaseFile);
    const template = findEntry(database, templateFile);
    database.push(rewriteEntry(template, templateFile, addedFile));
    writeDatabase(databaseFile, database);
  },

  move(databaseFile, fromFile, toFile) {
    const database = readDatabase(databaseFile);
    const index = findEntryIndex(database, fromFile);
    database[index] = rewriteEntry(database[index], fromFile, toFile);
    writeDatabase(databaseFile, database);
  },

  remove(databaseFile, removedFile) {
    const database = readDatabase(databaseFile);
    database.splice(findEntryIndex(database, removedFile), 1);
    writeDatabase(databaseFile, database);
  },
};

function readDatabase(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${file}: compilation database must be an array`);
  }
  return parsed;
}

function writeDatabase(file, database) {
  fs.writeFileSync(file, `${JSON.stringify(database, null, 2)}\n`);
}

function findEntry(database, file) {
  return database[findEntryIndex(database, file)];
}

function findEntryIndex(database, file) {
  const expected = path.resolve(file);
  const index = database.findIndex(
    (entry) =>
      isRecord(entry) &&
      typeof entry.directory === "string" &&
      typeof entry.file === "string" &&
      path.resolve(entry.directory, entry.file) === expected,
  );
  if (index === -1) {
    throw new Error(`${file}: no compilation command owns this translation unit`);
  }
  return index;
}

function rewriteEntry(entry, fromFile, toFile) {
  if (
    !isRecord(entry) ||
    typeof entry.directory !== "string" ||
    typeof entry.file !== "string"
  ) {
    throw new TypeError("compilation command must name its directory and file");
  }
  const from = path.resolve(fromFile);
  const to = path.resolve(toFile);
  const file = path.isAbsolute(entry.file)
    ? to
    : path.relative(entry.directory, to);
  const rewritten = { ...entry, file };
  if (Array.isArray(entry.arguments)) {
    rewritten.arguments = entry.arguments.map((argument) =>
      typeof argument === "string" &&
      path.resolve(entry.directory, argument) === from
        ? file
        : argument,
    );
  }
  if (typeof entry.command === "string") {
    rewritten.command = replaceCommandFile(
      entry.command,
      entry.file,
      from,
      file,
      to,
    );
  }
  if (typeof entry.output === "string") {
    rewritten.output = uniqueOutput(entry.output, from, to);
  }
  return rewritten;
}

function replaceCommandFile(command, declaredFrom, absoluteFrom, to, absoluteTo) {
  const candidates = [
    declaredFrom,
    absoluteFrom,
    declaredFrom.replaceAll("\\", "/"),
    absoluteFrom.replaceAll("\\", "/"),
  ]
    .filter((candidate, index, array) => array.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    if (!command.includes(candidate)) continue;
    const replacement =
      candidate === absoluteFrom ||
      candidate === absoluteFrom.replaceAll("\\", "/")
        ? absoluteTo.replaceAll("\\", candidate.includes("/") ? "/" : "\\")
        : to.replaceAll("\\", candidate.includes("/") ? "/" : "\\");
    return command.replaceAll(candidate, replacement);
  }
  throw new Error(
    `${declaredFrom}: compilation command does not name its translation unit`,
  );
}

function uniqueOutput(output, from, to) {
  const fromName = path.basename(from);
  const toName = path.basename(to);
  return output.includes(fromName)
    ? output.replaceAll(fromName, toName)
    : output;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
