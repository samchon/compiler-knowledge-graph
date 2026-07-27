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
    const created = path.join(root, "created.c");
    const argumentsCreated = path.join(root, "arguments-created.c");
    const renamed = path.join(root, "renamed.c");
    const databaseFile = path.join(root, "compile_commands.json");
    fs.writeFileSync(source, "int source(void) { return 0; }\n");
    fs.writeFileSync(
      argumentsSource,
      "int arguments_source(void) { return 0; }\n",
    );
    fs.writeFileSync(
      databaseFile,
      `${JSON.stringify(
        [
          {
            directory: root,
            file: source,
            command: `cc -c "${source}" -o source.c.o`,
            output: "source.c.o",
          },
          {
            directory: root,
            file: "arguments.c",
            arguments: ["cc", "-c", "arguments.c", "-o", "arguments.c.o"],
            output: "arguments.c.o",
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
    let database = readDatabase(databaseFile);
    TestValidator.equals(
      "creating a unit preserves the template and registers the new source",
      database.map((entry) => path.resolve(entry.directory, entry.file)),
      [source, argumentsSource, created, argumentsCreated],
    );
    TestValidator.predicate(
      "the cloned command and metadata name one unique created output",
      database[2]?.command?.includes(created) === true &&
        database[2]?.command?.includes("-o created.c.o") === true &&
        database[2]?.command?.includes("-o source.c.o") === false &&
        database[2]?.output === "created.c.o",
    );
    TestValidator.predicate(
      "the cloned argument vector and metadata name one unique created output",
      database[3]?.arguments?.includes("arguments-created.c") === true &&
        database[3]?.arguments?.includes("arguments-created.c.o") === true &&
        database[3]?.arguments?.includes("arguments.c.o") === false &&
        database[3]?.output === "arguments-created.c.o",
    );

    lifecycle.move(databaseFile, created, renamed);
    database = readDatabase(databaseFile);
    TestValidator.predicate(
      "renaming a unit moves both the declared file and its command",
      path.resolve(database[2]!.directory, database[2]!.file) === renamed &&
        database[2]?.command?.includes(renamed) === true &&
        !database[2]?.command?.includes(created),
    );

    lifecycle.remove(databaseFile, renamed);
    database = readDatabase(databaseFile);
    TestValidator.equals(
      "deleting a unit removes only its cloned compilation command",
      database.map((entry) => path.resolve(entry.directory, entry.file)),
      [source, argumentsSource, argumentsCreated],
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
