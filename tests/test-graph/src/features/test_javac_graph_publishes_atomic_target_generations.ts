import { TestValidator } from "@nestia/e2e";
import {
  assertGraphSnapshotContract,
  JAVA_GRAPH_PROVIDER,
  JavaGraphSession,
  javaGraphProvider,
} from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

const SOURCES = {
  "src/main/java/com/Example.java": "package com;\npublic class Example {}\n",
  "src/main/java/com/Caller.java":
    "package com;\npublic class Caller {\n    public static Example make() {\n        return new Example();\n    }\n}\n",
};

/**
 * The strict Java route publishes what one build committed, and nothing else.
 *
 * The producer commits per target: each carries its own content-addressed
 * generation and the universe it compiled against, and an incremental build
 * rewrites only the sources javac recompiled. So the consumer's whole job is
 * to prove the transaction it was handed rather than to assemble one — and
 * every case below is a way that proof can fail while the payload still parses.
 *
 * 1. A cold generation publishes compiler authority, target-scoped identities,
 *    a complete coverage matrix and one node per external endpoint.
 * 2. An unchanged build reuses the exact snapshot; a recompiled source moves
 *    one shard and keeps the rest, which is what makes it incremental.
 * 3. A producer that cannot be trusted — wrong schema, wrong protocol, wrong
 *    project, an incomplete matrix, an endpoint nothing declares — is refused
 *    with the prior generation intact.
 */
