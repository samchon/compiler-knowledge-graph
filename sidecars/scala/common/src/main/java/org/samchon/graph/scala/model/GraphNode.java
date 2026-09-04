package org.samchon.graph.scala.model;

import java.util.List;

public record GraphNode(
    String symbol,
    String kind,
    String name,
    String qualifiedName,
    String file,
    boolean exported,
    List<String> modifiers,
    String signature,
    String origin,
    Evidence evidence) {}
