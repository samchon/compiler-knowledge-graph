import { TestValidator } from "@nestia/e2e";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SamchonGraphMemory } from "../../../../packages/graph/src/SamchonGraphMemory";
import { buildLspGraph } from "../../../../packages/graph/src/indexer/buildLspGraph";
import { TtscGraphClient } from "../../../../packages/graph/src/provider/ttscgraph/TtscGraphClient";
import { resolveTtscGraphCommand } from "../../../../packages/graph/src/provider/ttscgraph/resolveTtscGraphCommand";
import { ttscGraphProvider } from "../../../../packages/graph/src/provider/ttscgraph/ttscGraphProvider";
import { ISamchonGraphDump } from "../../../../packages/graph/src/structures";
import { GRAPH_EDGE_KINDS } from "../../../../packages/graph/src/typings/GRAPH_EDGE_KINDS";
import { GraphPaths } from "../internal/GraphPaths";

export const test_ttscgraph_bulk_provider_reuses_and_atomically_replaces_snapshots =
  async () => {
    const root = GraphPaths.createTempDirectory(
      "samchon-graph-ttscgraph-provider-",
    );
    fs.mkdirSync(path.join(root, "src", "core"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@core/*": ["src/core/*"] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, "src", "index.ts"),
      "export * from '@core/order';\n",
    );
    fs.writeFileSync(
      path.join(root, "src", "core", "order.ts"),
      "export async function first() {}\n",
    );
    fs.writeFileSync(path.join(root, "src", "empty.ts"), "export {};\n");
    assertResolverPrecedence(root);
    const marker = path.join(root, "closed.txt");
    const requestLog = path.join(root, "requests.txt");
    const client = new TtscGraphClient({
      root,
      command: process.execPath,
      args: [
        GraphPaths.fakeTtscGraphServer,
        `--marker=${marker}`,
        `--request-log=${requestLog}`,
      ],
    });

    const initial = await client.refresh();
    TestValidator.equals("the first full dump starts generation one", initial.generation, 1);
    TestValidator.equals("the compiler language is added losslessly", initial.snapshot.nodes[0]?.language, "typescript");
    TestValidator.equals("the module export surface folds onto its file", initial.snapshot.edges[0]?.from, "src/index.ts");
    TestValidator.equals("edge evidence keeps the module source file", initial.snapshot.edges[0]?.evidence?.file, "src/index.ts");
    TestValidator.predicate(
      "a declaration-free strict module keeps its canonical file manifest",
      initial.snapshot.nodes.some(
        (node) => node.id === "src/empty.ts" && node.kind === "file",
      ),
    );
    TestValidator.predicate(
      "a canonical bundled standard-library dependency remains an external fact",
      initial.snapshot.nodes.some(
        (node) =>
          node.id ===
            "bundled:///libs/lib.es2015.collection.d.ts#Map:interface" &&
          node.external &&
          node.evidence?.file ===
            "bundled:///libs/lib.es2015.collection.d.ts",
      ),
    );
    TestValidator.predicate(
      "a compiler-resolved paths-alias barrel keeps its cross-file export edge",
      initial.snapshot.edges.some(
        (edge) =>
          edge.kind === "exports" &&
          edge.from === "src/index.ts" &&
          edge.to === "src/core/order.ts#first:function",
      ),
    );
    TestValidator.predicate(
      "compiler flags and decorator literals survive adaptation",
      initial.snapshot.nodes[0]?.ignored === true &&
        initial.snapshot.nodes[0]?.closure === true &&
        initial.snapshot.nodes[0]?.decorators?.[0]?.arguments[0]?.literal === 1,
    );
    TestValidator.equals(
      "the snapshot names its files by the digest the compiler read, not by their text",
      initial.snapshot.sources.get(path.join(root, "src", "core", "order.ts")),
      {
        checkerDigest: sha256("export async function first() {}\n"),
        diskDigest: sha256("export async function first() {}\n"),
      },
    );
    TestValidator.equals(
      "the snapshot reports the producer behind its facts",
      initial.snapshot.provenance.tool,
      "ttscgraph",
    );
    TestValidator.equals(
      "the snapshot reports the protocol it was carried over",
      initial.snapshot.provenance.protocolVersion,
      1,
    );
    TestValidator.equals(
      "the snapshot reports the dump schema its facts obey",
      initial.snapshot.provenance.schemaVersion,
      6,
    );
    TestValidator.equals(
      "the reference provider publishes one exhaustive protocol coverage matrix",
      [
        initial.snapshot.protocol?.sequence,
        initial.snapshot.protocol?.targets,
        initial.snapshot.coverage?.length,
        initial.snapshot.coverage?.filter((row) => row.state === "complete")
          .length,
        initial.snapshot.coverage?.filter((row) => row.state === "partial")
          .length,
        initial.snapshot.coverage?.filter(
          (row) => row.state === "unsupported",
        ).length,
        initial.snapshot.unresolved?.length,
        initial.snapshot.unresolved?.every(
          (site) => site.reason === "provider-gap",
        ),
      ],
      [
        1,
        ["tsconfig.json"],
        GRAPH_EDGE_KINDS.length,
        0,
        ttscGraphProvider.facts.length,
        GRAPH_EDGE_KINDS.length - ttscGraphProvider.facts.length,
        ttscGraphProvider.facts.length,
        true,
      ],
    );
    const initialShards = new Map(
      initial.snapshot.protocol?.shards.map((shard) => [
        shard.key,
        shard.digest,
      ]),
    );
    TestValidator.equals(
      "the first snapshot reports the compiler's own mode, not an inferred one",
      initial.mode,
      "initial",
    );
    TestValidator.equals(
      "compiler diagnostics ride the generation that produced the facts",
      initial.snapshot.diagnostics,
      [
        {
          file: "src/core/order.ts",
          line: 1,
          column: 1,
          code: 2322,
          message: "synthetic finding for first",
          severity: "error",
        },
      ],
    );

    const unchanged = await client.refresh();
    TestValidator.predicate(
      "unchanged reuses the identical snapshot object",
      !unchanged.changed && unchanged.snapshot === initial.snapshot,
    );
    TestValidator.equals("unchanged keeps the generation", unchanged.generation, 1);

    TestValidator.equals(
      "an unchanged refresh reports the compiler's unchanged mode",
      unchanged.mode,
      "unchanged",
    );

    const changed = await client.refresh();
    TestValidator.predicate(
      "a validated full dump atomically replaces the snapshot",
      changed.changed &&
        changed.generation === 2 &&
        changed.snapshot !== initial.snapshot &&
        changed.snapshot.nodes[0]?.name === "second",
    );
    TestValidator.equals(
      "a reused program is reported as incremental because the compiler said so",
      changed.mode,
      "incremental",
    );
    const changedShards = new Map(
      changed.snapshot.protocol?.shards.map((shard) => [
        shard.key,
        shard.digest,
      ]),
    );
    TestValidator.equals(
      "the incremental generation is based on the prior commit and reuses unaffected file shards",
      [
        changed.snapshot.protocol?.baseSequence,
        changed.snapshot.protocol?.baseGeneration,
        [...changedShards].filter(
          ([key, digest]) => initialShards.get(key) === digest,
        ).length,
        [...changedShards].filter(
          ([key, digest]) =>
            initialShards.has(key) && initialShards.get(key) !== digest,
        ).length,
      ],
      [1, initial.snapshot.protocol?.generation, 4, 2],
    );
    await rejects(client.refresh(), "serve errors are surfaced");
    TestValidator.predicate(
      "an untrusted child generation preserves the previous trusted snapshot",
      client.current === changed.snapshot && client.generation === 2,
    );
    await client.close();
    TestValidator.equals(
      "an invalid producer's input is closed before its tree is terminated",
      fs.existsSync(marker),
      true,
    );
    // Four refreshes, four requests. The client used to spend a second
    // round-trip per *changed* snapshot asking the server whether the dump it
    // had just parsed still held — a question that narrowed the race without
    // closing it and that the manifest now answers in the same envelope. With
    // that confirmation still in place this reads 6, not 4.
    TestValidator.equals(
      "one refresh costs exactly one round-trip",
      fs.readFileSync(requestLog, "utf8"),
      "4\n",
    );

    const integrated = await buildLspGraph(
      {
        cwd: root,
        languages: ["typescript"],
      },
      {
        // Only the command is substituted. The registered provider's refusal,
        // authority, provable fact families, and session construction all run
        // as shipped, so this exercises the integration rather than a stub
        // standing where it belongs.
        providers: [
          {
            ...ttscGraphProvider,
            resolve: () => ({
              command: process.execPath,
              args: [GraphPaths.fakeTtscGraphServer],
            }),
          },
        ],
      },
    );
    TestValidator.equals(
      "a pure strict build reports its language",
      integrated.dump.languages,
      ["typescript"],
    );
    TestValidator.equals(
      "a pure strict build remains an LSP index",
      integrated.dump.indexer,
      "lsp",
    );
    TestValidator.predicate(
      "buildLspGraph preserves the compiler-resolved paths-alias export edge",
      integrated.dump.edges.some(
        (edge) =>
          edge.kind === "exports" &&
          edge.from === "src/index.ts" &&
          edge.to === "src/core/order.ts#first:function",
      ),
    );
    const memory = SamchonGraphMemory.from(integrated.dump);
    for (const file of [
      "src/index.ts",
      "src/core/order.ts",
      "src/empty.ts",
    ]) {
      TestValidator.equals(
        `strict module file ${file} appears exactly once in final memory`,
        memory.nodes.filter(
          (node) => node.id === file && node.kind === "file",
        ).length,
        1,
      );
    }
    TestValidator.predicate(
      "the empty strict module has the canonical file-node shape",
      memory.node("src/empty.ts")?.language === "typescript" &&
        memory.node("src/empty.ts")?.name === "empty.ts" &&
        memory.node("src/empty.ts")?.external === false,
    );
    TestValidator.equals(
      "an edge-and-declaration-free module invents no structural edge",
      memory.outgoing("src/empty.ts").length,
      0,
    );
    TestValidator.equals(
      "a strict module with a declaration contains it exactly once",
      memory
        .outgoing("src/core/order.ts")
        .filter((edge) => edge.kind === "contains")
        .map((edge) => edge.to),
      ["src/core/order.ts#first:function"],
    );

    const genericModuleId = "src/namespace.ts#Namespace:module";
    const genericMemory = SamchonGraphMemory.from({
      project: root,
      languages: ["typescript"],
      indexer: "lsp",
      nodes: [
        {
          id: genericModuleId,
          kind: "module",
          language: "typescript",
          name: "Namespace",
          file: "src/namespace.ts",
          external: false,
        },
      ],
      edges: [],
    } satisfies ISamchonGraphDump);
    TestValidator.predicate(
      "generic TypeScript module declarations remain symbols",
      genericMemory.node(genericModuleId)?.kind === "module" &&
        genericMemory
          .outgoing("src/namespace.ts")
          .some(
            (edge) => edge.kind === "contains" && edge.to === genericModuleId,
          ),
    );

    await assertInvalid(root, "--invalid", "a dangling compiler endpoint");
    await assertInvalid(root, "--invalid-span", "a reversed evidence span");
    await assertInvalid(root, "--invalid-path", "an escaping evidence path");
    await assertInvalid(
      root,
      "--invalid-node-evidence",
      "node evidence owned by another file",
    );
    await assertInvalid(
      root,
      "--invalid-edge-evidence",
      "edge evidence owned by another source file",
    );
    await assertInvalid(
      root,
      "--invalid-bundled-workspace",
      "a workspace node using an external bundled URI",
    );
    // The provenance is evidence, so a malformed one fails exactly as closed as
    // a malformed fact does. A snapshot that cannot prove which program built it
    // is not a snapshot with a cosmetic gap; it is one nothing downstream may
    // quote.
    await assertInvalid(
      root,
      "--invalid-manifest",
      "facts naming a file the manifest never loaded",
    );
    await assertInvalid(
      root,
      "--invalid-manifest-digest",
      "a manifest digest that is not a SHA-256",
    );
    await assertInvalid(
      root,
      "--invalid-manifest-duplicate",
      "a manifest naming one file twice",
    );
    await assertInvalid(
      root,
      "--invalid-disk-digest",
      "a disk digest that is not a SHA-256",
    );
    await assertInvalid(
      root,
      "--invalid-diagnostic-file",
      "a diagnostic about a file the program never loaded",
    );
    await assertInvalid(
      root,
      "--invalid-diagnostic-category",
      "a diagnostic category the compiler does not publish",
    );
    await assertInvalid(
      root,
      "--invalid-universe-configs",
      "a build universe naming no config",
    );
    await assertInvalid(
      root,
      "--invalid-universe-digest",
      "a config digest that is not a SHA-256",
    );
  };

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function assertResolverPrecedence(root: string): void {
  const resolverRoot = path.join(root, "resolver-project");
  const packageRoot = path.join(resolverRoot, "node_modules");
  const platformPackage = path.join(
    packageRoot,
    "@ttsc",
    `${process.platform}-${process.arch}`,
  );
  const executable = process.platform === "win32" ? "ttscgraph.exe" : "ttscgraph";
  const projectBinary = path.join(platformPackage, "bin", executable);
  fs.mkdirSync(path.join(packageRoot, "ttsc"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "ttsc", "package.json"),
    JSON.stringify({ name: "ttsc", version: "0.19.0" }),
  );
  fs.mkdirSync(platformPackage, { recursive: true });
  fs.writeFileSync(
    path.join(platformPackage, "package.json"),
    JSON.stringify({
      name: `@ttsc/${process.platform}-${process.arch}`,
      version: "0.19.0",
    }),
  );
  writeExecutable(projectBinary);

  const globalBin = path.join(root, "stale-global-bin");
  const staleBinary = path.join(globalBin, executable);
  writeExecutable(staleBinary);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: globalBin };
  delete env.TTSC_GRAPH_BINARY;
  TestValidator.equals(
    "the target project's platform binary precedes a stale global PATH binary",
    resolveTtscGraphCommand(resolverRoot, env)?.command,
    projectBinary,
  );

  const overrideBinary = path.join(root, "override", executable);
  writeExecutable(overrideBinary);
  env.TTSC_GRAPH_BINARY = overrideBinary;
  TestValidator.equals(
    "an absolute executable override has highest precedence",
    resolveTtscGraphCommand(resolverRoot, env)?.command,
    overrideBinary,
  );
  env.TTSC_GRAPH_BINARY = path.join(root, "missing", executable);
  TestValidator.equals(
    "a missing override cannot hide the target project's compatible binary",
    resolveTtscGraphCommand(resolverRoot, env)?.command,
    projectBinary,
  );
}

function writeExecutable(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
}

async function assertInvalid(
  root: string,
  mode: string,
  description: string,
): Promise<void> {
  const invalid = new TtscGraphClient({
    root,
    command: process.execPath,
    args: [GraphPaths.fakeTtscGraphServer, mode],
  });
  try {
    await rejects(
      invalid.refresh(),
      `${description} fails closed`,
    );
    TestValidator.predicate(
      "an invalid full dump publishes no partial state",
      invalid.current === undefined && invalid.generation === 0,
    );
  } finally {
    await invalid.close();
  }
}

async function rejects(task: Promise<unknown>, label: string): Promise<void> {
  let error: unknown;
  try {
    await task;
  } catch (caught) {
    error = caught;
  }
  TestValidator.predicate(label, error instanceof Error);
}
