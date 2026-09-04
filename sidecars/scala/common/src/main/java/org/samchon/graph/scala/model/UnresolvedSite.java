package org.samchon.graph.scala.model;

import java.util.List;

public record UnresolvedSite(
    String family,
    String reason,
    Evidence evidence,
    List<String> candidates) {}
