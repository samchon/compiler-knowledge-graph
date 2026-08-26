import { TestValidator } from "@nestia/e2e";
import {
  buildGraphDump,
  JAVA_GRAPH_PROVIDER,
  javaGraphProvider,
  selectGraphProviders,
} from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/**
 * A launcher's name is not its capability.
 *
 * Every released `scip-java` answers `index`, and none of them writes a graph:
 * `--graph-output` arrived with the javac plugin. A route that resolved on the
 * command name alone would run a whole Maven or Gradle build and only then
 * find nothing to read — and, worse, a reader would have watched a
 * compiler-authority provider get selected. So the capability is asked for
 * before anything is compiled, and a launcher that lacks it declines the way
 * an uninstalled one does.
 *
 * 1. A launcher whose `index --help` omits the option is not selected.
 * 2. The decline names the provider and the authority the build gave up.
 * 3. The same launcher with the option is selected, and a bounded request
 *    still refuses it with a sentence rather than silently weakening it.
 */
export const test_javac_graph_declines_a_launcher_without_graph_output =
  async (): Promise<void> => {
    const root = GraphPaths.createTempDirectory("samchon-graph-javac-select-");
    fs.writeFileSync(
      path.join(root, "pom.xml"),
      "<project><modelVersion>4.0.0</modelVersion></project>\n",
    );
    // The two compilation units the fake producer reports having compiled.
    // The coordinator hashes them itself before it will publish anything, so
    // a fixture that named sources it does not have would fail that fence for
    // the fixture reason rather than the route one.
    fs.mkdirSync(path.join(root, "src", "main", "java", "com"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, "src", "main", "java", "com", "Example.java"),
      "package com;\npublic class Example {}\n",
    );
    fs.writeFileSync(
      path.join(root, "src", "main", "java", "com", "Caller.java"),
      "package com;\npublic class Caller {\n    public static Example make() {\n        return new Example();\n    }\n}\n",
    );

    const windows = process.platform === "win32";
    const script = (name: string, body: string): string => {
      const file = path.join(root, windows ? `${name}.cmd` : name);
      fs.writeFileSync(
        file,
        windows ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`,
      );
      if (!windows) fs.chmodSync(file, 0o755);
      return file;
    };
    const shim = (name: string, flags: readonly string[]): string =>
      script(
        name,
        `"${process.execPath}" "${GraphPaths.fakeScipJava}" ${flags.join(" ")} ${windows ? "%*" : '"$@"'}`,
      );
    // Every JDK since 9 answers `--version` on standard output, which is
    // where the shared toolchain probe reads.
    const jdk = script("java", "echo openjdk 21.0.5 2026-10-21");

    const select = (launcher: string, options = {}) =>
      selectGraphProviders(root, ["java"], options, {
        ...process.env,
        SAMCHON_GRAPH_JAVAC_GRAPH: launcher,
        SAMCHON_GRAPH_JAVA_TOOLCHAIN: jdk,
      });

    const legacy = select(shim("legacy", ["--fake-legacy-launcher"]));
    TestValidator.predicate(
      "a launcher without --graph-output is not selected",
      legacy.candidates.every(
        (candidate) => candidate.provider.name !== JAVA_GRAPH_PROVIDER,
      ),
    );
    TestValidator.predicate(
      "the decline names the provider and the authority given up",
      legacy.warnings.some(
        (warning) =>
          warning.includes(JAVA_GRAPH_PROVIDER) &&
          warning.includes("compiler provider") &&
          warning.includes("was not found"),
      ),
    );

    const current = shim("current", []);
    const selected = select(current);
    TestValidator.predicate(
      "a launcher that publishes the option owns the language",
      selected.candidates.some(
        (candidate) =>
          candidate.provider.name === JAVA_GRAPH_PROVIDER &&
          candidate.provider.authority === "compiler" &&
          candidate.languages.join() === "java",
      ),
    );

    // A whole-target producer has no bounded mode. Refusing is a sentence, not
    // a silence: a capped request that quietly fell through to the generic lane
    // would read exactly like the compiler-owned result it replaced.
    const bounded = select(current, {
      server: "jdtls",
      maxFiles: 10,
      lspReferenceLimit: 250,
    });
    TestValidator.predicate(
      "a bounded request refuses the route instead of weakening it",
      bounded.candidates.every(
        (candidate) => candidate.provider.name !== JAVA_GRAPH_PROVIDER,
      ) &&
        bounded.warnings.some(
          (warning) =>
            warning.includes(JAVA_GRAPH_PROVIDER) &&
            warning.includes("server, maxFiles, lspReferenceLimit"),
        ),
    );

    // With no launcher anywhere — no override, and a PATH with nothing on it —
    // the route is simply absent. A machine that happens to have `scip-java`
    // installed must not turn this case into a different one.
    const empty = path.join(root, "empty-path");
    fs.mkdirSync(empty, { recursive: true });
    const absent = selectGraphProviders(
      root,
      ["java"],
      {},
      { PATH: empty, Path: empty },
    );
    TestValidator.predicate(
      "no launcher at all declines the same way",
      absent.candidates.every(
        (candidate) => candidate.provider.name !== JAVA_GRAPH_PROVIDER,
      ),
    );

    // The build universe this route reuses facts against. A JDK swap
    // recompiles against a different `java.base` and a launcher upgrade can
    // move the shard schema, so both are identity rather than decoration.
    const environment = {
      ...process.env,
      SAMCHON_GRAPH_JAVAC_GRAPH: current,
      SAMCHON_GRAPH_JAVA_TOOLCHAIN: jdk,
    };
    const configuration = javaGraphProvider.configuration?.(root, environment);
    TestValidator.predicate(
      "the build universe names the JDK and the launcher that will run",
      configuration?.length === 2 &&
        configuration[0]!.startsWith("java=") &&
        configuration[0]!.includes("21.0.5") &&
        configuration[1]!.startsWith("scip-java=") &&
        javaGraphProvider
          .configurationDerivation?.(root, environment)
          .inconclusive.length === 0,
    );

    const command = javaGraphProvider.resolve(root, environment);
    TestValidator.predicate(
      "the registered route resolves its launcher",
      command !== undefined,
    );
    if (command === undefined) {
      throw new Error("javac-graph: the fixture launcher did not resolve");
    }
    // A session reads the environment from the process, not from the object
    // its provider was resolved with — every registry entry does, because a
    // session outlives the selection that opened it. The fixture therefore has
    // to put its toolchain where the session will look, or the row it derives
    // depends on whatever JDK the host happens to have.
    const previous = new Map<string, string | undefined>();
    for (const key of [
      "SAMCHON_GRAPH_JAVAC_GRAPH",
      "SAMCHON_GRAPH_JAVA_TOOLCHAIN",
    ]) {
      previous.set(key, process.env[key]);
      process.env[key] = environment[key];
    }
    try {
      const session = javaGraphProvider.open({
        root,
        command,
        languages: ["java"],
        options: { cwd: root },
      });
      try {
        const generation = await session.refresh();
        TestValidator.predicate(
          "the registered route publishes its own compiler-owned generation",
          generation.mode === "initial" &&
            generation.snapshot.provenance.provider === JAVA_GRAPH_PROVIDER &&
            generation.snapshot.provenance.authority === "compiler" &&
            generation.snapshot.provenance.compilerVersion === "21.0.5" &&
            generation.snapshot.protocol !== undefined,
        );
      } finally {
        await session.close();
      }

      // The whole route, through the coordinator that owns the project input
      // generation. Opening the session directly proves the producer contract
      // and nothing about the fence around it: a snapshot only publishes if
      // every source it names binds to bytes the coordinator hashed itself,
      // and a provider that omitted a disk digest or named a file in a form
      // the coordinator cannot compare fails there rather than here.
      const dump = await buildGraphDump({
        cwd: root,
        mode: "lsp",
        languages: ["java"],
      });
      TestValidator.predicate(
        "the coordinator publishes the route's generation, fence and all",
        (dump.provenance ?? []).some(
          (row) =>
            row.provider === JAVA_GRAPH_PROVIDER &&
            row.authority === "compiler",
        ) &&
          dump.nodes.some(
            (node) => node.file === "src/main/java/com/Example.java",
          ),
      );
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
