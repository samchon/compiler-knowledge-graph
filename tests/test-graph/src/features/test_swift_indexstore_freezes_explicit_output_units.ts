import { TestValidator } from "@nestia/e2e";
import {
  ISwiftGraphSnapshot,
  SWIFT_GRAPH_PROVIDER,
  SwiftGraphSnapshotAdapter,
  resolveSwiftGraphCommand,
  selectGraphProviders,
  swiftGraphProvider,
} from "@samchon/graph";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";

const SOURCE = `import Foundation
@MainActor
public protocol Service {
  associatedtype Output
  func fetch<T>(_ value: T) async -> Output
}
open class Base {
  public init() {}
  open var value: Int { get { 0 } set {} }
  open func run() {}
}
public final class Api: Base, Service {
  public typealias Output = String
  public override var value: Int {
    get { 1 }
    set {}
  }
  public override final func run() {
    var local = value
    local += 1
    print(local)
  }
  public func fetch<T>(_ value: T) async -> String { String(describing: value) }
}
extension Api {
  public convenience init(seed: Int) {
    self.init()
  }
}
#if FEATURE_FLAG
@attached(member, names: named(generated))
public macro FixtureMacro() = #externalMacro(module: "FixtureMacros", type: "FixtureMacro")
@FixtureMacro
public struct MacroHost {}
#endif
public func testApi() async {
  let subject = Api(seed: 1)
  subject.value = 2
  _ = subject.value
  subject.run()
  _ = await subject.fetch("x")
}
// fixture warning
`;

/**
 * The Swift route admits an exact output-unit set and keeps USRs separate for
 * build triples while one source enrichment pass supplies syntax-only facts.
 */
