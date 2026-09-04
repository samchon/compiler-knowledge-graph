package org.samchon.graph.scala.model;

import java.util.List;

public record TypedShard(
    int schemaVersion,
    String language,
    String source,
    String checkerDigest,
    String diskDigest,
    String target,
    String compilerVersion,
    String compilerPlugin,
    String compilerPluginVersion,
    List<GraphNode> nodes,
    List<GraphEdge> edges,
    List<UnresolvedSite> unresolved) {}
