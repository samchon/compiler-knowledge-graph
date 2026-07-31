import { TestValidator } from "@nestia/e2e";
import { createHash } from "node:crypto";
import path from "node:path";

// `adaptTtscGraphDump` is internal to the package, so it is reached by path
// rather than through the public barrel.
import { adaptTtscGraphDump } from "../../../../packages/graph/src/provider/ttscgraph/adaptTtscGraphDump";
import { GraphPaths } from "../internal/GraphPaths";

const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

// #70 made the dump carry its own proof: the adapter now validates a
// `provenance` — the source manifest, the build universe, and the producer's
// capabilities — before it will adapt a single fact, because a slice of facts
// with no program behind it is a slice nothing downstream may quote. Every
// well-formed fixture below therefore rides a well-formed provenance whose
// manifest names the one workspace file its nodes name (`src/a.ts`). That keeps
// the proof boundary satisfied so each malformed case can reach and fail at the
// node, edge, or span it targets.
const provenance = (files: readonly string[] = ["src/a.ts"]) => ({
  schemaVersion: 6,
  capabilities: ["universe", "sourceDigests", "diskDigests", "diagnostics"],
  producer: {
    tool: "ttscgraph",
    version: "0.20.1",
    typescript: "5.9.0",
  },
  universe: {
    configs: [{ file: "tsconfig.json", digest: sha("tsconfig.json") }],
    roots: files.map((file) => ({ config: "tsconfig.json", file })),
  },
  sources: files.map((file) => ({
    file,
    checkerDigest: sha(`${file}:checker`),
    diskDigest: sha(`${file}:disk`),
  })),
});

/**
 * The strict adapter is the trust boundary between raw compiler output and the
 * semantic graph. It preserves the facts a healthy dump carries and rejects
 * every malformed identity, type, endpoint, span, and collision instead of
 * repairing or silently dropping it.
 */
