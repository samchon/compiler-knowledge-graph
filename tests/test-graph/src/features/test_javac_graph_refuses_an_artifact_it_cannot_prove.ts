import { TestValidator } from "@nestia/e2e";
import { IJavaGraphSnapshot, JavaGraphSnapshotAdapter } from "@samchon/graph";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

/**
 * Every field the adapter reads is a field a producer can get wrong.
 *
 * The lifecycle case drives the whole session and proves the route works. This
 * one holds the artifact still and moves one thing at a time, because that is
 * the only way to tell a validator that checks a field from one that mentions
 * it: a malformed generation has to be refused for the reason it is malformed,
 * and the prior generation has to survive every one of them.
 *
 * The baseline is written by the fake producer rather than typed here, so the
 * shape these cases mutate is the shape the route actually receives.
 */
export const test_javac_graph_refuses_an_artifact_it_cannot_prove =
  (): void => {
    const root = GraphPaths.createTempDirectory("samchon-graph-javac-wire-");
    fs.mkdirSync(path.join(root, "src", "main", "java", "com"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, "src", "main", "java", "com", "Example.java"),
      "package com;\npublic class Example {}\n",
    );
    fs.writeFileSync(
      path.join(root, "src", "main", "java", "com", "Caller.java"),
      "package com;\npublic class Caller {}\n",
    );
    const artifact = path.join(root, "graph.json");
    const produced = spawnSync(
      process.execPath,
      [
        GraphPaths.fakeScipJava,
        "index",
        "--output",
        path.join(root, "index.scip"),
        "--graph-output",
        artifact,
      ],
      { cwd: root, encoding: "utf8" },
    );
    TestValidator.equals(
      "the fake producer writes a baseline artifact",
      produced.status,
      0,
    );
    const valid = JSON.parse(
      fs.readFileSync(artifact, "utf8"),
    ) as IJavaGraphSnapshot;

    // The baseline itself must publish, or every refusal below would pass for
    // the wrong reason.
    const accepting = new JavaGraphSnapshotAdapter(root);
    TestValidator.predicate(
      "the unmutated artifact publishes a generation",
      accepting.current === undefined &&
        accepting.apply(structuredClone(valid)).protocol !== undefined &&
        accepting.current !== undefined,
    );
    const published = accepting.current;

    const rejects = (
      label: string,
      mutate: (value: IJavaGraphSnapshot) => void,
    ): void => {
      const candidate = structuredClone(valid);
      mutate(candidate);
      TestValidator.error(label, () => {
        accepting.apply(candidate);
      });
      TestValidator.predicate(
        `${label} leaves the prior generation standing`,
        accepting.current === published,
      );
    };

    // Not a mutation of the baseline: a build that printed a line where its
    // graph belongs parses to a string, and the first thing the adapter has to
    // establish is that it was handed an object at all.
    TestValidator.error("an artifact that is not an object", () => {
      accepting.apply("BUILD SUCCESSFUL");
    });

    rejects("an artifact from a future schema", (value) => {
      value.schemaVersion = 2;
    });
    rejects("an artifact from a foreign producer", (value) => {
      value.producer.name = "some-other-graph";
    });
    rejects("a producer speaking a future protocol", (value) => {
      value.producer.protocolVersion = 2;
    });
    rejects("a producer that cannot commit atomic generations", (value) => {
      value.producer.capabilities.atomicGenerations = false;
    });
    rejects("an artifact produced for another project", (value) => {
      value.projectRoot = path.join(value.projectRoot, "elsewhere");
    });
    rejects("an artifact that committed no target", (value) => {
      value.targets = [];
    });

    rejects("an artifact with no producer block", (value) => {
      (value as { producer?: unknown }).producer = "scip-java";
    });
    rejects("a producer that states no version", (value) => {
      value.producer.version = "";
    });
    rejects("a producer with no capability block", (value) => {
      (value.producer as { capabilities?: unknown }).capabilities = true;
    });
    rejects("a capability block missing incremental", (value) => {
      (value.producer.capabilities as { incremental?: unknown }).incremental =
        "yes";
    });
    rejects("a capability block missing diagnostics", (value) => {
      (value.producer.capabilities as { diagnostics?: unknown }).diagnostics =
        1;
    });
    rejects("an artifact that names no project root", (value) => {
      value.projectRoot = "";
    });
    rejects("an artifact whose targets are not a list", (value) => {
      (value as { targets?: unknown }).targets = {};
    });

    rejects("a target with no name", (value) => {
      value.targets[0]!.name = "";
    });
    rejects("a target generation that is not a digest", (value) => {
      value.targets[0]!.generation = "0";
    });
    rejects("a target universe that is not a digest", (value) => {
      value.targets[0]!.universe = "not-a-digest";
    });
    rejects("a target whose coverage is not a matrix", (value) => {
      (value.targets[0] as { coverage?: unknown }).coverage = [];
    });
    rejects("a target that committed no shard", (value) => {
      value.targets[0]!.shards = [];
    });
    rejects("a coverage state the protocol does not define", (value) => {
      value.targets[0]!.coverage.calls = "probably";
    });
    rejects("two targets committed under one name", (value) => {
      value.targets.push(structuredClone(value.targets[0]!));
    });

    rejects("a shard from a future schema", (value) => {
      value.targets[0]!.shards[0]!.schemaVersion = 2;
    });
    rejects("a shard of another language", (value) => {
      value.targets[0]!.shards[0]!.language = "kotlin";
    });
    rejects("a shard with no source", (value) => {
      value.targets[0]!.shards[0]!.source = "";
    });
    rejects("a checker digest that is not a digest", (value) => {
      value.targets[0]!.shards[0]!.checkerDigest = "nope";
    });
    rejects("a disk digest that is neither empty nor a digest", (value) => {
      value.targets[0]!.shards[0]!.diskDigest = "nope";
    });
    rejects("a shard that states no compiler", (value) => {
      (value.targets[0]!.shards[0] as { compilerVersion?: unknown })
        .compilerVersion = 21;
    });
    // A route that publishes compiler authority has to name the compiler. An
    // empty reading is the producer failing to read `java.version`, not a
    // build without one.
    rejects("a shard whose compiler reading is empty", (value) => {
      value.targets[0]!.shards[0]!.compilerVersion = "";
    });
    rejects("a shard whose nodes are not a list", (value) => {
      (value.targets[0]!.shards[0] as { nodes?: unknown }).nodes = {};
    });
    rejects("one source committed twice in one target", (value) => {
      value.targets[0]!.shards.push(
        structuredClone(value.targets[0]!.shards[0]!),
      );
    });

    rejects("a declaration with no symbol", (value) => {
      value.targets[0]!.shards[0]!.nodes[0]!.symbol = "";
    });
    rejects("a declaration of a kind the graph has no node for", (value) => {
      value.targets[0]!.shards[0]!.nodes[0]!.kind = "annotation";
    });
    rejects("a declaration with no name", (value) => {
      value.targets[0]!.shards[0]!.nodes[0]!.name = "";
    });
    rejects("a declaration whose qualified name is absent", (value) => {
      (value.targets[0]!.shards[0]!.nodes[0] as { qualifiedName?: unknown })
        .qualifiedName = null;
    });
    rejects("a declaration with no file", (value) => {
      value.targets[0]!.shards[0]!.nodes[0]!.file = "";
    });
    rejects("a declaration that does not say whether it is exported", (value) => {
      (value.targets[0]!.shards[0]!.nodes[0] as { exported?: unknown })
        .exported = "yes";
    });
    rejects("a modifier outside the shared vocabulary", (value) => {
      value.targets[0]!.shards[0]!.nodes[0]!.modifiers = ["sealed"];
    });
    rejects("a modifier repeated on one declaration", (value) => {
      value.targets[0]!.shards[0]!.nodes[0]!.modifiers = ["public", "public"];
    });
    rejects("a declaration with no signature field", (value) => {
      (value.targets[0]!.shards[0]!.nodes[0] as { signature?: unknown })
        .signature = null;
    });
    rejects("one symbol declared twice in one compilation unit", (value) => {
      value.targets[0]!.shards[0]!.nodes.push(
        structuredClone(value.targets[0]!.shards[0]!.nodes[0]!),
      );
    });

    rejects("an edge with no source endpoint", (value) => {
      value.targets[0]!.shards[0]!.edges[0]!.from = "";
    });
    rejects("an edge of a family the graph has no name for", (value) => {
      value.targets[0]!.shards[0]!.edges[0]!.kind = "inherits";
    });
    rejects("an access mode that is neither a string nor absent", (value) => {
      (value.targets[0]!.shards[0]!.edges[0] as { access?: unknown }).access =
        7;
    });
    rejects("a provenance that is neither a string nor absent", (value) => {
      (value.targets[0]!.shards[0]!.edges[0] as { provenance?: unknown })
        .provenance = 7;
    });
    rejects("a target name that is neither a string nor absent", (value) => {
      (value.targets[0]!.shards[0]!.edges[0] as { targetName?: unknown })
        .targetName = 7;
    });
    rejects(
      "a target qualified name that is neither a string nor absent",
      (value) => {
        (
          value.targets[0]!.shards[0]!.edges[0] as {
            targetQualifiedName?: unknown;
          }
        ).targetQualifiedName = 7;
      },
    );
    rejects("an endpoint kind the graph has no node for", (value) => {
      value.targets[0]!.shards[0]!.edges[0]!.targetKind = "annotation";
    });

    rejects("an unresolved family the graph has no name for", (value) => {
      unresolvedShard(value).unresolved[0]!.family = "inherits";
    });
    rejects("an unresolved reason outside the closed set", (value) => {
      unresolvedShard(value).unresolved[0]!.reason = "unlucky";
    });
    rejects("unresolved candidates that are not a list", (value) => {
      (unresolvedShard(value).unresolved[0] as { candidates?: unknown })
        .candidates = "one";
    });
    rejects("one candidate named twice", (value) => {
      const site = unresolvedShard(value).unresolved[0]!;
      site.candidates = [...site.candidates, ...site.candidates];
    });
    rejects("evidence with no file", (value) => {
      unresolvedShard(value).unresolved[0]!.evidence.file = "";
    });
    rejects("evidence with a fractional position", (value) => {
      value.targets[0]!.shards[0]!.nodes[0]!.evidence.endColumn = 1.5;
    });

    // An endpoint outside the compilation is one node however many sources
    // name it, so two references that describe it differently are a producer
    // contradiction rather than two nodes.
    rejects("one external symbol described two ways", (value) => {
      const shard = value.targets[0]!.shards.find(
        (entry) => entry.edges.length > 3,
      )!;
      const external = shard.edges.find(
        (edge) => edge.targetQualifiedName === "java.lang.Object.toString",
      )!;
      shard.edges.push({
        ...structuredClone(external),
        kind: "references",
        targetName: "somethingElse",
        targetQualifiedName: "java.lang.Object.somethingElse",
      });
    });
  };

/** The shard the fake producer publishes its unresolved site on. */
function unresolvedShard(
  value: IJavaGraphSnapshot,
): IJavaGraphSnapshot.IShard {
  return value.targets[0]!.shards.find(
    (shard) => shard.unresolved.length > 0,
  )!;
}
