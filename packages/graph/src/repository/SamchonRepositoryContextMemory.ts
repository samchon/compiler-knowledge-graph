import {
  ISamchonGraphTopology,
  ISamchonRepositoryContextDump,
} from "../structures";
import { RepositoryContextRelationKind } from "../typings";

/** Indexed in-memory view of one repository-context snapshot. */
export class SamchonRepositoryContextMemory {
  public readonly dump: ISamchonRepositoryContextDump;
  private readonly nodesById: ReadonlyMap<
    string,
    ISamchonRepositoryContextDump.INode
  >;

  public constructor(dump: ISamchonRepositoryContextDump) {
    this.dump = dump;
    this.nodesById = new Map(dump.nodes.map((node) => [node.id, node]));
  }

  public inspect(
    request: ISamchonGraphTopology.IRequest,
    join: ISamchonGraphTopology.IJoin,
    codeFiles: ReadonlySet<string> = new Set(),
  ): ISamchonGraphTopology {
    const limit = Math.max(1, Math.min(request.limit ?? 100, 500));
    const joinLimit = Math.max(
      1,
      Math.min(request.joinLimit ?? 50, 500),
    );
    const families =
      request.relations === undefined || request.relations.length === 0
        ? undefined
        : new Set<RepositoryContextRelationKind>(request.relations);
    const query = request.query?.trim().toLowerCase();
    const availableEdges =
      join.state === "compatible"
        ? withCodeJoins(this.dump.edges, this.dump.nodes, codeFiles)
        : this.dump.edges;
    const seeds =
      query === undefined || query === ""
        ? this.dump.nodes
        : this.dump.nodes.filter(
            (node) =>
              node.id.toLowerCase() === query ||
              node.name.toLowerCase() === query ||
              node.coordinate.toLowerCase() === query,
          );
    const boundedSeeds = seeds.slice(0, limit);
    const selected = new Set(boundedSeeds.map((node) => node.id));
    const matchingEdges = availableEdges.filter(
      (edge) =>
        (families === undefined || families.has(edge.kind)) &&
        (edge.kind !== "joins-file" ||
          (join.state === "compatible" && codeFiles.has(edge.to))) &&
        (selected.has(edge.from) ||
          (edge.kind !== "joins-file" && selected.has(edge.to))),
    );
    const matchingJoins = matchingEdges.filter(
      (edge) => edge.kind === "joins-file",
    );
    const edges = [
      ...matchingEdges.filter((edge) => edge.kind !== "joins-file"),
      ...matchingJoins.slice(0, joinLimit),
    ];
    for (const edge of edges) {
      if (this.nodesById.has(edge.from)) selected.add(edge.from);
      if (this.nodesById.has(edge.to)) selected.add(edge.to);
    }
    const seedIds = new Set(boundedSeeds.map((node) => node.id));
    const nodes = [
      ...boundedSeeds,
      ...this.dump.nodes.filter(
        (node) => selected.has(node.id) && !seedIds.has(node.id),
      ),
    ].slice(0, limit);
    const retained = new Set(nodes.map((node) => node.id));
    const retainedEdges = edges.filter(
      (edge) =>
        retained.has(edge.from) &&
        (edge.kind === "joins-file" || retained.has(edge.to)),
    );
    return {
      type: "topology",
      schemaVersion: 1,
      nodes,
      edges: retainedEdges,
      provenance: this.dump.provenance.map((row) => ({ ...row })),
      coverage: this.dump.coverage
        .filter((row) => families === undefined || families.has(row.family))
        .map((row) => ({ ...row })),
      generation: {
        ...this.dump.generation,
        shards: this.dump.generation.shards.map((row) => ({ ...row })),
      },
      join,
      truncated:
        seeds.length > limit ||
        matchingJoins.length > joinLimit ||
        retainedEdges.length < edges.length,
    };
  }
}

function withCodeJoins(
  declared: readonly ISamchonRepositoryContextDump.IEdge[],
  nodes: readonly ISamchonRepositoryContextDump.INode[],
  codeFiles: ReadonlySet<string>,
): ISamchonRepositoryContextDump.IEdge[] {
  const rows = new Map(
    declared.map(
      (edge) =>
        [`${edge.kind}\0${edge.from}\0${edge.to}`, edge] as const,
    ),
  );
  for (const node of nodes) {
    if (node.file !== undefined && codeFiles.has(node.file)) {
      add(node.id, node.file, node.authority);
    }
    if (node.root !== undefined) {
      const prefix = node.root === "." ? "" : `${node.root.replace(/\/$/, "")}/`;
      for (const file of codeFiles) {
        if (prefix === "" || file.startsWith(prefix)) {
          add(node.id, file, node.authority);
        }
      }
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      compare(left.kind, right.kind) ||
      compare(left.from, right.from) ||
      compare(left.to, right.to),
  );

  function add(
    from: string,
    to: string,
    authority: ISamchonRepositoryContextDump.IEdge["authority"],
  ): void {
    const edge = { authority, kind: "joins-file" as const, from, to };
    rows.set(`${edge.kind}\0${edge.from}\0${edge.to}`, edge);
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
