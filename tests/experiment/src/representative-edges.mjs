/** Require one exact qualified/name endpoint pair from a real graph. */
export function hasRepresentativeEdge(dump, claim) {
  const nodes = new Map(dump.nodes.map((node) => [node.id, node]));
  const nameOf = (id) => {
    const node = nodes.get(id);
    return node?.qualifiedName ?? node?.name;
  };
  return dump.edges.some(
    (edge) =>
      edge.kind === claim.kind &&
      nameOf(edge.from) === claim.from &&
      nameOf(edge.to) === claim.to,
  );
}