export const test_swift_indexstore_freezes_explicit_output_units =
  async (): Promise<void> => {
    const packaged = path.join(GraphPaths.graphPackageRoot, "sidecars", "swift");
    TestValidator.predicate(
      "the package carries the complete buildable Swift producer source",
      [
        "README.md",
        "Package.resolved",
        "Package.swift",
        "Sources/SamchonSwiftGraph/main.swift",
        "Sources/SamchonSwiftGraph/SwiftGraphProducer.swift",
      ].every((file) => fs.existsSync(path.join(packaged, file))) &&
        !fs.existsSync(path.join(packaged, ".build")),
    );
    const producerSource = fs.readFileSync(
      path.join(
        packaged,
        "Sources",
        "SamchonSwiftGraph",
        "SwiftGraphProducer.swift",
      ),
      "utf8",
    );
    TestValidator.predicate(
      "the shipped producer selects current SwiftPM objects without a store poll",
      producerSource.includes('"-index-include-locals"') &&
        producerSource.includes('document["swiftCommands"]') &&
        producerSource.includes('command["objects"]') &&
        producerSource.includes('command["sources"]') &&
        producerSource.includes('"--build-tests"') &&
        producerSource.includes("useExplicitOutputUnits: true") &&
        producerSource.includes("addUnitOutFilePaths") &&
        !producerSource.includes("pollForUnitChangesAndWait"),
    );

    const root = GraphPaths.createTempDirectory("samchon-graph-swift-");
    fs.mkdirSync(path.join(root, "Sources", "Demo"), { recursive: true });
    fs.writeFileSync(path.join(root, "Sources", "Demo", "Api.swift"), SOURCE);
    fs.writeFileSync(
      path.join(root, "Package.swift"),
      '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Demo")\n',
    );
    fs.writeFileSync(path.join(root, "Package.resolved"), '{"pins":[]}\n');

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
        `"${process.execPath}" "${GraphPaths.fakeSwiftGraph}" ${flags.join(" ")} ${windows ? "%*" : '\"$@\"'}`,
      );
    const swift = script("swift", "echo Swift version 6.0");
    const current = producer("samchon-swift-graph");
    const environment = {
      ...process.env,
      SAMCHON_GRAPH_SWIFT_GRAPH: current,
      SAMCHON_GRAPH_SWIFT_TOOLCHAIN: swift,
    };

    const missing = GraphPaths.createTempDirectory("samchon-graph-swift-no-package-");
    fs.writeFileSync(path.join(missing, "Api.swift"), "struct Api {}\n");
    TestValidator.predicate(
      "a repository without Package.swift declines the strict route",
      resolveSwiftGraphCommand(missing, environment, "linux") === undefined,
    );
    const selected = selectGraphProviders(root, ["swift"], {}, environment);
    TestValidator.predicate(
      "unsupported Windows declines while macOS and Linux accept the sidecar",
      selected.candidates.some(
        (candidate) => candidate.provider.name === SWIFT_GRAPH_PROVIDER,
      ) === !windows,
    );
    TestValidator.predicate(
      "a producer without the explicit resident capability declines",
      resolveSwiftGraphCommand(
        root,
        {
          ...environment,
          SAMCHON_GRAPH_SWIFT_GRAPH: producer("legacy", ["--fake-legacy-server"]),
        },
        "linux",
      ) === undefined,
    );
    TestValidator.predicate(
      "a sidecar that rejects the package declines",
      resolveSwiftGraphCommand(
        root,
        {
          ...environment,
          SAMCHON_GRAPH_SWIFT_GRAPH: producer("unsupported", ["--fake-unsupported"]),
        },
        "linux",
      ) === undefined,
    );
    TestValidator.predicate(
      "the resolver accepts its exact macOS and Linux contract only",
      resolveSwiftGraphCommand(root, environment, "linux") !== undefined &&
        resolveSwiftGraphCommand(root, environment, "darwin") !== undefined &&
        resolveSwiftGraphCommand(root, environment, "win32") === undefined,
    );
    TestValidator.predicate(
      "whole-module options are refused explicitly",
      selectGraphProviders(
        root,
        ["swift"],
        { server: "sourcekit-lsp", maxFiles: 3, lspReferenceLimit: 4 },
        environment,
      ).warnings.some(
        (warning) =>
          warning.includes(SWIFT_GRAPH_PROVIDER) &&
          warning.includes("server, maxFiles, lspReferenceLimit"),
      ),
    );
    const configuration = swiftGraphProvider.configuration?.(root, environment);
    const inputs = swiftGraphProvider.buildInputs?.(root) ?? [];
    TestValidator.predicate(
      "the universe observes Swift, the producer, the pin and package inputs",
      configuration?.length === 3 &&
        configuration[0]!.startsWith("swift=") &&
        configuration[1]!.startsWith("samchon-swift-graph=") &&
        configuration[2] ===
          `indexstore-db=${ISwiftGraphSnapshot.INDEX_STORE_DB_COMMIT}` &&
        inputs.includes("Package.swift") &&
        inputs.includes("Package.resolved") &&
        swiftGraphProvider
          .configurationDerivation?.(root, environment)
          .inconclusive.length === 0,
    );

    const artifactFile = path.join(root, "swift-artifact.json");
    const produced = spawnSync(
      process.execPath,
      [GraphPaths.fakeSwiftGraph, "snapshot", "--output", artifactFile],
      { cwd: root, encoding: "utf8" },
    );
    TestValidator.equals("the producer writes an exact fixture", produced.status, 0);
    const valid = JSON.parse(
      fs.readFileSync(artifactFile, "utf8"),
    ) as ISwiftGraphSnapshot;
    TestValidator.predicate(
      "the surrounding stale unit is excluded from every frozen generation",
      fs.existsSync(
        path.join(
          root,
          ".build/x86_64-unknown-linux-gnu/debug/Stale.build/Old.swift.o",
        ),
      ) &&
        valid.targets.every(
          (target) =>
            target.outputUnits.length === 1 &&
            !target.outputUnits[0]!.path.includes("Stale"),
        ),
    );
    const accepting = new SwiftGraphSnapshotAdapter(root);
    const published = accepting.apply(structuredClone(valid));
    const apis = published.nodes.filter(
      (node) => node.name === "Api" && !node.external,
    );
    TestValidator.predicate(
      "one USR compiled for two triples receives two stable identities",
      apis.length === 2 &&
        apis[0]!.id !== apis[1]!.id &&
        apis.every((node) => node.id.startsWith("@v2/swift/")) &&
        published.protocol?.targets.length === 2,
    );
    TestValidator.predicate(
      "all fact families and syntax enrichment are explicit",
      published.coverage?.length === 30 &&
        published.coverage.filter(
          (row) => row.family === "renders" && row.state === "unsupported",
        ).length === 2 &&
        published.edges.some((edge) => edge.kind === "imports") &&
        published.edges.some((edge) => edge.kind === "decorates") &&
        ["explicitOutputUnits", "indexStoreDB", "sourceEnrichment", "swiftpm"].every(
          (capability) => published.provenance.capabilities.includes(capability),
        ) &&
        published.diagnostics.every((diagnostic) => diagnostic.code === "swiftc"),
    );
    const declarations = new Set(
      published.nodes.filter((node) => !node.external).map((node) => node.name),
    );
    const edgeKinds = new Set(published.edges.map((edge) => edge.kind));
    TestValidator.predicate(
      "the exact fixture covers Swift declarations and every supported fact",
      [
        "Service",
        "Base",
        "Api",
        "Api extension",
        "init(seed:)",
        "value",
        "get value",
        "set value",
        "fetch",
        "local",
        "FixtureMacro",
        "MacroHost",
        "testApi",
      ].every((name) => declarations.has(name)) &&
        [
          "contains",
          "exports",
          "imports",
          "calls",
          "accesses",
          "instantiates",
          "type_ref",
          "extends",
          "implements",
          "overrides",
          "dispatches",
          "decorates",
          "tests",
          "references",
        ].every((kind) => edgeKinds.has(kind)) &&
        valid.targets.every(
          (target) =>
            target.shards.some((shard) =>
              shard.edges.some(
                (edge) => edge.kind === "accesses" && edge.access === "read",
              ),
            ) &&
            target.shards.some((shard) =>
              shard.edges.some(
                (edge) => edge.kind === "accesses" && edge.access === "write",
              ),
            ),
        ) &&
        published.nodes.some(
          (node) =>
            node.name === "fetch" &&
            node.signature?.includes("<T>") === true &&
            node.modifiers?.includes("async") === true,
        ) &&
        published.unresolved.some(
          (site) =>
            site.reason === "conditional-build" &&
            site.family === "references",
        ) &&
        published.unresolved.some(
          (site) =>
            site.reason === "macro-or-generated" &&
            site.family === "references",
        ) &&
        published.unresolved.some(
          (site) => site.reason === "dynamic" && site.family === "dispatches",
        ),
    );

    const command = { command: process.execPath, args: [GraphPaths.fakeSwiftGraph] };
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries({
      SAMCHON_GRAPH_SWIFT_GRAPH: current,
      SAMCHON_GRAPH_SWIFT_TOOLCHAIN: swift,
    })) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const session = swiftGraphProvider.open({
        root,
        command,
        languages: ["swift"],
        options: { cwd: root },
      });
      try {
        const cold = await session.refresh();
        TestValidator.predicate(
          "the Swift session exposes its committed resident state",
          session.generation === 1 && session.current === cold.snapshot,
        );
        const unchanged = await session.refresh();
        fs.appendFileSync(path.join(root, "Sources", "Demo", "Api.swift"), "// edit\n");
        const edited = await session.refresh();
        TestValidator.predicate(
          "the resident process reuses no-op and commits edited output units",
          cold.mode === "initial" &&
            unchanged.changed === false &&
            unchanged.snapshot === cold.snapshot &&
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

    TestValidator.equals(
      "the producer refreshes the rejection oracle after the lifecycle edit",
      spawnSync(
        process.execPath,
        [GraphPaths.fakeSwiftGraph, "snapshot", "--output", artifactFile],
        { cwd: root, encoding: "utf8" },
      ).status,
      0,
    );
    const guardedArtifact = JSON.parse(
      fs.readFileSync(artifactFile, "utf8"),
    ) as ISwiftGraphSnapshot;
    const guarded = new SwiftGraphSnapshotAdapter(root);
    const guardedPublished = guarded.apply(structuredClone(guardedArtifact));
    const rejects = (
      label: string,
      mutate: (value: ISwiftGraphSnapshot) => void,
    ): void => {
      const candidate = structuredClone(guardedArtifact);
      mutate(candidate);
      TestValidator.error(label, () => guarded.apply(candidate));
      TestValidator.predicate(
        `${label} keeps the prior generation`,
        guarded.current === guardedPublished,
      );
    };
    for (const capability of [
      "explicitOutputUnits",
      "indexStoreDB",
      "sourceEnrichment",
      "swiftpm",
    ] as const) {
      rejects(`a producer without ${capability}`, (value) => {
        value.producer.capabilities[capability] = false;
      });
    }
    rejects("a standalone producer claiming SourceKit residency", (value) => {
      value.producer.capabilities.sourceKitResident = true;
    });
    rejects("a target with a different identity", (value) => {
      value.targets[0]!.name = "Other@arm64-apple-macosx13.0/debug";
    });
    for (const field of ["moduleName", "targetTriple", "configuration", "swiftLanguageVersion"] as const) {
      rejects(`a target without ${field}`, (value) => {
        value.targets[0]![field] = "";
      });
    }
    rejects("a target from another IndexStoreDB commit", (value) => {
      value.targets[0]!.indexStoreDBCommit = "0".repeat(40);
    });
    for (const field of [
      "compilerFlagsDigest",
      "moduleDependenciesDigest",
      "packageResolutionDigest",
      "pluginsDigest",
      "generatedSourcesDigest",
    ] as const) {
      rejects(`a malformed ${field}`, (value) => {
        value.targets[0]![field] = "not-a-digest";
      });
    }
    rejects("an empty explicit output-unit set", (value) => {
      value.targets[0]!.outputUnits = [];
    });
    rejects("an empty output-unit path", (value) => {
      value.targets[0]!.outputUnits[0]!.path = "";
    });
    rejects("an absolute output-unit path", (value) => {
      value.targets[0]!.outputUnits[0]!.path = path.resolve(root, "unit.o");
    });
    rejects("an escaping output-unit path", (value) => {
      value.targets[0]!.outputUnits[0]!.path = "../unit.o";
    });
    rejects("an output-unit path naming the project root", (value) => {
      value.targets[0]!.outputUnits[0]!.path = ".";
    });
    rejects("an output-unit path naming the parent exactly", (value) => {
      value.targets[0]!.outputUnits[0]!.path = "..";
    });
    rejects("a malformed output-unit digest", (value) => {
      value.targets[0]!.outputUnits[0]!.digest = "not-a-digest";
    });
    rejects("a stale output-unit digest", (value) => {
      value.targets[0]!.outputUnits[0]!.digest = "0".repeat(64);
    });
    rejects("a missing output unit", (value) => {
      value.targets[0]!.outputUnits[0]!.path = ".build/missing.o";
    });
    rejects("an unsorted output-unit set", (value) => {
      const first = value.targets[0]!.outputUnits[0]!;
      fs.writeFileSync(path.join(root, "z.o"), "second unit");
      value.targets[0]!.outputUnits = [
        {
          path: "z.o",
          digest: createHash("sha256")
            .update(fs.readFileSync(path.join(root, "z.o")))
            .digest("hex"),
        },
        first,
      ];
    });
    rejects("a source enriched more than once", (value) => {
      value.targets[0]!.shards[0]!.sourceEnrichmentPasses = 2;
    });
    rejects("a source attributed to another module", (value) => {
      value.targets[0]!.shards[0]!.moduleName = "Other";
    });
    rejects("a source attributed to another triple", (value) => {
      value.targets[0]!.shards[0]!.targetTriple = "other-triple";
    });
  };
