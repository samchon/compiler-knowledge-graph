import { TestValidator } from "@nestia/e2e";
import type {
  GraphEdgeKind,
  IBulkGraphSession,
  ISamchonGraphEdge,
  ISamchonGraphNode,
} from "@samchon/graph";
import path from "node:path";

import { Conformance } from "../internal/Conformance";
import { ProviderFixtures } from "../internal/ProviderFixtures";

/**
 * The conformance kit passes a provider that resolves and fails one that
 * guesses.
 *
 * This is the assertion the old experiment catalog could not make. Its gates
 * were node and edge counts, and eight languages were allowed zero edges — so
 * a provider that emitted an edge between every pair of names it saw scored
 * better than one that resolved carefully and found few. The heuristic
 * provider below is exactly that: it links every identifier to every other
 * identifier in the same file, including one that appears only inside a
 * comment and one that only shares a spelling. A count gate cannot tell it
 * apart from the real thing. The negative twins can.
 */
export const test_conformance_harness_rejects_a_text_heuristic_provider =
  async () => {
    const provider = ProviderFixtures.provider({
      name: "conformance",
      facts: ["calls", "references", "exports"],
    });

    const resolved = Conformance.check(semanticSnapshot(), EXPECTATIONS);
    TestValidator.equals(
      "a provider that resolves its facts conforms",
      resolved.failures,
      [],
    );
    TestValidator.predicate(
      "an off-by-one declaration span fails the source oracle",
      Conformance.check(semanticSnapshot(), [
        {
          reason: "the exact caller declaration span",
          node: {
            name: "caller",
            kind: "function",
            language: "typescript",
            file: "a.ts",
            evidence: {
              file: "a.ts",
              startLine: 1,
              startCol: 2,
              endLine: 1,
              endCol: 8,
            },
          },
        },
      ]).failures.some((failure) => failure.includes("exact source span")),
    );
    TestValidator.predicate(
      "a declaration attributed to the wrong file fails the source oracle",
      Conformance.check(semanticSnapshot(), [
        {
          reason: "the caller belongs to the checked-in fixture",
          node: {
            name: "caller",
            kind: "function",
            language: "typescript",
            file: "wrong.ts",
          },
        },
      ]).failures.some((failure) => failure.includes("exact source span")),
    );

    const guessed = Conformance.check(heuristicSnapshot(), EXPECTATIONS);
    // Not merely "some failure": the harness must fail on the twins
    // specifically, because failing on the positives too would mean it had
    // simply rejected a different graph rather than caught the guess.
    TestValidator.predicate(
      "a text-heuristic provider fails the comment negative twin",
      guessed.failures.some((failure) => failure.includes("documentedElsewhere")),
    );
    TestValidator.predicate(
      "a text-heuristic provider fails the same-spelling negative twin",
      guessed.failures.some((failure) => failure.includes("unrelatedHelper")),
    );
    TestValidator.predicate(
      "a text-heuristic provider fails the function-value negative twin",
      guessed.failures.some((failure) => failure.includes("callback")),
    );
    TestValidator.predicate(
      "the heuristic provider still satisfies every positive case",
      !guessed.failures.some((failure) => failure.startsWith("missing")),
    );

    // --- structural invariants, which are language-independent -----------
    TestValidator.equals(
      "a well-formed slice satisfies the structural invariants",
      Conformance.structure(semanticSnapshot(), provider, ["typescript"])
        .failures,
      [],
    );
    TestValidator.predicate(
      "a dangling edge endpoint is caught",
      Conformance.structure(
        snapshotOf({
          nodes: [declaration("caller", "function")],
          edges: [
            { kind: "calls", from: id("caller"), to: id("neverDeclared") },
          ],
        }),
        provider,
        ["typescript"],
      ).failures.some((failure) => failure.includes("dangling edge endpoint")),
    );
    TestValidator.predicate(
      "a duplicated node id is caught",
      Conformance.structure(
        snapshotOf({
          nodes: [declaration("caller", "function"), declaration("caller", "function")],
        }),
        provider,
        ["typescript"],
      ).failures.some((failure) => failure.includes("duplicate node id")),
    );
    TestValidator.predicate(
      "a zero-based span is caught",
      Conformance.structure(
        snapshotOf({
          nodes: [
            {
              ...declaration("caller", "function"),
              evidence: { file: "a.ts", startLine: 0, startCol: 0 },
            },
          ],
        }),
        provider,
        ["typescript"],
      ).failures.some((failure) => failure.includes("zero-based span")),
    );
    TestValidator.predicate(
      "a zero-based implementation span is caught",
      Conformance.structure(
        snapshotOf({
          nodes: [
            {
              ...declaration("caller", "function"),
              implementation: { file: "a.ts", startLine: 0, startCol: 0 },
            },
          ],
        }),
        provider,
        ["typescript"],
      ).failures.some((failure) =>
        failure.includes("zero-based implementation span"),
      ),
    );
    // A bare endpoint cannot distinguish same-named declarations. Qualified
    // endpoints in an atomic multi-language corpus can; this legacy fixture is
    // deliberately bare so the ambiguity gate itself remains covered.
    TestValidator.predicate(
      "a golden fixture reusing a display name is caught",
      Conformance.check(
        snapshotOf({
          nodes: [
            declaration("caller", "function"),
            { ...declaration("caller", "method"), id: "a.ts#caller:method" },
          ],
        }),
        [
          {
            reason: "a bare endpoint must identify exactly one declaration",
            edge: {
              kind: "references",
              from: "caller",
              to: "caller",
            },
          },
        ],
      ).failures.some((failure) => failure.includes("reuses the display name")),
    );
    TestValidator.predicate(
      "a manifest entry without a checker digest is caught",
      Conformance.structure(
        snapshotOf({
          sources: new Map([
            [
              path.resolve("a.ts"),
              { checkerDigest: "", diskDigest: "" },
            ],
          ]),
          capabilities: ["sourceDigests"],
        }),
        provider,
        ["typescript"],
      ).failures.some((failure) => failure.includes("without a checker digest")),
    );
    TestValidator.equals(
      "a provider that does not claim source digests may publish its textless manifest",
      Conformance.structure(
        snapshotOf({
          sources: new Map([
            [
              path.resolve("a.ts"),
              { checkerDigest: "", diskDigest: "" },
            ],
          ]),
          capabilities: ["universe"],
        }),
        provider,
        ["typescript"],
      ).failures,
      [],
    );
    TestValidator.predicate(
      "an edge family the provider never claimed is caught",
      Conformance.structure(
        snapshotOf({
          nodes: [declaration("caller", "function"), declaration("callee", "function")],
          edges: [
            { kind: "decorates", from: id("caller"), to: id("callee") },
          ],
        }),
        provider,
        ["typescript"],
      ).failures.some((failure) => failure.includes("decorates")),
    );

    // --- determinism ------------------------------------------------------
    TestValidator.equals(
      "two indexes of unchanged source are byte-identical",
      Conformance.deterministic(semanticSnapshot(), semanticSnapshot()).failures,
      [],
    );
    TestValidator.predicate(
      "a reordered slice is not the same slice",
      Conformance.deterministic(semanticSnapshot(), reorderedSnapshot())
        .failures.length > 0,
    );
    const changedWarning = semanticSnapshot();
    changedWarning.warnings.push("a nondeterministic warning");
    TestValidator.predicate(
      "changed envelope metadata is not byte-identical",
      Conformance.deterministic(semanticSnapshot(), changedWarning).failures
        .length > 0,
    );
  };

