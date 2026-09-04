package org.samchon.graph.scala.plugin;

import java.nio.file.Path;
import java.util.List;

/** Strict, shared option parsing for both compiler-plugin generations. */
public record PluginOptions(
    Path projectRoot,
    Path output,
    String target,
    String pluginVersion) {
  public static PluginOptions parse(List<String> values) {
    String root = null;
    String output = null;
    String target = null;
    String version = null;
    for (String value : values) {
      int split = value.indexOf('=');
      if (split <= 0 || split == value.length() - 1) {
        throw new IllegalArgumentException("samchon-graph: malformed option " + value);
      }
      String key = value.substring(0, split);
      String body = value.substring(split + 1);
      switch (key) {
        case "root" -> root = unique(key, root, body);
        case "output" -> output = unique(key, output, body);
        case "target" -> target = unique(key, target, body);
        case "version" -> version = unique(key, version, body);
        default -> throw new IllegalArgumentException("samchon-graph: unknown option " + key);
      }
    }
    if (root == null || output == null || target == null || version == null) {
      throw new IllegalArgumentException(
          "samchon-graph: root, output, target and version are required");
    }
    Path projectRoot = Path.of(root).toAbsolutePath().normalize();
    Path targetOutput = Path.of(output).toAbsolutePath().normalize();
    if (!targetOutput.startsWith(projectRoot)) {
      throw new IllegalArgumentException("samchon-graph: output must stay inside project root");
    }
    if (!target.contains(":")) {
      throw new IllegalArgumentException("samchon-graph: target must be a BSP URI");
    }
    return new PluginOptions(projectRoot, targetOutput, target, version);
  }

  private static String unique(String key, String current, String next) {
    if (current != null) {
      throw new IllegalArgumentException("samchon-graph: duplicate option " + key);
    }
    return next;
  }
}
