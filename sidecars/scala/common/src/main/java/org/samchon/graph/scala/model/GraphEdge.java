package org.samchon.graph.scala.model;

public record GraphEdge(
    String from,
    String to,
    String kind,
    String access,
    String provenance,
    String targetKind,
    String targetName,
    String targetQualifiedName,
    Evidence evidence) {}