/**
 * The golden facts, each with a twin one property away.
 *
 * Every negative case names something a text scan would also find: a symbol
 * mentioned in a comment, a symbol that merely shares a spelling with a
 * member, and a function passed as a value rather than invoked.
 */
const EXPECTATIONS: readonly Conformance.IExpectation[] = [
  {
    reason: "the declaration itself",
    node: { name: "caller", kind: "function", language: "typescript" },
  },
  {
    reason: "a name that appears only inside a comment declares nothing",
    node: {
      name: "documentedElsewhere",
      kind: "function",
      language: "typescript",
      present: false,
    },
  },
  {
    reason: "an invocation the checker resolved",
    edge: { kind: "calls", from: "caller", to: "callee" },
  },
  {
    reason: "a name mentioned in a comment is not called",
    edge: {
      kind: "calls",
      from: "caller",
      to: "documentedElsewhere",
      present: false,
    },
  },
  {
    reason: "a same-spelled symbol in another scope is not the one called",
    edge: {
      kind: "calls",
      from: "caller",
      to: "unrelatedHelper",
      present: false,
    },
  },
  {
    reason: "a function passed as a value is referenced, not called",
    edge: { kind: "references", from: "caller", to: "callback" },
  },
  {
    reason: "…and passing it is not invoking it",
    edge: { kind: "calls", from: "caller", to: "callback", present: false },
  },
];

/** What a provider that resolved the program publishes. */
function semanticSnapshot(): IBulkGraphSession.ISnapshot {
  return snapshotOf({
    nodes: [
      declaration("caller", "function"),
      declaration("callee", "function"),
      declaration("callback", "function"),
      declaration("unrelatedHelper", "method"),
    ],
    edges: [
      { kind: "calls", from: id("caller"), to: id("callee") },
      { kind: "references", from: id("caller"), to: id("callback") },
    ],
  });
}

/**
 * What a provider that scanned text publishes: every name linked to every
 * other, and a `calls` edge wherever a name is followed by a parenthesis.
 */
function heuristicSnapshot(): IBulkGraphSession.ISnapshot {
  const names = ["caller", "callee", "callback", "unrelatedHelper", "documentedElsewhere"];
  const edges: ISamchonGraphEdge[] = [];
  for (const to of names) {
    if (to === "caller") continue;
    edges.push({ kind: "calls", from: id("caller"), to: id(to) });
    edges.push({ kind: "references", from: id("caller"), to: id(to) });
  }
  return snapshotOf({
    nodes: names.map((name) =>
      declaration(name, name === "unrelatedHelper" ? "method" : "function"),
    ),
    edges,
  });
}

/** The same facts, published in a different order. */
function reorderedSnapshot(): IBulkGraphSession.ISnapshot {
  const snapshot = semanticSnapshot();
  return { ...snapshot, nodes: [...snapshot.nodes].reverse() };
}

function snapshotOf(props: {
  nodes?: ISamchonGraphNode[];
  edges?: ISamchonGraphEdge[];
  sources?: Map<string, IBulkGraphSession.ISourceDigest>;
  capabilities?: string[];
}): IBulkGraphSession.ISnapshot {
  return ProviderFixtures.snapshot({
    provider: "conformance",
    facts: ["calls", "references", "exports"] as GraphEdgeKind[],
    nodes: props.nodes ?? [],
    edges: props.edges ?? [],
    ...(props.sources === undefined ? {} : { sources: props.sources }),
    capabilities: props.capabilities,
  });
}

function declaration(
  name: string,
  kind: ISamchonGraphNode["kind"],
): ISamchonGraphNode {
  return {
    id: id(name, kind),
    kind,
    language: "typescript",
    name,
    file: "a.ts",
    external: false,
    evidence: {
      file: "a.ts",
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: name.length + 1,
    },
  };
}

function id(
  name: string,
  kind: ISamchonGraphNode["kind"] = name === "unrelatedHelper"
    ? "method"
    : "function",
): string {
  return `a.ts#${name}:${kind}`;
}
