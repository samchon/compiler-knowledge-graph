import {
  ISamchonGraphEdge,
  ISamchonGraphNode,
} from "../../structures";
import { GraphEdgeKind, GraphLanguage } from "../../typings";
import { freezeDeep } from "../../utils/freezeDeep";
import { IScipIndex } from "./IScipIndex";
import { adaptScipIndex } from "./adaptScipIndex";

/**
 * A language-owned fact family that a bare SCIP artifact cannot prove.
 *
 * The common adapter publishes only facts whose meaning SCIP standardizes.
 * An indexer that can prove a stronger language fact supplies one versioned
 * enrichment instead of teaching the common lane language syntax. Enrichment
 * is additive: it receives an immutable view of common facts and can publish
 * only declared, non-common edge families between nodes the common adapter
 * already accepted. It therefore cannot replace a common fact with a stronger
 * interpretation or manufacture an unowned endpoint.
 */
export namespace ScipEnrichment {
  export interface IContract {
    /** Stable, provider-visible identity for this language contract. */
    readonly name: string;

    /** Monotonic contract revision; changing semantics requires a new version. */
    readonly version: number;

    /** Exactly the language slice this enrichment is allowed to serve. */
    readonly languages: readonly GraphLanguage[];

    /** Strict fact families this enrichment, and no bare SCIP artifact, proves. */
    readonly facts: readonly GraphEdgeKind[];

    enrich(input: IProps): IResult;
  }

  export interface IProps {
    readonly index: Readonly<IScipIndex>;
    readonly root: string;
    readonly provider: string;
    readonly languages: readonly GraphLanguage[];

    /** Immutable, already-validated facts from the common SCIP adapter. */
    readonly common: {
      readonly nodes: readonly Readonly<ISamchonGraphNode>[];
      readonly edges: readonly Readonly<ISamchonGraphEdge>[];
      readonly files: readonly string[];
    };
  }

  export interface IResult {
    /** Additional, declared language facts only. */
    readonly edges: readonly ISamchonGraphEdge[];

    /** Capability limits or producer-specific omissions worth publishing. */
    readonly warnings?: readonly string[];
  }

  /**
   * Validate one provider's declared language enrichment at registration.
   *
   * The declared slice must be exactly the provider's, not merely compatible
   * with it. A contract that named fewer languages than its provider owns would
   * leave the remainder silently unenriched, which looks identical to a
   * language whose facts genuinely do not exist.
   */
  export function assert(
    enrichment: IContract,
    languages: readonly GraphLanguage[],
  ): void {
    assertExact(read(enrichment), languages);
  }

  /**
   * Capture one contract's declaration and hold every later run to it.
   *
   * The frozen copy is only half of this. The implementation keeps the original
   * object as its receiver — see {@link fence} — so the original is re-proved
   * against this copy on every run, and a contract that changed after
   * registration rejects the candidate instead of running under a declaration
   * that no longer describes it.
   */
  export function normalize(
    enrichment: IContract,
    languages: readonly GraphLanguage[],
  ): IContract {
    const declaration = read(enrichment);
    assertExact(declaration, languages);
    return fence(enrichment, declaration);
  }

  /**
   * Capture one registered contract for a session over part of its slice.
   *
   * A registry entry owns every language its indexer can serve, but one build
   * selects only the languages that build actually requested: a C/C++ provider
   * opened for a C-only project publishes one language of the two it declared.
   * The session therefore checks containment where registration checks
   * equality — demanding equality here would reject exactly the provider whose
   * enrichment correctly covers its whole registry entry.
   */
  export function slice(
    enrichment: IContract,
    languages: readonly GraphLanguage[],
  ): IContract {
    const declaration = read(enrichment);
    assertServes(declaration, languages);
    return fence(enrichment, declaration);
  }

