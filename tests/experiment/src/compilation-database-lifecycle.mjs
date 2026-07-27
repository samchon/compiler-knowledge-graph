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
  const output = compilationOutput(entry);
  const rewrittenOutput =
    output === undefined ? undefined : uniqueOutput(output, from, to);
  const rewritten = { ...entry, file };
  if (Array.isArray(entry.arguments)) {
    rewritten.arguments = rewriteArguments(
      entry.arguments,
      entry.directory,
      from,
      file,
      output,
      rewrittenOutput,
    );
  }
  if (typeof entry.command === "string") {
    const command =
      output === undefined || rewrittenOutput === undefined
        ? entry.command
        : replaceCommandOutput(
            entry.command,
            entry.directory,
            output,
            rewrittenOutput,
            from,
            to,
          );
    rewritten.command = replaceCommandFile(
      command,
      entry.command,
      entry.file,
      from,
      file,
      to,
    );
  }
  if (typeof entry.output === "string" && rewrittenOutput !== undefined) {
    rewritten.output = rewrittenOutput;
  }
  return rewritten;
}

function rewriteArguments(
  args,
  directory,
  source,
  rewrittenSource,
  output,
  rewrittenOutput,
) {
  return args.map((argument, index) => {
    if (typeof argument !== "string") return argument;
    if (
      index > 0 &&
      args[index - 1] === "-o" &&
      output !== undefined &&
      rewrittenOutput !== undefined
    ) {
      return rewritePathForm(
        argument,
        directory,
        output,
        rewrittenOutput,
      );
    }
    return path.resolve(directory, argument) === source
      ? rewrittenSource
      : argument;
  });
}

function replaceCommandFile(
  command,
  originalCommand,
  declaredFrom,
  absoluteFrom,
  to,
  absoluteTo,
) {
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
    `${declaredFrom}: compilation command does not name its translation unit: ${originalCommand}`,
  );
}

function compilationOutput(entry) {
  const candidates = [];
  if (typeof entry.output === "string") {
    candidates.push({ kind: "output", value: entry.output });
  }
  if (Array.isArray(entry.arguments)) {
    const argument = argumentOutput(entry.arguments);
    if (argument !== undefined) {
      candidates.push({ kind: "arguments", value: argument });
    }
  }
  if (typeof entry.command === "string") {
    const command = commandOutput(entry.command);
    if (command !== undefined) {
      candidates.push({ kind: "command", value: command.value });
    }
  }
  if (candidates.length === 0) return undefined;
  const expected = path.resolve(entry.directory, candidates[0].value);
  const conflict = candidates.find(
    (candidate) =>
      path.resolve(entry.directory, candidate.value) !== expected,
  );
  if (conflict !== undefined) {
    throw new Error(
      `compilation command has conflicting ${candidates[0].kind} and ${conflict.kind} outputs`,
    );
  }
  return candidates[0].value;
}

function argumentOutput(args) {
  const outputs = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "-o") continue;
    const output = args[index + 1];
    if (typeof output !== "string" || output === "") {
      throw new Error("compilation arguments have -o without an output path");
    }
    outputs.push(output);
  }
  if (outputs.length > 1) {
    throw new Error("compilation arguments name more than one output");
  }
  return outputs[0];
}

function commandOutput(command) {
  const matches = [
    ...command.matchAll(
      /(?:^|\s)-o\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/g,
    ),
  ];
  if (matches.length > 1) {
    throw new Error("compilation command names more than one output");
  }
  const match = matches[0];
  if (match === undefined) return undefined;
  const value = match[1] ?? match[2] ?? match[3];
  const offset = match[0].lastIndexOf(value);
  return {
    value,
    start: (match.index ?? 0) + offset,
    end: (match.index ?? 0) + offset + value.length,
  };
}

function replaceCommandOutput(
  command,
  directory,
  output,
  rewrittenOutput,
  from,
  to,
) {
  const found = commandOutput(command);
  if (found === undefined) return command;
  if (path.resolve(directory, found.value) !== path.resolve(directory, output)) {
    throw new Error(
      "compilation command output does not match its output metadata",
    );
  }
  const replacement = uniqueOutput(found.value, from, to);
  if (
    path.resolve(directory, replacement) !==
    path.resolve(directory, rewrittenOutput)
  ) {
    throw new Error(
      "rewritten compilation command output does not match its output metadata",
    );
  }
  return `${command.slice(0, found.start)}${replacement}${command.slice(found.end)}`;
}

function uniqueOutput(output, from, to) {
  const fromName = path.basename(from);
  const toName = path.basename(to);
  const fromStem = path.parse(fromName).name;
  const toStem = path.parse(toName).name;
  const parsed = path.parse(output);
  const basename = parsed.base.includes(fromName)
    ? parsed.base.replaceAll(fromName, toName)
    : parsed.base.includes(fromStem)
      ? parsed.base.replaceAll(fromStem, toStem)
      : `${parsed.name}.${toName}${parsed.ext}`;
  const rewritten = `${output.slice(0, output.length - parsed.base.length)}${basename}`;
  if (rewritten === output) {
    throw new Error(`${output}: could not derive a unique cloned output`);
  }
  return rewritten;
}

function rewritePathForm(value, directory, output, rewrittenOutput) {
  if (path.resolve(directory, value) !== path.resolve(directory, output)) {
    throw new Error(
      "compilation argument output does not match its output metadata",
    );
  }
  const rewritten = path.isAbsolute(value)
    ? path.resolve(directory, rewrittenOutput)
    : path.relative(directory, path.resolve(directory, rewrittenOutput));
  return rewritten.replaceAll("\\", value.includes("/") ? "/" : "\\");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
