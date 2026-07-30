import { TestValidator } from "@nestia/e2e";
import {
  GRAPH_EDGE_KINDS,
  ISamchonGraphDump,
  parseGraphDump,
  semanticGraphNodeId,
} from "@samchon/graph";
import path from "node:path";

const valid = () => ({
  project: path.resolve("fixture"),
  languages: ["go"] as const,
  indexer: "lsp" as const,
  nodes: [
    {
      id: semanticGraphNodeId(
        {
          version: 2,
          language: "go",
          symbol: "example.Run",
          role: "function",
          scope: { document: "src/run.go" },
          stability: "persistent",
        },
        "example.Run",
      ),
      kind: "function" as const,
      language: "go" as const,
      name: "Run",
      qualifiedName: "example.Run",
      file: "src/run.go",
      external: false,
      evidence: { startLine: 1, startCol: 1, endLine: 2, endCol: 2 },
    },
    {
      id: "src/other.go#Other:function",
      kind: "function" as const,
      language: "go" as const,
      name: "Other",
      file: "src/other.go",
      external: false,
    },
  ],
  edges: [] as Array<{
    from: string;
    to: string;
    kind: "calls";
  }>,
});

export const test_graph_dump_parser_closes_every_public_trust_boundary =
  async () => {
    const dump = valid();
    dump.edges.push({
      from: dump.nodes[0]!.id,
      to: dump.nodes[1]!.id,
      kind: "calls",
    });
    TestValidator.equals(
      "a structurally and semantically closed dump parses",
      parseGraphDump(dump).nodes.length,
      2,
    );
    const portable = withEdge();
    portable.diagnostics = [
      {
        file: "bundled:///go/builtin",
        line: 1,
        column: 1,
        code: "fixture",
        message: "portable",
      },
    ];
    portable.edges[0]!.to = "../shared/contract.go";
    TestValidator.equals(
      "canonical bundled paths and sibling file endpoints remain portable",
      parseGraphDump(portable).diagnostics?.[0]?.file,
      "bundled:///go/builtin",
    );
    const external = withEdge();
    Object.assign(record(external.nodes[1]!), {
      id: "stdlib.external",
      kind: "external_symbol",
      file: "",
      external: true,
    });
    external.edges[0]!.to = "stdlib.external";
    TestValidator.equals(
      "fileless external symbols are the one empty-file identity",
      parseGraphDump(external).nodes[1]?.file,
      "",
    );
    const provenance = withEdge();
    provenance.provenance = [validProvenance()];
    TestValidator.equals(
      "coherent provider provenance parses",
      parseGraphDump(provenance).provenance?.[0]?.provider,
      "scip-go",
    );
    const trusted = withTrust();
    TestValidator.equals(
      "exhaustive coverage and universe-bound uncertainty parse",
      [
        parseGraphDump(trusted).coverage?.length,
        parseGraphDump(trusted).unresolved?.[0]?.reason,
      ],
      [GRAPH_EDGE_KINDS.length, "dynamic"],
    );

    await rejected("duplicate node identities", (candidate) => {
      candidate.nodes.push({ ...candidate.nodes[1]! });
    });
    await rejected("empty node identities", (candidate) => {
      candidate.nodes[1]!.id = "";
    });
    await rejected("NUL-delimited node identities", (candidate) => {
      candidate.nodes[1]!.id = "src/other.go\0#Other:function";
    });
    await rejected("empty node display names", (candidate) => {
      candidate.nodes[1]!.name = "";
    });
    await rejected("NUL-delimited node display names", (candidate) => {
      candidate.nodes[1]!.name = "Other\0Name";
    });
    await rejected("empty qualified names", (candidate) => {
      candidate.nodes[0]!.qualifiedName = "";
    });
    await rejected("NUL-delimited qualified names", (candidate) => {
      candidate.nodes[0]!.qualifiedName = "example\0Run";
    });
    await rejected("relative project roots", (candidate) => {
      candidate.project = "fixture";
    });
    await rejected("duplicate dump languages", (candidate) => {
      record(candidate).languages = ["go", "go"];
    });
    await rejected("fileless ordinary nodes", (candidate) => {
      record(candidate.nodes[1]!).file = "";
    });
    await rejected("node languages absent from the dump", (candidate) => {
      record(candidate.nodes[1]!).language = "rust";
    });
    await rejected("legacy identities whose file moved", (candidate) => {
      record(candidate.nodes[1]!).id = "src/moved.go#Other:function";
    });
    await rejected("dangling edge endpoints", (candidate) => {
      candidate.edges[0]!.to = "src/missing.go#Missing:function";
    });
    await rejected("duplicate edges", (candidate) => {
      candidate.edges.push({ ...candidate.edges[0]! });
    });
    await rejected("raw absolute graph paths", (candidate) => {
      record(candidate.nodes[1]!).file = "C:/machine/other.go";
    });
    await rejected("NUL-delimited graph paths", (candidate) => {
      candidate.nodes[1]!.id = "src/other\0name.go#Other:function";
      candidate.nodes[1]!.file = "src/other\0name.go";
    });
    await rejected("terminal parent graph paths", (candidate) => {
      record(candidate.nodes[1]!).file = "../..";
    });
    await rejected("non-canonical bundled graph paths", (candidate) => {
      record(candidate.nodes[1]!).file = "bundled:///go/../builtin";
    });
    await rejected("backslashed bundled graph paths", (candidate) => {
      record(candidate.nodes[1]!).file = "bundled:///go\\..\\escape";
    });
    await rejected("NUL-delimited bundled graph paths", (candidate) => {
      candidate.nodes[1]!.id = "bundled:///go/\0builtin";
      candidate.nodes[1]!.kind = "file";
      candidate.nodes[1]!.name = "builtin";
      candidate.nodes[1]!.file = "bundled:///go/\0builtin";
      candidate.nodes[1]!.external = true;
    });
    await rejected("invalid source ranges", (candidate) => {
      candidate.nodes[0]!.evidence!.endLine = 0;
    });
    await rejected("fractional source coordinates", (candidate) => {
      candidate.nodes[0]!.evidence!.startLine = 1.5;
    });
    await rejected("reversed same-line source columns", (candidate) => {
      Object.assign(candidate.nodes[0]!.evidence!, {
        startLine: 2,
        startCol: 4,
        endLine: 2,
        endCol: 3,
      });
    });
    await rejected("empty explicit span files", (candidate) => {
      Object.assign(record(candidate.nodes[1]!), {
        id: "stdlib.external",
        kind: "external_symbol",
        file: "",
        external: true,
        evidence: { startLine: 1 },
      });
    });
    await rejected("end columns without end lines", (candidate) => {
      record(candidate.nodes[0]!).implementation = {
        file: "src/run.go",
        startLine: 1,
        endCol: 1,
      };
    });
    await rejected("non-positive diagnostic lines", (candidate) => {
      candidate.diagnostics = [
        {
          file: "src/run.go",
          line: 0,
          code: "fixture",
          message: "invalid",
        },
      ];
    });
    const global = valid();
    global.diagnostics = [
      {
        file: "",
        line: 0,
        column: 0,
        code: "fixture",
        message: "global",
      },
    ];
    TestValidator.equals(
      "a global diagnostic uses the producer's canonical zero coordinates",
      parseGraphDump(global).diagnostics,
      global.diagnostics,
    );
    await rejected("nonzero global diagnostic coordinates", (candidate) => {
      candidate.diagnostics = [
        {
          file: "",
          line: 1,
          column: 0,
          code: "fixture",
          message: "invalid",
        },
      ];
    });
    await rejected("global diagnostics without their zero column", (candidate) => {
      candidate.diagnostics = [
        {
          file: "",
          line: 0,
          code: "fixture",
          message: "invalid",
        },
      ];
    });
    await rejected("non-positive diagnostic columns", (candidate) => {
      candidate.diagnostics = [
        {
          file: "src/run.go",
          line: 1,
          column: 0,
          code: "fixture",
          message: "invalid",
        },
      ];
    });
    await rejected("fractional diagnostic coordinates", (candidate) => {
      candidate.diagnostics = [
        {
          file: "src/run.go",
          line: 1.5,
          column: 1,
          code: "fixture",
          message: "invalid",
        },
      ];
    });
    await rejected("empty provenance provider names", (candidate) => {
      candidate.provenance = [{ ...validProvenance(), provider: "" }];
    });
    await rejected("NUL-delimited provenance provider names", (candidate) => {
      candidate.provenance = [
        { ...validProvenance(), provider: "scip\0go" },
      ];
    });
    await rejected("invalid provenance producer revisions", (candidate) => {
      candidate.provenance = [
        {
          ...validProvenance(),
          producer: {
            ...validProvenance().producer,
            schemaVersion: 1.5,
          },
        },
      ];
    });
    await rejected("duplicate provenance provider names", (candidate) => {
      candidate.provenance = [validProvenance(), validProvenance()];
    });
    await rejected("duplicate provenance languages", (candidate) => {
      candidate.provenance = [
        { ...validProvenance(), languages: ["go", "go"] },
      ];
    });
    await rejected("duplicate provenance facts", (candidate) => {
      candidate.provenance = [
        { ...validProvenance(), facts: ["calls", "calls"] },
      ];
    });
    await rejected("duplicate provenance capabilities", (candidate) => {
      candidate.provenance = [
        {
          ...validProvenance(),
          capabilities: ["universe", "sourceDigests", "sourceDigests"],
        },
      ];
    });
    await rejected("empty provenance language ownership", (candidate) => {
      candidate.provenance = [
        { ...validProvenance(), languages: [] },
      ];
    });
    await rejected("provenance without a universe capability", (candidate) => {
      candidate.provenance = [
        { ...validProvenance(), capabilities: ["sourceDigests"] },
      ];
    });
    await rejected("provenance languages absent from the dump", (candidate) => {
      candidate.provenance = [
        { ...validProvenance(), languages: ["rust"] },
      ];
    });
    for (const label of ["universe", "manifest", "content"] as const) {
      await rejected(`malformed provenance ${label} digests`, (candidate) => {
        candidate.provenance = [{ ...validProvenance(), [label]: "bad" }];
      });
    }
    await rejectedTrust("empty coverage provider identities", (candidate) => {
      candidate.coverage![0]!.provider = "";
    });
    await rejectedTrust(
      "NUL-delimited coverage provider identities",
      (candidate) => {
        candidate.coverage![0]!.provider = "scip\0go";
      },
    );
    await rejectedTrust("empty coverage targets", (candidate) => {
      candidate.coverage![0]!.target = "";
    });
    await rejectedTrust("NUL-delimited coverage targets", (candidate) => {
      candidate.coverage![0]!.target = "fixture\0other";
    });
    await rejectedTrust("coverage languages absent from the dump", (candidate) => {
      record(candidate.coverage![0]!).language = "rust";
    });
    await rejectedTrust("duplicate coverage rows", (candidate) => {
      candidate.coverage!.push({ ...candidate.coverage![0]! });
    });
    await rejectedTrust("missing provider coverage", (candidate) => {
      candidate.coverage = [];
      candidate.unresolved = [];
    });
    await rejectedTrust("non-exhaustive provider coverage", (candidate) => {
      candidate.coverage!.pop();
    });
    await rejected(
      "non-exhaustive fallback-only coverage",
      (candidate) => {
        candidate.coverage = GRAPH_EDGE_KINDS.slice(1).map((family) => ({
          provider: "@samchon/graph-lsp",
          language: "go",
          target: "fallback/default",
          family,
          state: "partial",
        }));
        candidate.unresolved = [];
      },
    );
    await rejectedTrust("invalid unresolved evidence", (candidate) => {
      candidate.unresolved![0]!.evidence.startLine = 0;
    });
    await rejectedTrust("duplicate unresolved candidates", (candidate) => {
      candidate.unresolved![0]!.candidates = ["candidate", "candidate"];
    });
    await rejectedTrust("malformed unresolved universes", (candidate) => {
      candidate.unresolved![0]!.universe = "bad";
    });
    await rejectedTrust("unowned unresolved providers", (candidate) => {
      candidate.unresolved![0]!.provider = "other";
    });
    await rejectedTrust("unresolved sites without provenance", (candidate) => {
      candidate.provenance = undefined;
    });
    await rejectedTrust("mismatched unresolved universes", (candidate) => {
      candidate.unresolved![0]!.universe = "b".repeat(64);
    });
    await rejectedTrust("unresolved sites without partial coverage", (candidate) => {
      candidate.coverage!.find((row) => row.family === "calls")!.state =
        "complete";
    });
    await rejectedTrust("duplicate unresolved sites", (candidate) => {
      candidate.unresolved!.push(
        structuredClone(candidate.unresolved![0]!),
      );
    });
    await rejected("semantic display suffix mismatches", (candidate) => {
      candidate.nodes[0]!.qualifiedName = "example.NotRun";
    });
    await rejected("non-canonical semantic display escapes", (candidate) => {
      candidate.nodes[0]!.id = candidate.nodes[0]!.id.replace(
        "example.Run",
        "example%2eRun",
      );
    });
  };

