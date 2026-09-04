package org.samchon.graph.scala.server.model;

import org.samchon.graph.scala.model.Evidence;

public record DiagnosticFact(String severity, String message, Evidence evidence) {}
