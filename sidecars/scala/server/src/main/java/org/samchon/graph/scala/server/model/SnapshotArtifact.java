package org.samchon.graph.scala.server.model;

import java.util.List;

public record SnapshotArtifact(
    int schemaVersion,
    String projectRoot,
    Producer producer,
    List<TargetSnapshot> targets) {
  public record Producer(
      String name,
      String version,
      int protocolVersion,
      Capabilities capabilities) {}

  public record Capabilities(
      boolean atomicGenerations,
      boolean incremental,
      boolean diagnostics,
      boolean bsp,
      boolean semanticdb,
      boolean typedPlugins,
      boolean zinc) {}
}
