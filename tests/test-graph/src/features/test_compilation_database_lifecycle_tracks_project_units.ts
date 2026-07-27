import { TestValidator } from "@nestia/e2e";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { GraphPaths } from "../internal/GraphPaths";

/**
 * A strict C/C++ lifecycle changes the compilation universe together with the
 * file; otherwise the experiment asks scip-clang to index a translation unit
 * the project never registered.
 */
export const test_compilation_database_lifecycle_tracks_project_units =
  async () => {
    const root = GraphPaths.createTempDirectory(
      "samchon-graph-compilation-lifecycle-",
    );
    const source = path.join(root, "source.c");
    const argumentsSource = path.join(root, "arguments.c");
    const joinedSource = path.join(root, "joined.c");
    const longSource = path.join(root, "long.c");
    const longArgumentsSource = path.join(root, "long-arguments.c");
    const created = path.join(root, "created.c");
    const argumentsCreated = path.join(root, "arguments-created.c");
    const joinedCreated = path.join(root, "joined-created.c");
    const longCreated = path.join(root, "long-created.c");
    const longArgumentsCreated = path.join(root, "long-arguments-created.c");
    const renamed = path.join(root, "renamed.c");
    const databaseFile = path.join(root, "compile_commands.json");
    fs.writeFileSync(source, "int source(void) { return 0; }\n");
    fs.writeFileSync(
      argumentsSource,
      "int arguments_source(void) { return 0; }\n",
    );
    for (const file of [joinedSource, longSource, longArgumentsSource]) {
      fs.writeFileSync(file, "int unit(void) { return 0; }\n");
    }
    fs.writeFileSync(
      databaseFile,
      `${JSON.stringify(
        [
          {
            directory: root,
            file: source,
            command: `cc -c "${source}" -object-file-name debug.o -o source.c.o`,
            output: "source.c.o",
          },
          {
            directory: root,
            file: "arguments.c",
            arguments: ["cc", "-c", "arguments.c", "-o", "arguments.c.o"],
            output: "arguments.c.o",
          },
          {
            directory: root,
            file: "joined.c",
            arguments: [
              "cc",
              "-c",
              "joined.c",
              "-offload-arch=gpu",
              "-ojoined.c.o",
            ],
            output: "joined.c.o",
          },
          {
            directory: root,
            file: longSource,
            command: `cc -c "${longSource}" --output=long.c.o`,
            output: "long.c.o",
          },
          {
            directory: root,
            file: "long-arguments.c",
            arguments: [
              "cc",
              "-c",
              "long-arguments.c",
              "--output",
              "long-arguments.c.o",
            ],
            output: "long-arguments.c.o",
          },
        ],
        null,
        2,
      )}\n`,
    );

    const modulePath = path.join(
      GraphPaths.repositoryRoot,
      "tests",
      "experiment",
      "src",
      "compilation-database-lifecycle.mjs",
    );
    const imported = (await import(pathToFileURL(modulePath).href)) as {
      compilationDatabaseLifecycle: {
        add(database: string, template: string, added: string): void;
        move(database: string, from: string, to: string): void;
        remove(database: string, removed: string): void;
      };
    };
    const lifecycle = imported.compilationDatabaseLifecycle;

    lifecycle.add(databaseFile, source, created);
    lifecycle.add(databaseFile, argumentsSource, argumentsCreated);
    lifecycle.add(databaseFile, joinedSource, joinedCreated);
    lifecycle.add(databaseFile, longSource, longCreated);
    lifecycle.add(
      databaseFile,
      longArgumentsSource,
      longArgumentsCreated,
    );
    let database = readDatabase(databaseFile);
    TestValidator.equals(
      "creating a unit preserves the template and registers the new source",
      database.map((entry) => path.resolve(entry.directory, entry.file)),
      [
        source,
        argumentsSource,
        joinedSource,
        longSource,
        longArgumentsSource,
        created,
        argumentsCreated,
        joinedCreated,
        longCreated,
        longArgumentsCreated,
      ],
    );
    const createdCommand = findEntry(database, created);
    TestValidator.predicate(
      "the cloned command and metadata name one unique created output",
      createdCommand.command?.includes(created) === true &&
        createdCommand.command?.includes("-o created.c.o") === true &&
        createdCommand.command?.includes("-o source.c.o") === false &&
        createdCommand.output === "created.c.o",
    );
    const createdArguments = findEntry(database, argumentsCreated);
    TestValidator.predicate(
      "the cloned argument vector and metadata name one unique created output",
      createdArguments.arguments?.includes("arguments-created.c") === true &&
        createdArguments.arguments?.includes("arguments-created.c.o") ===
          true &&
        createdArguments.arguments?.includes("arguments.c.o") === false &&
        createdArguments.output === "arguments-created.c.o",
    );
    const joinedArguments = findEntry(database, joinedCreated);
    TestValidator.predicate(
      "a joined -o argument keeps its spelling and receives a unique output",
      joinedArguments.arguments?.includes("-ojoined-created.c.o") === true &&
        joinedArguments.arguments?.includes("-ojoined.c.o") === false &&
        joinedArguments.output === "joined-created.c.o",
    );
    const longCommand = findEntry(database, longCreated);
    TestValidator.predicate(
      "a --output= command keeps its spelling and receives a unique output",
      longCommand.command?.includes("--output=long-created.c.o") === true &&
        longCommand.command?.includes("--output=long.c.o") === false &&
        longCommand.output === "long-created.c.o",
    );
    const longArguments = findEntry(database, longArgumentsCreated);
    TestValidator.predicate(
      "a split --output argument keeps its spelling and receives a unique output",
      longArguments.arguments?.includes("--output") === true &&
        longArguments.arguments?.includes("long-arguments-created.c.o") ===
          true &&
        longArguments.arguments?.includes("long-arguments.c.o") === false &&
        longArguments.output === "long-arguments-created.c.o",
    );

    lifecycle.move(databaseFile, created, renamed);
    database = readDatabase(databaseFile);
    const renamedCommand = findEntry(database, renamed);
    TestValidator.predicate(
      "renaming a unit moves both the declared file and its command",
      renamedCommand.command?.includes(renamed) === true &&
        !renamedCommand.command?.includes(created),
    );

    lifecycle.remove(databaseFile, renamed);
    database = readDatabase(databaseFile);
    TestValidator.equals(
      "deleting a unit removes only its cloned compilation command",
      database.map((entry) => path.resolve(entry.directory, entry.file)),
      [
        source,
        argumentsSource,
        joinedSource,
        longSource,
        longArgumentsSource,
        argumentsCreated,
        joinedCreated,
        longCreated,
        longArgumentsCreated,
      ],
    );
    lifecycle.remove(databaseFile, argumentsCreated);
    TestValidator.error(
      "an unregistered unit cannot be moved",
      () => lifecycle.move(databaseFile, renamed, created),
    );
    fs.writeFileSync(
      databaseFile,
      `${JSON.stringify([
        {
          directory: root,
          file: source,
          command: `cc -c "${source}" -o command.o`,
          output: "metadata.o",
        },
      ])}\n`,
    );
    TestValidator.error(
      "conflicting output evidence cannot be cloned",
      () => lifecycle.add(databaseFile, source, created),
    );
  };

function readDatabase(file: string): ICompilationCommand[] {
  return JSON.parse(fs.readFileSync(file, "utf8")) as ICompilationCommand[];
}

interface ICompilationCommand {
  directory: string;
  file: string;
  command?: string;
  arguments?: string[];
  output?: string;
}

function findEntry(
  database: ICompilationCommand[],
  file: string,
): ICompilationCommand {
  const found = database.find(
    (entry) => path.resolve(entry.directory, entry.file) === file,
  );
  if (found === undefined) throw new Error(`${file}: compilation entry absent`);
  return found;
}