  /** One provenance capability that names the enrichment contract exactly. */
  export function capability(
    enrichment: IContract,
  ): string {
    const declaration = read(enrichment);
    assertDeclaration(declaration);
    return `scip-enrichment:${declaration.name}@${String(declaration.version)}`;
  }

  /**
   * Run and fence one language enrichment around an already-adapted SCIP slice.
   *
   * A bad enrichment rejects the candidate before BatchGraphSession can replace
   * its previous generation. Returning only additional edges makes a common fact
   * immutable by construction; duplicate or conflicting observations fail rather
   * than silently choosing which producer statement should win.
   *
   * The contract must serve every language this slice publishes; it may declare
   * more, because a registry entry that owns several languages runs the same
   * contract for a build that selected only some of them.
   */
  export function apply(props: IApplyProps): IApplyResult {
    const enrichment = props.enrichment;
    if (enrichment === undefined) {
      return { edges: props.common.edges, warnings: [] };
    }
    const slice = {
      nodes: props.common.nodes,
      edges: props.common.edges,
      files: props.common.files,
    };
    const nodes = new Set<string>();
    for (const node of slice.nodes) {
      if (nodes.has(node.id)) {
        throw new Error(
          `@samchon/graph: the common SCIP slice duplicated node ${node.id}`,
        );
      }
      nodes.add(node.id);
    }
    const files = new Set<string>();
    for (const file of slice.files) {
      if (files.has(file)) {
        throw new Error(
          `@samchon/graph: the common SCIP slice duplicated file ${file}`,
        );
      }
      files.add(file);
    }
    const commonEdges = new Set<string>();
    for (const edge of slice.edges) {
      if (!adaptScipIndex.EDGE_KINDS.includes(edge.kind)) {
        throw new Error(
          `@samchon/graph: the common SCIP slice published non-common ${edge.kind} facts`,
        );
      }
      if (
        (!nodes.has(edge.from) && !files.has(edge.from)) ||
        (!nodes.has(edge.to) && !files.has(edge.to))
      ) {
        throw new Error(
          `@samchon/graph: the common SCIP slice published an absent endpoint: ${edge.from} -> ${edge.to}`,
        );
      }
      const key = edgeKey(edge);
      if (commonEdges.has(key)) {
        throw new Error(
          `@samchon/graph: the common SCIP slice duplicated an edge: ${edge.from} -> ${edge.to} (${edge.kind})`,
        );
      }
      commonEdges.add(key);
    }
    const declaration = read(enrichment);
    assertServes(declaration, props.languages);
    // These are session-owned, already-validated trees. Sealing them in place
    // gives the language contract a genuinely immutable view without retaining
    // one Proxy (and one cache entry) for every object it reads from a large
    // index.
    const subject = "a SCIP enrichment input";
    const index = freezeDeep(props.index, subject);
    const languages = freezeDeep([...props.languages], subject);
    const common = freezeDeep(slice, subject);
    // `declaration.enrich`, not `enrichment.enrich`: the second read is the one
    // an accessor-backed contract could answer differently, and the receiver
    // stays the original so a method implementation keeps its own state.
    const result = declaration.enrich.call(enrichment, {
      index,
      root: props.root,
      provider: props.provider,
      languages,
      common,
    });
    if (
      result === null ||
      typeof result !== "object" ||
      !Array.isArray(result.edges)
    ) {
      throw new TypeError(
        `@samchon/graph: SCIP enrichment ${declaration.name} returned no edge array`,
      );
    }
    if (result.warnings !== undefined && !Array.isArray(result.warnings)) {
      throw new TypeError(
        `@samchon/graph: SCIP enrichment ${declaration.name} returned non-array warnings`,
      );
    }

    const additions = new Map<string, ISamchonGraphEdge>();
    for (const edge of result.edges) {
      if (edge === null || typeof edge !== "object") {
        throw new TypeError(
          `@samchon/graph: SCIP enrichment ${declaration.name} returned a non-object edge`,
        );
      }
      if (!declaration.facts.includes(edge.kind)) {
        throw new Error(
          `@samchon/graph: SCIP enrichment ${declaration.name} published undeclared ${edge.kind} facts`,
        );
      }
      if (
        (!nodes.has(edge.from) && !files.has(edge.from)) ||
        (!nodes.has(edge.to) && !files.has(edge.to))
      ) {
        throw new Error(
          `@samchon/graph: SCIP enrichment ${declaration.name} published an endpoint absent from the common slice: ${edge.from} -> ${edge.to}`,
        );
      }
      const key = edgeKey(edge);
      if (additions.has(key)) {
        throw new Error(
          `@samchon/graph: SCIP enrichment ${declaration.name} duplicated an edge: ${edge.from} -> ${edge.to} (${edge.kind})`,
        );
      }
      additions.set(key, copyEdge(edge));
    }
    const warnings = (result.warnings ?? []).map((warning) => {
      if (typeof warning !== "string" || warning.trim() === "") {
        throw new TypeError(
          `@samchon/graph: SCIP enrichment ${declaration.name} returned an empty or non-string warning`,
        );
      }
      return warning;
    });
    return {
      edges: [
        ...slice.edges,
        ...[...additions.values()].sort((left, right) =>
          compareOrdinal(edgeKey(left), edgeKey(right)),
        ),
      ],
      warnings: [...new Set(warnings)].sort(compareOrdinal),
    };
  }

