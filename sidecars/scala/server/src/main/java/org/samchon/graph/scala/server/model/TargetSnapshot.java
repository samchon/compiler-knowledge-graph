package org.samchon.graph.scala.server.model;

import java.util.List;
import java.util.Map;

public record TargetSnapshot(
    String name,
    String generation,
    String universe,
    String bspUri,
    String scalaVersion,
    String scalaBinaryVersion,
    String platform,
    String sourceEncoding,
    String scalacOptionsDigest,
    String classpathDigest,
    String sourceRootsDigest,
    String semanticdbOptionsDigest,
    String compilerPluginsDigest,
    String zincAnalysisDigest,
    String generatedSourcesDigest,
    Map<String, String> coverage,
    List<SemanticShard> shards) {}