export const test_javac_graph_publishes_atomic_target_generations =
  async (): Promise<void> => {
    const root = GraphPaths.createTempDirectory("samchon-graph-javac-");
    for (const [file, text] of Object.entries(SOURCES)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }

    const open = (
      options: { maxArtifactBytes?: number } = {},
      ...flags: string[]
    ): JavaGraphSession =>
      new JavaGraphSession({
        root,
        languages: ["java"],
        provider: JAVA_GRAPH_PROVIDER,
        command: {
          command: process.execPath,
          args: [GraphPaths.fakeScipJava, ...flags],
        },
        inputs: () => Object.keys(SOURCES),
        configuration: () => ["java=21.0.5"],
        validate: (snapshot) =>
          assertGraphSnapshotContract(
            snapshot,
            javaGraphProvider,
            ["java"],
            root,
          ),
        ...options,
      });

    // A byte ceiling that cannot bound anything is refused where it is stated,
    // not where a build would later exceed it.
    TestValidator.error("a ceiling that admits no artifact", () => {
      open({ maxArtifactBytes: 0 });
    });

    const session = open();
    try {
      const cold = await session.refresh();
      TestValidator.equals(
        "the first published generation is generation one",
        session.generation,
        1,
      );
      TestValidator.equals(
        "a cold build is the first generation",
        cold.mode,
        "initial",
      );
      const snapshot = cold.snapshot;
      TestValidator.equals(
        "the route publishes compiler authority",
        snapshot.provenance.authority,
        "compiler",
      );
      TestValidator.equals(
        "the route names itself, not its launcher",
        snapshot.provenance.provider,
        JAVA_GRAPH_PROVIDER,
      );
      TestValidator.equals(
        "the producer names the plugin that wrote it",
        snapshot.provenance.tool,
        "scip-java-javac-graph",
      );
      TestValidator.equals(
        "one JDK compiled every shard",
        snapshot.provenance.compilerVersion,
        "21.0.5",
      );

      // Coverage is what makes an absent edge meaningful, so it has to be
      // complete for the target and appear exactly once per family.
      const coverage = snapshot.coverage ?? [];
      TestValidator.equals(
        "the target states every relationship family once",
        coverage.length,
        15,
      );
      TestValidator.predicate(
        "renders is stated unsupported rather than left out",
        coverage.some(
          (row) => row.family === "renders" && row.state === "unsupported",
        ),
      );
      TestValidator.predicate(
        "every coverage row belongs to this provider and target",
        coverage.every(
          (row) =>
            row.provider === JAVA_GRAPH_PROVIDER &&
            row.language === "java" &&
            row.target === "maven:example",
        ),
      );

      // The producer wrote the same relationship at two call sites. The graph's
      // triple is unique and keeps the first source-order evidence.
      const instantiates = snapshot.edges.filter(
        (edge) => edge.kind === "instantiates",
      );
      TestValidator.equals(
        "one relationship written twice becomes one edge",
        instantiates.length,
        1,
      );
      const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
      const crossFile = instantiates[0]!;
      TestValidator.predicate(
        "the instantiation crosses a compilation unit",
        nodes.get(crossFile.from)?.file === "src/main/java/com/Caller.java" &&
          nodes.get(crossFile.to)?.file === "src/main/java/com/Example.java",
      );

      // An endpoint no shard declares is still an endpoint. It becomes one
      // external node scoped to the target that referenced it, so the edge has
      // somewhere to land without the graph inventing a declaration for it.
      const external = snapshot.nodes.filter((node) => node.external);
      TestValidator.equals(
        "a symbol reached twice from outside is still one external node",
        external.length,
        3,
      );
      // An edge can also originate outside the compilation, and the producer
      // names what an edge points at rather than where it came from. Such an
      // endpoint has only its own symbol to be displayed by, which is a
      // display and not a name the compiler gave it.
      TestValidator.predicate(
        "an endpoint the producer never named displays its own symbol",
        external.some(
          (node) =>
            node.qualifiedName === undefined &&
            node.name.endsWith("$anon1#run()."),
        ),
      );
      // The producer named this one at a `type_ref` site and named nothing at
      // the `decorates` site that reached it first. The description that says
      // something wins, and it wins regardless of which shard was adapted
      // first, because the endpoint set is settled before any shard is built.
      TestValidator.predicate(
        "a site that names an endpoint outranks one that cannot",
        external.some(
          (node) => node.qualifiedName === "java.lang.Deprecated",
        ),
      );
      TestValidator.predicate(
        "the external node keeps the producer's naming",
        external.some(
          (node) => node.qualifiedName === "java.lang.Object.toString",
        ),
      );
      // A producer that could not name the endpoint leaves the symbol as the
      // only thing there is to display it by, rather than inventing one.
      TestValidator.predicate(
        "an external symbol carries no file it does not have",
        external.every(
          (node) => node.file === "" && node.kind === "external_symbol",
        ),
      );

      // Identity is target-scoped, which is what lets one source compiled into
      // two targets be two facts rather than a collision.
      TestValidator.predicate(
        "declarations carry a target-scoped semantic identity",
        snapshot.nodes.every((node) => node.id.startsWith("@v2/java/")),
      );

      const sites = snapshot.unresolved ?? [];
      // A candidate the target declares becomes that declaration's identity; a
      // candidate it does not stays the producer's own symbol, because minting
      // a declaration for an unresolved possibility is what the site exists to
      // avoid.
      TestValidator.predicate(
        "unresolved sites are published with their proven candidates",
        sites.some(
          (site) =>
            site.family === "dispatches" &&
            site.reason === "dynamic" &&
            site.provider === JAVA_GRAPH_PROVIDER &&
            (site.candidates ?? []).length === 2 &&
            site.candidates!.some((candidate) =>
              candidate.startsWith("@v2/java/"),
            ) &&
            site.candidates!.some((candidate) =>
              candidate.startsWith("semanticdb maven"),
            ),
        ),
      );
      TestValidator.predicate(
        "a site with nothing to name carries no candidate list",
        sites.some(
          (site) =>
            site.reason === "analysis-error" && site.candidates === undefined,
        ),
      );
      // A family the producer calls partial with no site of its own still has
      // to say so somewhere, or "some sites are unproven" reads exactly like
      // "every site is proven".
      TestValidator.predicate(
        "a partial family with no located site publishes its gap",
        sites.some(
          (site) =>
            site.reason === "provider-gap" &&
            site.evidence.file.startsWith("bundled:///java/target/"),
        ),
      );

      TestValidator.predicate(
        "the generation is content addressed and immutable",
        typeof snapshot.protocol?.generation === "string" &&
          /^[0-9a-f]{64}$/u.test(snapshot.protocol.generation) &&
          snapshot.protocol.targets.join() === "maven:example",
      );
      // Two compilation units and the target's own coordinate. The first two
      // are absolute host paths a reader can hash for itself; the third is the
      // bundled identity the target-level facts hang off, which has no file.
      const manifest = [...snapshot.sources.keys()];
      TestValidator.equals(
        "a source manifest binds every fact to the bytes javac read",
        manifest.filter((file) => path.isAbsolute(file)).length,
        2,
      );
      TestValidator.predicate(
        "the target's own facts carry a bundled coordinate",
        manifest.length === 3 &&
          manifest.some((file) => file.startsWith("bundled:///java/target/")),
      );

      // Nothing moved, so nothing is rebuilt: the input fingerprint answers
      // before the build tool is asked.
      const unchanged = await session.refresh();
      TestValidator.equals(
        "an unchanged project reuses its generation",
        unchanged.mode,
        "unchanged",
      );
      TestValidator.predicate(
        "the reused snapshot is the same object, not an equal one",
        unchanged.snapshot === snapshot,
      );
    } finally {
      await session.close();
    }

    // One source recompiled. The producer rewrites that shard and leaves the
    // other byte-identical, so the consumer carries the unchanged one forward
    // and the generation says incremental rather than rebuild.
    const marker = path.join(root, "build", "invocations");
    const incremental = open(
      {},
      "--fake-incremental",
      `--fake-marker=${marker}`,
    );
    try {
      await incremental.refresh();
      fs.writeFileSync(
        path.join(root, "src/main/java/com/Caller.java"),
        `${SOURCES["src/main/java/com/Caller.java"]}// edit\n`,
      );
      const second = await incremental.refresh();
      TestValidator.equals(
        "a recompiled source is an incremental generation",
        second.mode,
        "incremental",
      );
      TestValidator.predicate(
        "the new generation names the one before it as its base",
        second.snapshot.protocol?.baseGeneration !== undefined &&
          second.snapshot.protocol.sequence === 2,
      );
    } finally {
      await incremental.close();
    }

    const refuses = async (
      label: string,
      flags: readonly string[],
    ): Promise<void> => {
      const rejecting = open({}, ...flags);
      try {
        let failed = false;
        try {
          await rejecting.refresh();
        } catch {
          failed = true;
        }
        TestValidator.predicate(`${label} is refused`, failed);
        TestValidator.predicate(
          `${label} publishes no partial generation`,
          rejecting.current === undefined,
        );
      } finally {
        await rejecting.close();
      }
    };

    await refuses("a future artifact schema", ["--fake-future-schema"]);
    await refuses("a future producer protocol", ["--fake-future-protocol"]);
    await refuses("a foreign producer", ["--fake-foreign-producer"]);
    await refuses("a producer without atomic generations", [
      "--fake-no-atomic-generations",
    ]);
    await refuses("an artifact produced for another project", [
      "--fake-foreign-root",
    ]);
    await refuses("a generation that committed no target", ["--fake-no-target"]);
    await refuses("a coverage matrix with a family missing", [
      "--fake-hole-in-coverage",
    ]);
    await refuses("a target claiming a family this route cannot prove", [
      "--fake-claims-unsupported",
    ]);
    await refuses("an edge with nothing on one end", [
      "--fake-empty-endpoint",
    ]);
    await refuses("one external symbol named two ways", [
      "--fake-two-named-externals",
    ]);
    await refuses("an edge of an unregistered family", [
      "--fake-unclaimed-family",
    ]);
    await refuses("one symbol declared by two compilation units", [
      "--fake-duplicate-symbol",
    ]);
    await refuses("a shard committed under another target", [
      "--fake-foreign-shard-target",
    ]);
    await refuses("evidence with no source position", ["--fake-bad-evidence"]);
    await refuses("a build that printed where its graph belongs", [
      "--fake-not-json",
    ]);
    await refuses("a build that failed", ["--fake-build-failure"]);

    // A ceiling a real generation exceeds is refused before the artifact is
    // parsed, because the parse is the cost the ceiling exists to bound.
    const bounded = open({ maxArtifactBytes: 1 });
    try {
      let message = "";
      try {
        await bounded.refresh();
      } catch (error) {
        message = (error as Error).message;
      }
      TestValidator.predicate(
        "an artifact past the ceiling is refused by size, not by parsing",
        message.includes("exceeded the 1 byte limit"),
      );
    } finally {
      await bounded.close();
    }

    // A build that wrote nothing where its graph belongs. The sentence has to
    // say the file was empty rather than quote four hundred characters of it.
    const empty = open({}, "--fake-empty-artifact");
    try {
      let message = "";
      try {
        await empty.refresh();
      } catch (error) {
        message = (error as Error).message;
      }
      TestValidator.predicate(
        "an empty artifact is reported as empty",
        message.includes("(the file is empty)"),
      );
    } finally {
      await empty.close();
    }

    // Two JDKs in one build is a thing a Gradle toolchain per source set does,
    // and no single version is then the build's. The field says so by being
    // empty rather than by reporting the first shard's reading.
    const mixed = open({}, "--fake-two-compilers");
    try {
      const generation = await mixed.refresh();
      TestValidator.equals(
        "a build with two JDKs names both rather than picking one",
        generation.snapshot.provenance.compilerVersion,
        "17.0.12; 21.0.5",
      );
    } finally {
      await mixed.close();
    }

    // A universe that moved invalidates every shard the last generation held,
    // whether or not its bytes are identical, so the route reloads instead of
    // sending a delta that would invalidate everything anyway.
    const moved = path.join(root, "build", "moving");
    const reloading = open(
      {},
      "--fake-moving-universe",
      `--fake-marker=${moved}`,
    );
    try {
      await reloading.refresh();
      fs.writeFileSync(
        path.join(root, "src/main/java/com/Example.java"),
        `${SOURCES["src/main/java/com/Example.java"]}// classpath moved
`,
      );
      const second = await reloading.refresh();
      TestValidator.equals(
        "a moved build universe reloads rather than deltas",
        second.mode,
        "reload",
      );
    } finally {
      await reloading.close();
    }

    // A source the build no longer compiles is deleted from the generation
    // rather than left behind as a fact nothing refreshes.
    const dropped = path.join(root, "build", "dropping");
    const deleting = open(
      {},
      "--fake-deleted-source",
      `--fake-marker=${dropped}`,
    );
    try {
      const before = await deleting.refresh();
      fs.writeFileSync(
        path.join(root, "src/main/java/com/Caller.java"),
        `${SOURCES["src/main/java/com/Caller.java"]}// dropped
`,
      );
      const after = await deleting.refresh();
      TestValidator.predicate(
        "a source the build dropped leaves the generation",
        before.snapshot.protocol!.shards.length -
          after.snapshot.protocol!.shards.length ===
          1,
      );
    } finally {
      await deleting.close();
    }

    // Two targets compiling the same source is the case target-scoped identity
    // exists for: one file, two universes, and no node that belongs to both.
    const multi = open({}, "--fake-two-targets");
    try {
      const generation = await multi.refresh();
      const targets = generation.snapshot.protocol?.targets ?? [];
      TestValidator.equals(
        "each committed target is published",
        targets.join(),
        "maven:module-a,maven:module-b",
      );
      const declarations = generation.snapshot.nodes.filter(
        (node) => !node.external,
      );
      TestValidator.equals(
        "one source in two targets is two declarations",
        declarations.length,
        2,
      );
      TestValidator.predicate(
        "the two declarations do not share an identity",
        declarations[0]!.id !== declarations[1]!.id,
      );
    } finally {
      await multi.close();
    }
  };
