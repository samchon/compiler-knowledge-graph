package org.samchon.graph.scala.server.model;

import java.util.List;
import org.samchon.graph.scala.model.GraphEdge;
import org.samchon.graph.scala.model.GraphNode;
import org.samchon.graph.scala.model.UnresolvedSite;

public record SemanticShard(
    int schemaVersion,
    String language,
    String source,
    String checkerDigest,
    String diskDigest,
    String target,
    String compilerVersion,
    String compilerPlugin,
    String compilerPluginVersion,
    int semanticdbSchema,
    String semanticdbUri,
    String semanticdbMd5,
    String semanticdbBuildTarget,
    List<GraphNode> nodes,
    List<GraphEdge> edges,
    List<UnresolvedSite> unresolved,
    List<DiagnosticFact> diagnostics) {}
