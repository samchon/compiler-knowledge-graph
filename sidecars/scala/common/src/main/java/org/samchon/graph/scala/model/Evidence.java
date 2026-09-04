package org.samchon.graph.scala.model;

public record Evidence(
    String file,
    int startLine,
    int startColumn,
    int endLine,
    int endColumn) {}