  export interface IApplyProps {
    readonly enrichment?: IContract;
    readonly index: IScipIndex;
    readonly root: string;
    readonly provider: string;
    readonly languages: readonly GraphLanguage[];
    readonly common: adaptScipIndex.IResult;
  }

  export interface IApplyResult {
    readonly edges: ISamchonGraphEdge[];
    readonly warnings: readonly string[];
  }
}

/**
 * One contract's declaration, read exactly once.
 *
 * Every check and every published value comes from this snapshot rather than
 * from the contract object, because the object is the untrusted party here: an
 * accessor that answered one way for validation and another way for the frozen
 * copy would put a family this module had just rejected into the published
 * declaration, and the run-time drift check would then agree with it forever.
 */
interface IDeclaration {
  readonly name: string;
  readonly version: number;
  readonly languages: readonly GraphLanguage[];
  readonly facts: readonly GraphEdgeKind[];
  readonly enrich: ScipEnrichment.IContract["enrich"];
}

function read(enrichment: ScipEnrichment.IContract): IDeclaration {
  const languages = enrichment.languages;
  const facts = enrichment.facts;
  return {
    name: enrichment.name,
    version: enrichment.version,
    languages: Array.isArray(languages)
      ? Object.freeze([...languages])
      : languages,
    facts: Array.isArray(facts) ? Object.freeze([...facts]) : facts,
    enrich: enrichment.enrich,
  };
}

/** Everything one contract must satisfy before any caller may run it. */
function assertDeclaration(declaration: IDeclaration): void {
  if (
    typeof declaration.name !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(declaration.name)
  ) {
    throw new TypeError(
      "@samchon/graph: a SCIP enrichment name must be lowercase kebab-case",
    );
  }
  if (!Number.isSafeInteger(declaration.version) || declaration.version < 1) {
    throw new TypeError(
      `@samchon/graph: SCIP enrichment ${declaration.name} must have a positive safe-integer version`,
    );
  }
  if (
    !Array.isArray(declaration.languages) ||
    declaration.languages.length === 0 ||
    new Set(declaration.languages).size !== declaration.languages.length
  ) {
    throw new TypeError(
      `@samchon/graph: SCIP enrichment ${declaration.name} must declare each served language exactly once`,
    );
  }
  if (
    typeof declaration.enrich !== "function" ||
    !Array.isArray(declaration.facts) ||
    declaration.facts.length === 0 ||
    new Set(declaration.facts).size !== declaration.facts.length ||
    declaration.facts.some((fact) => !GRAPH_EDGE_KIND_SET.has(fact))
  ) {
    throw new TypeError(
      `@samchon/graph: SCIP enrichment ${declaration.name} must have a callable implementation and declare each valid added fact family exactly once`,
    );
  }
  for (const fact of declaration.facts) {
    if (adaptScipIndex.EDGE_KINDS.includes(fact)) {
      throw new TypeError(
        `@samchon/graph: SCIP enrichment ${declaration.name} cannot overwrite the common ${fact} fact family`,
      );
    }
  }
}

