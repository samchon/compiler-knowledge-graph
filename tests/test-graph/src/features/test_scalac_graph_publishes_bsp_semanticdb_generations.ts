import { TestValidator } from "@nestia/e2e";
import {
  IScalaGraphSnapshot,
  SCALA_GRAPH_PROVIDER,
  ScalaGraphSnapshotAdapter,
  scalaGraphProvider,
  selectGraphProviders,
} from "@samchon/graph";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

const SOURCES = {
  "src/scala-2/demo/Api.scala":
    "package demo\n\nfinal class Api[A](value: A) {\n  def run(): A = value\n}\n",
  "src/scala-3/demo/Api.scala":
    "package demo\n\nfinal class Api[A](value: A):\n  def run(): A = value\n",
};

/**
 * The Scala route keeps BSP targets separate and cross-checks typed-plugin
 * facts against the SemanticDB document emitted by that same compile.
 */
export const test_scalac_graph_publishes_bsp_semanticdb_generations =
  async (): Promise<void> => {
    const packagedScala = path.join(
      GraphPaths.graphPackageRoot,
      "sidecars",
      "scala",
    );
    TestValidator.predicate(
      "the package carries the complete buildable Scala producer source",
      [
        "README.md",
        "pom.xml",
        "scala2-plugin/src/main/resources/scalac-plugin.xml",
        "scala3-plugin/src/main/resources/plugin.properties",
        "server/src/main/scala/org/samchon/graph/scala/server/Main.scala",
      ].every((file) => fs.existsSync(path.join(packagedScala, file))) &&
        !fs.existsSync(path.join(packagedScala, "server", "target")),
    );
    const root = GraphPaths.createTempDirectory("samchon-graph-scalac-");
    for (const [file, text] of Object.entries(SOURCES)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    fs.mkdirSync(path.join(root, ".bsp"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".bsp", "fixture.json"),
      '{"name":"fixture","argv":["fixture-bsp"]}\n',
    );
    fs.writeFileSync(
      path.join(root, ".bsp", "other.json"),
      '{"name":"other","argv":["other-bsp"]}\n',
    );
    fs.writeFileSync(path.join(root, "build.sbt"), 'scalaVersion := "3.9.0"\n');

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
    const producer = (name: string, flags: readonly string[] = []): string =>
      script(
        name,
        `"${process.execPath}" "${GraphPaths.fakeScalaGraph}" ${flags.join(" ")} ${windows ? "%*" : '"$@"'}`,
      );
    const java = script("java", "echo openjdk 21.0.12 2026-10-21");
    const current = producer("samchon-scala-graph");
    const environment = {
      ...process.env,
      SAMCHON_GRAPH_SCALA_GRAPH: current,
      SAMCHON_GRAPH_JAVA_TOOLCHAIN: java,
    };

    const noBsp = GraphPaths.createTempDirectory("samchon-graph-scala-no-bsp-");
    fs.writeFileSync(path.join(noBsp, "Api.scala"), "object Api\n");
    TestValidator.predicate(
      "a repository without a BSP connection declines the strict route",
      selectGraphProviders(noBsp, ["scala"], {}, environment).candidates.every(
        (candidate) => candidate.provider.name !== SCALA_GRAPH_PROVIDER,
      ),
    );
    TestValidator.predicate(
      "a command without the resident capability declines",
      selectGraphProviders(root, ["scala"], {}, {
        ...environment,
        SAMCHON_GRAPH_SCALA_GRAPH: producer("legacy", [
          "--fake-legacy-server",
        ]),
      }).candidates.every(
        (candidate) => candidate.provider.name !== SCALA_GRAPH_PROVIDER,
      ),
    );
    TestValidator.predicate(
      "a resident producer that rejects the BSP project declines",
      selectGraphProviders(root, ["scala"], {}, {
        ...environment,
        SAMCHON_GRAPH_SCALA_GRAPH: producer("unsupported", [
          "--fake-unsupported",
        ]),
      }).candidates.every(
        (candidate) => candidate.provider.name !== SCALA_GRAPH_PROVIDER,
      ),
    );

    const selected = selectGraphProviders(root, ["scala"], {}, environment);
    TestValidator.predicate(
      "the BSP-capable producer owns Scala with compiler authority",
      selected.candidates.some(
        (candidate) =>
          candidate.provider.name === SCALA_GRAPH_PROVIDER &&
          candidate.provider.authority === "compiler" &&
          candidate.languages.join() === "scala",
      ),
    );
    TestValidator.predicate(
      "whole-target options are refused explicitly",
      selectGraphProviders(
        root,
        ["scala"],
        { server: "metals", maxFiles: 3, lspReferenceLimit: 4 },
        environment,
      ).warnings.some(
        (warning) =>
          warning.includes(SCALA_GRAPH_PROVIDER) &&
          warning.includes("server, maxFiles, lspReferenceLimit"),
      ),
    );
    const configuration = scalaGraphProvider.configuration?.(root, environment);
    const buildInputs = scalaGraphProvider.buildInputs?.(root) ?? [];
    TestValidator.predicate(
      "the target universe observes Java and the producer",
      configuration?.length === 2 &&
        configuration[0]!.startsWith("java=") &&
        configuration[1]!.startsWith("samchon-scala-graph=") &&
        buildInputs.includes("build.sbt") &&
        buildInputs.includes(".bsp/fixture.json") &&
        buildInputs.includes(".bsp/other.json") &&
        scalaGraphProvider
          .configurationDerivation?.(root, environment)
          .inconclusive.length === 0,
    );

    const command = scalaGraphProvider.resolve(root, environment);
    if (command === undefined) {
      throw new Error("scalac-graph: the fixture producer did not resolve");
    }
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries({
      SAMCHON_GRAPH_SCALA_GRAPH: current,
      SAMCHON_GRAPH_JAVA_TOOLCHAIN: java,
    })) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const session = scalaGraphProvider.open({
        root,
        command,
        languages: ["scala"],
        options: { cwd: root },
      });
      try {
        const cold = await session.refresh();
        TestValidator.predicate(
          "one generation publishes separate Scala 2 and Scala 3 targets",
          cold.mode === "initial" &&
            session.generation === 1 &&
            session.current === cold.snapshot &&
            cold.snapshot.provenance.provider === SCALA_GRAPH_PROVIDER &&
            cold.snapshot.provenance.authority === "compiler" &&
            cold.snapshot.provenance.tool === "samchon-scala-graph" &&
            cold.snapshot.provenance.compilerVersion === "2.13.18; 3.9.0" &&
            cold.snapshot.protocol?.targets.length === 2 &&
            cold.snapshot.coverage?.length === 30,
        );
        const apis = cold.snapshot.nodes.filter(
          (node) => node.name === "Api" && !node.external,
        );
        TestValidator.predicate(
          "cross-built twins keep target-scoped stable identities",
          apis.length === 2 &&
            apis[0]!.id !== apis[1]!.id &&
            apis.every((node) => node.id.startsWith("@v2/scala/")),
        );
        TestValidator.predicate(
          "typed calls and SemanticDB diagnostics survive normalization",
          cold.snapshot.edges.some((edge) => edge.kind === "calls") &&
            cold.snapshot.diagnostics.length === 2 &&
            cold.snapshot.diagnostics.every(
              (diagnostic) => diagnostic.code === "scalac",
            ) &&
            cold.snapshot.coverage?.filter(
              (row) =>
                ["renders", "tests"].includes(row.family) &&
                row.state === "unsupported",
            ).length === 4,
        );

        const unchanged = await session.refresh();
        TestValidator.predicate(
          "an unchanged BSP universe reuses the exact snapshot",
          unchanged.changed === false && unchanged.snapshot === cold.snapshot,
        );
        fs.appendFileSync(
          path.join(root, "src/scala-3/demo/Api.scala"),
          "// body edit\n",
        );
        const edited = await session.refresh();
        TestValidator.predicate(
          "a source edit commits an incremental target generation",
          edited.changed === true &&
            edited.mode === "incremental" &&
            edited.snapshot !== cold.snapshot,
        );
      } finally {
        await session.close();
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const artifactFile = path.join(root, "scala-artifact.json");
    const produced = spawnSync(
      process.execPath,
      [GraphPaths.fakeScalaGraph, "snapshot", "--output", artifactFile],
      { cwd: root, encoding: "utf8" },
    );
    TestValidator.equals("the producer writes an exact fixture", produced.status, 0);
    const valid = JSON.parse(
      fs.readFileSync(artifactFile, "utf8"),
    ) as IScalaGraphSnapshot;
    const accepting = new ScalaGraphSnapshotAdapter(root);
    const published = accepting.apply(structuredClone(valid));
    const reordered = structuredClone(valid);
    reordered.targets.reverse();
    const ordering = new ScalaGraphSnapshotAdapter(root);
    const forward = ordering.apply(structuredClone(valid));
    const reverse = ordering.apply(reordered);
    TestValidator.predicate(
      "BSP response order does not move the committed generation",
      reverse.protocol?.generation === forward.protocol?.generation &&
        reverse.provenance.universe === forward.provenance.universe &&
        JSON.stringify(reverse.coverage) === JSON.stringify(forward.coverage),
    );
    const rejects = (
      label: string,
      mutate: (value: IScalaGraphSnapshot) => void,
    ): void => {
      const candidate = structuredClone(valid);
      mutate(candidate);
      TestValidator.error(label, () => accepting.apply(candidate));
      TestValidator.predicate(
        `${label} keeps the prior generation`,
        accepting.current === published,
      );
    };

    for (const capability of ["bsp", "semanticdb", "typedPlugins", "zinc"] as const) {
      rejects(`a producer without ${capability}`, (value) => {
        value.producer.capabilities[capability] = false;
      });
    }
    rejects("a target whose identity is not its BSP URI", (value) => {
      value.targets[0]!.name = "file:///different";
    });
    rejects("a target with no absolute BSP URI", (value) => {
      value.targets[0]!.bspUri = "not a URI";
      value.targets[0]!.name = "not a URI";
    });
    rejects("a target on an unsupported Scala line", (value) => {
      value.targets[0]!.scalaVersion = "2.11.12";
    });
    rejects("a Scala 2 target with the wrong binary line", (value) => {
      value.targets[0]!.scalaBinaryVersion = "2.12";
    });
    rejects("a target with a non-string binary line", (value) => {
      value.targets[0]!.scalaBinaryVersion = 213 as unknown as string;
    });
    rejects("a Scala 3 target with the wrong binary line", (value) => {
      value.targets[1]!.scalaBinaryVersion = "3.7";
    });
    rejects("a target without a platform", (value) => {
      value.targets[0]!.platform = "";
    });
    rejects("a target without a valid source encoding", (value) => {
      value.targets[0]!.sourceEncoding = "";
    });
    for (const coordinate of [
      "scalacOptionsDigest",
      "classpathDigest",
      "sourceRootsDigest",
      "semanticdbOptionsDigest",
      "compilerPluginsDigest",
      "zincAnalysisDigest",
      "generatedSourcesDigest",
    ] as const) {
      rejects(`a target with a malformed ${coordinate}`, (value) => {
        value.targets[0]![coordinate] = "not-a-digest";
      });
    }
    rejects("a shard from another compiler version", (value) => {
      value.targets[0]!.shards[0]!.compilerVersion = "2.13.15";
    });
    rejects("a Scala 2 shard from the Scala 3 plugin", (value) => {
      value.targets[0]!.shards[0]!.compilerPlugin = "scala3";
    });
    rejects("a shard without a plugin version", (value) => {
      value.targets[0]!.shards[0]!.compilerPluginVersion = "";
    });
    rejects("a shard from another SemanticDB schema", (value) => {
      value.targets[0]!.shards[0]!.semanticdbSchema = 5;
    });
    rejects("a SemanticDB document for another URI", (value) => {
      value.targets[0]!.shards[0]!.semanticdbUri = "Other.scala";
    });
    rejects("a SemanticDB document from another build target", (value) => {
      value.targets[0]!.shards[0]!.semanticdbBuildTarget = "file:///other";
    });
    rejects("a malformed SemanticDB md5", (value) => {
      value.targets[0]!.shards[0]!.semanticdbMd5 = "not-md5";
    });
    rejects("a stale SemanticDB md5", (value) => {
      value.targets[0]!.shards[0]!.semanticdbMd5 = createHash("md5")
        .update("different")
        .digest("hex");
    });
    rejects("a SemanticDB source that cannot be read", (value) => {
      const shard = value.targets[0]!.shards[0]!;
      shard.source = "src/scala-2/demo/Missing.scala";
      shard.semanticdbUri = shard.source;
      shard.nodes.forEach((node) => {
        node.file = shard.source;
        node.evidence.file = shard.source;
      });
      shard.edges.forEach((edge) => {
        edge.evidence.file = shard.source;
        if (edge.from === "src/scala-2/demo/Api.scala") edge.from = shard.source;
      });
      shard.unresolved.forEach((site) => {
        site.evidence.file = shard.source;
      });
      shard.diagnostics.forEach((diagnostic) => {
        diagnostic.evidence.file = shard.source;
      });
    });
  };