export const test_ttscgraph_dump_adapter_rejects_malformed_facts = async () => {
  const project = GraphPaths.createTempDirectory("samchon-graph-ttscgraph-adapt-");

  const good = () => ({
    project,
    tsconfig: "tsconfig.json",
    provenance: provenance(),
    diagnostics: [] as unknown[],
    nodes: [
      { id: "src/a.ts#src/a.ts:module", kind: "module", name: "src/a.ts", file: "src/a.ts", external: false },
      { id: "src/a.ts#foo:function", kind: "function", name: "foo", file: "src/a.ts", external: false },
    ] as unknown[],
    edges: [
      { from: "src/a.ts#src/a.ts:module", to: "src/a.ts#foo:function", kind: "exports" },
    ] as unknown[],
  });
  const mutate = (change: (dump: ReturnType<typeof good>) => void): unknown => {
    const dump = good();
    change(dump);
    return dump;
  };
  const relationDump = (schemaVersion: number) => {
    const dump = good();
    dump.provenance.schemaVersion = schemaVersion;
    dump.nodes.push(
      {
        id: "src/a.ts#Worker:class",
        kind: "class",
        name: "Worker",
        file: "src/a.ts",
        external: false,
      },
      {
        id: "src/a.ts#Contract:interface",
        kind: "interface",
        name: "Contract",
        file: "src/a.ts",
        external: false,
      },
      {
        id: "src/a.ts#Worker.execute:method",
        kind: "method",
        name: "execute",
        file: "src/a.ts",
        external: false,
      },
      {
        id: "src/a.ts#Contract.execute:method",
        kind: "method",
        name: "execute",
        file: "src/a.ts",
        external: false,
      },
    );
    return dump;
  };

  // A healthy dump adapts without throwing (the negative twin of every case).
  TestValidator.predicate(
    "a well-formed dump adapts cleanly",
    adaptTtscGraphDump(good(), project).nodes.length === 2,
  );
  rejectsWithMessage(
    () =>
      adaptTtscGraphDump(
        mutate((d) => {
          d.provenance.schemaVersion = 3;
        }),
        project,
      ),
    "schema 3 snapshot",
    "dump is schema v3, this client reads v6",
  );
  rejectsWithMessage(
    () => {
      const dump = relationDump(3);
      dump.nodes.push({
        id: "vendor/typescript/lib/lib.es5.d.ts#Array:interface",
        kind: "interface",
        name: "Array",
        file: "vendor/typescript/lib/lib.es5.d.ts",
        external: true,
      });
      return adaptTtscGraphDump(dump, project);
    },
    "schema 3 snapshot carrying an external fact absent from its manifest",
    "dump is schema v3, this client reads v6",
  );
  const currentRelations = relationDump(6);
  currentRelations.edges.push(
    {
      from: "src/a.ts#Worker.execute:method",
      to: "src/a.ts#Contract.execute:method",
      kind: "implements",
    },
    {
      from: "src/a.ts#Worker.execute:method",
      to: "src/a.ts#Contract.execute:method",
      kind: "overrides",
    },
  );
  const adaptedCurrentRelations = adaptTtscGraphDump(
    currentRelations,
    project,
  );
  TestValidator.predicate(
    "schema 6 retains checker-owned member relations",
    adaptedCurrentRelations.edges.some((edge) => edge.kind === "implements") &&
      adaptedCurrentRelations.edges.some((edge) => edge.kind === "overrides"),
  );
  const crossRootFile = "../shared/index.d.ts";
  const crossRoot = good();
  crossRoot.provenance.universe.roots.push({
    config: "tsconfig.json",
    file: crossRootFile,
  });
  crossRoot.provenance.sources.push({
    file: crossRootFile,
    checkerDigest: sha(`${crossRootFile}:checker`),
    diskDigest: sha(`${crossRootFile}:disk`),
  });
  crossRoot.nodes.push({
    id: `${crossRootFile}#Shared:interface`,
    kind: "interface",
    name: "Shared",
    file: crossRootFile,
    external: false,
  });
  TestValidator.predicate(
    "a compiler-loaded sibling workspace file keeps its portable relative identity",
    adaptTtscGraphDump(crossRoot, project).nodes.some(
      (node) => node.file === crossRootFile,
    ),
  );
  const bundledFile = "bundled:///libs/lib.es2015.collection.d.ts";
  const completeManifest = good();
  completeManifest.provenance.sources.push(
    {
      file: crossRootFile,
      checkerDigest: sha(`${crossRootFile}:checker`),
      diskDigest: sha(`${crossRootFile}:disk`),
    },
    {
      file: bundledFile,
      checkerDigest: sha(`${bundledFile}:checker`),
      diskDigest: "",
    },
  );
  const completeSources = adaptTtscGraphDump(
    completeManifest,
    project,
  ).sources;
  TestValidator.predicate(
    "the complete compiler manifest resolves every schema-v6 coordinate",
    completeSources.has(path.resolve(project, "src/a.ts")) &&
      completeSources.has(path.resolve(project, crossRootFile)) &&
      completeSources.has(bundledFile),
  );
  TestValidator.equals(
    "a virtual bundled source keeps its checker digest",
    completeSources.get(bundledFile),
    {
      checkerDigest: sha(`${bundledFile}:checker`),
      diskDigest: "",
    },
  );

  const ordinalManifest = good();
  ordinalManifest.provenance = provenance([
    "src/\u00e4.ts",
    "src/z.ts",
    "src/a\u0308.ts",
    "src/a.ts",
  ]);
  TestValidator.equals(
    "strict manifest serialization uses canonical ordinal source order",
    [...adaptTtscGraphDump(ordinalManifest, project).sources.keys()].map(
      (file) => path.basename(file),
    ),
    ["a.ts", "a\u0308.ts", "z.ts", "\u00e4.ts", "tsconfig.json"],
  );

  const globalDiagnostic = good();
  globalDiagnostic.diagnostics.push({
    file: "",
    line: 0,
    column: 0,
    code: 18003,
    category: "error",
    message: "No inputs were found in config file",
  });
  TestValidator.equals(
    "a canonical fileless compiler diagnostic is retained",
    adaptTtscGraphDump(globalDiagnostic, project).diagnostics,
    [
      {
        file: "",
        line: 0,
        column: 0,
        code: 18003,
        message: "No inputs were found in config file",
        severity: "error",
      },
    ],
  );
  const configDiagnostic = good();
  configDiagnostic.diagnostics.push({
    file: "tsconfig.json",
    line: 1,
    column: 1,
    code: 5023,
    category: "error",
    message: "Unknown compiler option",
  });
  const adaptedConfigDiagnostic = adaptTtscGraphDump(
    configDiagnostic,
    project,
  );
  TestValidator.equals(
    "a config diagnostic is bound to its build-universe digest",
    adaptedConfigDiagnostic.sources.get(
      path.resolve(project, "tsconfig.json"),
    ),
    {
      checkerDigest: sha("tsconfig.json"),
      diskDigest: sha("tsconfig.json"),
    },
  );
  TestValidator.equals(
    "a config diagnostic from the same generation is retained",
    adaptedConfigDiagnostic.diagnostics[0]?.file,
    "tsconfig.json",
  );
  const checkerOnlyConfig = good();
  checkerOnlyConfig.provenance.capabilities =
    checkerOnlyConfig.provenance.capabilities.filter(
      (capability) => capability !== "diskDigests",
    );
  for (const source of checkerOnlyConfig.provenance.sources) {
    source.diskDigest = "";
  }
  TestValidator.equals(
    "a config remains checker-bound when the producer claims no disk digest",
    adaptTtscGraphDump(checkerOnlyConfig, project).sources.get(
      path.resolve(project, "tsconfig.json"),
    ),
    {
      checkerDigest: sha("tsconfig.json"),
      diskDigest: "",
    },
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) =>
          d.provenance.sources.push({
            file: "tsconfig.json",
            checkerDigest: sha("different config"),
            diskDigest: sha("different config"),
          }),
        ),
        project,
      ),
    "a config digest that conflicts with the source manifest",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) =>
          d.diagnostics.push({
            file: "",
            line: 1,
            column: 0,
            code: 18003,
            category: "error",
            message: "malformed global diagnostic",
          }),
        ),
        project,
      ),
    "a fileless diagnostic with a nonzero line",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) =>
          d.diagnostics.push({
            file: "",
            line: 0,
            column: 1,
            code: 18003,
            category: "error",
            message: "malformed global diagnostic",
          }),
        ),
        project,
      ),
    "a fileless diagnostic with a nonzero column",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) =>
          d.diagnostics.push({
            file: "src/a.ts",
            line: 0,
            column: 1,
            code: 2322,
            category: "error",
            message: "malformed file diagnostic",
          }),
        ),
        project,
      ),
    "a file-backed diagnostic with a zero line",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) =>
          d.diagnostics.push({
            file: "src/a.ts",
            line: 1,
            column: 0,
            code: 2322,
            category: "error",
            message: "malformed file diagnostic",
          }),
        ),
        project,
      ),
    "a file-backed diagnostic with a zero column",
  );

  const referencedProject = good();
  referencedProject.provenance.universe.configs.push({
    file: "tsconfig.reference.json",
    digest: sha("tsconfig.reference.json"),
  });
  referencedProject.provenance.universe.roots.push({
    config: "tsconfig.reference.json",
    file: "src/a.ts",
  });
  TestValidator.predicate(
    "two configs may canonically name the same root file",
    adaptTtscGraphDump(referencedProject, project).provenance.universe !== "",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) =>
          d.provenance.universe.configs.push({
            ...d.provenance.universe.configs[0]!,
          }),
        ),
        project,
      ),
    "a duplicate config identity in the build universe",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => {
          d.provenance.universe.roots[0]!.config = "tsconfig.missing.json";
        }),
        project,
      ),
    "a root attributed to an unknown config",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) =>
          d.provenance.universe.roots.push({
            ...d.provenance.universe.roots[0]!,
          }),
        ),
        project,
      ),
    "a duplicate config and root-file pair",
  );

  // Identity and project scope.
  rejects(() => adaptTtscGraphDump("not-an-object", project), "a non-object dump");
  rejects(
    () => adaptTtscGraphDump(mutate((d) => (d.project = `${project}-other`)), project),
    "a dump whose project does not match the requested root",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => {
          d.provenance.sources[0]!.file = "C:\\workspace\\src\\a.ts";
        }),
        project,
      ),
    "a source identity with non-canonical backslashes",
  );
  for (const absoluteFile of [
    "//server/share/types/external.d.ts",
    "/opt/types/external.d.ts",
    "C:/workspace/types/external.d.ts",
  ]) {
    rejects(
      () =>
        adaptTtscGraphDump(
          mutate((d) => {
            d.provenance.sources[0]!.file = absoluteFile;
          }),
          project,
        ),
      `a schema-v6 source identity with an absolute path (${absoluteFile})`,
    );
  }

  // Structural types.
  rejects(() => adaptTtscGraphDump(mutate((d) => ((d as { nodes: unknown }).nodes = "x")), project), "a non-array nodes field");
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => (d.provenance.schemaVersion = 7)),
        project,
      ),
    "a dump above the pinned schema",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => (d.provenance.schemaVersion = 1)),
        project,
      ),
    "a legacy dump below the one-Program provenance schema",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate(
          (d) =>
            ((d.provenance as { schemaVersion?: number }).schemaVersion =
              undefined),
        ),
        project,
      ),
    "a dump that omitted its schema",
  );
  rejects(() => adaptTtscGraphDump(mutate((d) => ((d.nodes[1] as { id: unknown }).id = 123)), project), "a non-string node id");
  rejects(() => adaptTtscGraphDump(mutate((d) => ((d.nodes[1] as { external: unknown }).external = "no")), project), "a non-boolean external flag");
  rejects(() => adaptTtscGraphDump(mutate((d) => ((d.nodes[1] as { kind: unknown }).kind = "banana")), project), "an unsupported node kind");
  rejects(() => adaptTtscGraphDump(mutate((d) => ((d.nodes[1] as { modifiers: unknown }).modifiers = ["banana"])), project), "an unsupported modifier");
  rejects(() => adaptTtscGraphDump(mutate((d) => ((d.edges[0] as { kind: unknown }).kind = "banana")), project), "an unsupported edge kind");

  // Capability claims and the payload they authorize must agree. A digest or
  // diagnostic without its corresponding claim is unproven data, not a
  // degraded snapshot the adapter may silently accept.
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => {
          d.provenance.capabilities = d.provenance.capabilities.filter(
            (capability) => capability !== "diskDigests",
          );
        }),
        project,
      ),
    "a disk digest without the diskDigests capability",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => {
          d.provenance.capabilities = d.provenance.capabilities.filter(
            (capability) => capability !== "diagnostics",
          );
          d.diagnostics.push({
            file: "src/a.ts",
            line: 1,
            column: 1,
            code: 2322,
            category: "error",
            message: "unclaimed diagnostic",
          });
        }),
        project,
      ),
    "a diagnostic without the diagnostics capability",
  );

  // Identity format and uniqueness.
  rejects(() => adaptTtscGraphDump(mutate((d) => ((d.nodes[1] as { id: string }).id = "no-hash-here")), project), "a node id that does not encode its file and kind");
  rejects(() => adaptTtscGraphDump(mutate((d) => d.nodes.push({ ...(d.nodes[1] as object) })), project), "a duplicate node id");
  const escapedIdentity = good();
  const escapedFile = "src/hash#folder/a.ts";
  escapedIdentity.provenance.sources.push({
    file: escapedFile,
    checkerDigest: sha(`${escapedFile}:checker`),
    diskDigest: sha(`${escapedFile}:disk`),
  });
  escapedIdentity.nodes.push({
    id: "src/hash\\#folder/a.ts#Hash\\#mark:function",
    kind: "function",
    name: "Hash#mark",
    file: escapedFile,
    external: false,
  });
  TestValidator.predicate(
    "escaped legacy-id components preserve literal hash characters",
    adaptTtscGraphDump(escapedIdentity, project).nodes.some(
      (node) =>
        node.file === escapedFile &&
        node.id === "src/hash\\#folder/a.ts#Hash\\#mark:function",
    ),
  );

  // Edge endpoints and uniqueness.
  rejects(() => adaptTtscGraphDump(mutate((d) => ((d.edges[0] as { from: string }).from = "src/a.ts#ghost:function")), project), "an edge from an unknown endpoint");
  rejects(() => adaptTtscGraphDump(mutate((d) => d.edges.push({ ...(d.edges[0] as object) })), project), "a duplicate edge after module folding");

  // Evidence spans and decorator literals.
  rejects(() => adaptTtscGraphDump(mutate((d) => ((d.nodes[1] as { evidence: unknown }).evidence = { startLine: 0 })), project), "a non-positive evidence line");
  rejects(() => adaptTtscGraphDump(mutate((d) => ((d.nodes[1] as { evidence: unknown }).evidence = { startLine: 1, endCol: 5 })), project), "an evidence endCol without an endLine");
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate(
          (d) =>
            ((d.nodes[1] as { implementation: unknown }).implementation = {
              file: "src/unloaded.ts",
              startLine: 1,
            }),
        ),
        project,
      ),
    "an implementation span whose file is absent from the manifest",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) =>
          d.nodes.push({
            id: "vendor/ghost.d.ts#Ghost:interface",
            kind: "interface",
            name: "Ghost",
            file: "vendor/ghost.d.ts",
            external: true,
          }),
        ),
        project,
      ),
    "an external fact whose file is absent from the manifest",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => ((d.nodes[1] as { decorators: unknown }).decorators = [{ name: "X", arguments: [{ literal: {} }] }])),
        project,
      ),
    "a non-scalar decorator literal",
  );

  // A rich but valid dump preserves optional facts, folds only module endpoints,
  // and admits an external non-bundled dependency.
  const rich = adaptTtscGraphDump(
    {
      project,
      tsconfig: "tsconfig.json",
      provenance: provenance(["src/a.ts", "vendor/dep.ts"]),
      diagnostics: [],
      nodes: [
        { id: "src/a.ts#src/a.ts:module", kind: "module", name: "src/a.ts", file: "src/a.ts", external: false },
        {
          id: "src/a.ts#foo:function",
          kind: "function",
          name: "foo",
          file: "src/a.ts",
          external: false,
          qualifiedName: "pkg.foo",
          signature: "async function foo(): Promise<void>",
          modifiers: ["export", "async"],
          decorators: [{ name: "Route", arguments: [{ literal: "path" }, {}] }],
          evidence: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 },
          implementation: { startLine: 2 },
        },
        {
          id: "src/a.ts#Status:type",
          kind: "type",
          name: "Status",
          file: "src/a.ts",
          external: false,
          literals: ['"ready"', '"done"'],
        },
        {
          id: "src/a.ts#Phase:enum",
          kind: "enum",
          name: "Phase",
          file: "src/a.ts",
          external: false,
          literals: ['"ready"'],
          enumMembers: [
            { name: "Ready", value: '"ready"' },
            { name: "Computed" },
          ],
        },
        {
          id: "src/a.ts#options:variable",
          kind: "variable",
          name: "options",
          file: "src/a.ts",
          external: false,
          objectMembers: [
            {
              name: "execute",
              kind: "method",
              line: 3,
              signature: "execute(): void",
            },
          ],
        },
        { id: "src/a.ts#bar:function", kind: "function", name: "bar", file: "src/a.ts", external: false },
        { id: "vendor/dep.ts#Dep:interface", kind: "interface", name: "Dep", file: "vendor/dep.ts", external: true },
      ],
      edges: [
        { from: "src/a.ts#src/a.ts:module", to: "src/a.ts#foo:function", kind: "exports" },
        { from: "src/a.ts#foo:function", to: "src/a.ts#bar:function", kind: "calls" },
      ],
    },
    project,
  );
  const foo = rich.nodes.find((node) => node.id === "src/a.ts#foo:function");
  const status = rich.nodes.find((node) => node.id === "src/a.ts#Status:type");
  const phase = rich.nodes.find((node) => node.id === "src/a.ts#Phase:enum");
  const options = rich.nodes.find((node) => node.id === "src/a.ts#options:variable");
  TestValidator.equals("a qualified name is preserved", foo?.qualifiedName, "pkg.foo");
  TestValidator.equals(
    "a producer-bounded declaration signature is preserved",
    foo?.signature,
    "async function foo(): Promise<void>",
  );
  TestValidator.equals("an implementation span is preserved", foo?.implementation?.startLine, 2);
  TestValidator.equals(
    "compiler-resolved literal values are preserved",
    status?.literals,
    ['"ready"', '"done"'],
  );
  TestValidator.equals(
    "compiler-owned enum members are preserved",
    phase?.enumMembers,
    [
      { name: "Ready", value: '"ready"' },
      { name: "Computed" },
    ],
  );
  TestValidator.equals(
    "compiler-owned object members are preserved",
    options?.objectMembers,
    [
      {
        name: "execute",
        kind: "method",
        line: 3,
        signature: "execute(): void",
      },
    ],
  );
  TestValidator.equals(
    "a decorator keeps its scalar and its empty argument",
    foo?.decorators?.[0]?.arguments,
    [{ literal: "path" }, {}],
  );
  TestValidator.predicate(
    "a module export edge folds onto its file while a non-module call keeps its endpoint",
    rich.edges.some((edge) => edge.kind === "exports" && edge.from === "src/a.ts") &&
      rich.edges.some((edge) => edge.kind === "calls" && edge.from === "src/a.ts#foo:function"),
  );
  TestValidator.predicate(
    "an external non-bundled dependency remains an external fact",
    rich.nodes.some((node) => node.id === "vendor/dep.ts#Dep:interface" && node.external),
  );

  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => {
          const node = d.nodes[1] as { id: string; kind: string; literals?: unknown };
          node.id = "src/a.ts#foo:type";
          node.kind = "type";
          node.literals = ["ok", 1];
          (d.edges[0] as { to: string }).to = node.id;
        }),
        project,
      ),
    "a non-string literal value",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => {
          const node = d.nodes[1] as { id: string; kind: string; enumMembers?: unknown };
          node.id = "src/a.ts#foo:enum";
          node.kind = "enum";
          node.enumMembers = [{ name: "Ready", value: false }];
          (d.edges[0] as { to: string }).to = node.id;
        }),
        project,
      ),
    "a non-string enum member value",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => {
          const node = d.nodes[1] as { id: string; kind: string; objectMembers?: unknown };
          node.id = "src/a.ts#foo:variable";
          node.kind = "variable";
          node.objectMembers = [{ name: "dynamic", kind: "computed" }];
          (d.edges[0] as { to: string }).to = node.id;
        }),
        project,
      ),
    "an unsupported object member kind",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate((d) => ((d.nodes[1] as { literals?: unknown }).literals = [])),
        project,
      ),
    "literal facts on a non-type node",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate(
          (d) => ((d.nodes[1] as { enumMembers?: unknown }).enumMembers = []),
        ),
        project,
      ),
    "enum-member facts on a non-enum node",
  );
  rejects(
    () =>
      adaptTtscGraphDump(
        mutate(
          (d) => ((d.nodes[1] as { objectMembers?: unknown }).objectMembers = []),
        ),
        project,
      ),
    "object-member facts on a non-variable node",
  );
};

function rejects(task: () => unknown, label: string): void {
  let error: unknown;
  try {
    task();
  } catch (caught) {
    error = caught;
  }
  TestValidator.predicate(`${label} is rejected`, error instanceof Error);
}

function rejectsWithMessage(
  task: () => unknown,
  label: string,
  message: string,
): void {
  let error: unknown;
  try {
    task();
  } catch (caught) {
    error = caught;
  }
  TestValidator.predicate(
    `${label} is rejected at its schema boundary`,
    error instanceof Error && error.message.includes(message),
  );
}
