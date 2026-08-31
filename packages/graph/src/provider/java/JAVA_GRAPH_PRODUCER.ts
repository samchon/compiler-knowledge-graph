/**
 * The name the aggregate artifact identifies its producer by.
 *
 * Not the command. `scip-java` is the launcher; this is the thing inside it
 * that wrote the graph, and the two are separate facts because the same
 * launcher also drives a SCIP index that proves less.
 */
export const JAVA_GRAPH_PRODUCER = "scip-java-javac-graph";