/** The declaration is valid and is exactly the registering provider's slice. */
function assertExact(
  declaration: IDeclaration,
  languages: readonly GraphLanguage[],
): void {
  assertDeclaration(declaration);
  if (
    new Set(languages).size !== languages.length ||
    !sameSet(declaration.languages, languages)
  ) {
    throw new TypeError(
      `@samchon/graph: SCIP enrichment ${declaration.name} must declare exactly its provider languages`,
    );
  }
}

/** The declaration is valid and covers every language the caller publishes. */
function assertServes(
  declaration: IDeclaration,
  languages: readonly GraphLanguage[],
): void {
  assertDeclaration(declaration);
  const declared = new Set(declaration.languages);
  if (
    languages.length === 0 ||
    new Set(languages).size !== languages.length ||
    languages.some((language) => !declared.has(language))
  ) {
    throw new TypeError(
      `@samchon/graph: SCIP enrichment ${declaration.name} does not serve every language this session publishes`,
    );
  }
}

/**
 * Publish one validated declaration and hold the original contract to it.
 *
 * Copying the declared fields is not enough on its own. A method implementation
 * receives the original object as its receiver, so a caller that renames the
 * contract after registration leaves a session whose published capability says
 * `go-calls@2` while the code that ran read `drifted` from `this`. Rebinding the
 * receiver to a frozen copy would not fix it either: that severs the private
 * class state a real language contract legitimately keeps, which is why the
 * receiver stays the original object and every run instead re-proves that the
 * original still declares what this session captured.
 *
 * The implementation is compared too, even though the captured function is the
 * one that runs. A caller that installs a different `enrich` believes it changed
 * what the session does; it did not, and silently running the old one is a
 * worse answer than saying so. Contract mutation after registration is never a
 * legitimate operation, so either kind rejects the candidate rather than
 * publishing a generation under a declaration that no longer describes it.
 */
function fence(
  enrichment: ScipEnrichment.IContract,
  declaration: IDeclaration,
): ScipEnrichment.IContract {
  const enrich = declaration.enrich.bind(enrichment);
  return Object.freeze({
    name: declaration.name,
    version: declaration.version,
    languages: declaration.languages,
    facts: declaration.facts,
    enrich: (input: ScipEnrichment.IProps) => {
      const current = read(enrichment);
      if (
        !Object.is(current.name, declaration.name) ||
        !Object.is(current.version, declaration.version) ||
        current.enrich !== declaration.enrich ||
        !sameSet(declaration.languages, current.languages) ||
        !sameSet(declaration.facts, current.facts)
      ) {
        throw new Error(
          `@samchon/graph: SCIP enrichment ${declaration.name} changed its registered contract after a session captured it`,
        );
      }
      return enrich(input);
    },
  });
}

function sameSet<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

function edgeKey(edge: Pick<ISamchonGraphEdge, "kind" | "from" | "to">): string {
  return `${edge.kind}\0${edge.from}\0${edge.to}`;
}

function copyEdge(edge: ISamchonGraphEdge): ISamchonGraphEdge {
  return structuredClone(edge);
}

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- distinct sorted keys cannot compare equal. */
  return left < right ? -1 : left > right ? 1 : 0;
}

const GRAPH_EDGE_KIND_SET = new Set<GraphEdgeKind>([
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
  "renders",
  "tests",
  "references",
]);