type Candidate = ReturnType<typeof valid> & {
  diagnostics?: Array<{
    file: string;
    line: number;
    column?: number;
    code: number | string;
    message: string;
  }>;
  provenance?: Array<ReturnType<typeof validProvenance>>;
  coverage?: NonNullable<ISamchonGraphDump["coverage"]>;
  unresolved?: NonNullable<ISamchonGraphDump["unresolved"]>;
};

const rejected = async (
  label: string,
  mutate: (candidate: Candidate) => void,
): Promise<void> => {
  const candidate = withEdge();
  mutate(candidate);
  await TestValidator.error(`${label} fail closed`, () =>
    parseGraphDump(candidate),
  );
};

const rejectedTrust = async (
  label: string,
  mutate: (candidate: Candidate) => void,
): Promise<void> => {
  const candidate = withTrust();
  mutate(candidate);
  await TestValidator.error(`${label} fail closed`, () =>
    parseGraphDump(candidate),
  );
};

function withEdge(): Candidate {
  const candidate = valid();
  candidate.edges.push({
    from: candidate.nodes[0]!.id,
    to: candidate.nodes[1]!.id,
    kind: "calls",
  });
  return candidate as Candidate;
}

function withTrust(): Candidate {
  const candidate = withEdge();
  const provenance = validProvenance();
  candidate.provenance = [provenance];
  candidate.coverage = GRAPH_EDGE_KINDS.map((family) => ({
    provider: provenance.provider,
    language: "go",
    target: "fixture",
    family,
    state: family === "calls" ? "partial" : "unsupported",
  }));
  candidate.unresolved = [
    {
      provider: provenance.provider,
      language: "go",
      target: "fixture",
      universe: provenance.universe,
      family: "calls",
      evidence: { file: "src/run.go", startLine: 1, startCol: 1 },
      reason: "dynamic",
      candidates: ["candidate"],
    },
  ];
  return candidate;
}

function record(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function validProvenance() {
  const digest = "a".repeat(64);
  return {
    provider: "scip-go",
    languages: ["go"] as ("go" | "rust")[],
    authority: "semantic-index" as const,
    facts: ["calls"] as ("calls" | "contains")[],
    capabilities: ["universe", "sourceDigests"],
    producer: {
      tool: "scip-go",
      version: "1.0.0",
      compiler: "go1.26",
      schemaVersion: 1,
      protocolVersion: 1,
    },
    universe: digest,
    manifest: digest,
    content: digest,
  };
}
