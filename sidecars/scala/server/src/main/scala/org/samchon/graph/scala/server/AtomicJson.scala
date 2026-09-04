package org.samchon.graph.scala.server

import com.fasterxml.jackson.databind.{MapperFeature, ObjectMapper, SerializationFeature}
import java.nio.file.{FileSystemException, Files, Path, StandardCopyOption}

private[server] object AtomicJson:
  val mapper: ObjectMapper = new ObjectMapper()
    .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
    .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)

  def write(path: Path, value: AnyRef): Unit =
    val parent = path.toAbsolutePath.normalize.getParent
    Files.createDirectories(parent)
    val temporary = Files.createTempFile(parent, path.getFileName.toString + ".", ".tmp")
    try
      Files.write(temporary, mapper.writeValueAsBytes(value))
      try Files.move(
        temporary,
        path,
        StandardCopyOption.ATOMIC_MOVE,
        StandardCopyOption.REPLACE_EXISTING)
      catch
        case _: FileSystemException =>
          Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING)
    finally Files.deleteIfExists(temporary)
