package org.samchon.graph.scala.plugin;

import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.FileSystemException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import org.samchon.graph.scala.model.GraphEdge;
import org.samchon.graph.scala.model.GraphNode;
import org.samchon.graph.scala.model.TypedShard;
import org.samchon.graph.scala.model.UnresolvedSite;

/** Content-addressed, atomic per-source output shared by both typed plugins. */
public final class GraphShardWriter {
  private static final ObjectMapper JSON = new ObjectMapper()
      .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
      .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

  private GraphShardWriter() {}

  public static void write(
      PluginOptions options,
      Path source,
      String compilerText,
      String compilerVersion,
      String compilerPlugin,
      List<GraphNode> nodes,
      List<GraphEdge> edges,
      List<UnresolvedSite> unresolved) throws IOException {
    Path absolute = source.toAbsolutePath().normalize();
    if (!absolute.startsWith(options.projectRoot())) {
      throw new IOException("samchon-graph: source escapes project root: " + absolute);
    }
    String relative = options.projectRoot().relativize(absolute).toString().replace('\\', '/');
    byte[] disk = Files.readAllBytes(absolute);
    TypedShard shard = new TypedShard(
        1,
        "scala",
        relative,
        digest(compilerText.getBytes(StandardCharsets.UTF_8)),
        digest(disk),
        options.target(),
        compilerVersion,
        compilerPlugin,
        options.pluginVersion(),
        List.copyOf(nodes),
        List.copyOf(edges),
        List.copyOf(unresolved));
    byte[] body = JSON.writeValueAsBytes(shard);
    String targetKey = digest(options.target().getBytes(StandardCharsets.UTF_8));
    String sourceKey = digest(relative.getBytes(StandardCharsets.UTF_8));
    Path directory = options.output().resolve("typed").resolve(targetKey);
    Files.createDirectories(directory);
    Path destination = directory.resolve(sourceKey + ".json");
    Path temporary = Files.createTempFile(directory, sourceKey + ".", ".tmp");
    try {
      Files.write(temporary, body);
      try {
        Files.move(
            temporary,
            destination,
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING);
      } catch (FileSystemException ignored) {
        Files.move(temporary, destination, StandardCopyOption.REPLACE_EXISTING);
      }
    } finally {
      Files.deleteIfExists(temporary);
    }
  }

  public static String digest(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 is unavailable", impossible);
    }
  }
}
