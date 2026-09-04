package org.samchon.graph.scala.server

import com.fasterxml.jackson.databind.node.ObjectNode
import java.io.{BufferedReader, InputStreamReader}
import java.nio.file.Path

object Main:
  val Version = "0.1.0-SNAPSHOT"
  private val Capability = "Serve BSP-driven Scala compiler graph generations over NDJSON."

  def main(arguments: Array[String]): Unit =
    try run(arguments.toList)
    catch
      case error: Throwable =>
        System.err.println(message(error))
        System.exit(1)

  private def run(arguments: List[String]): Unit = arguments match
    case "--version" :: Nil => println(s"samchon-scala-graph $Version")
    case "graph-server" :: rest if rest.contains("--help") => println(Capability)
    case "supports" :: rest =>
      val producer = new SnapshotProducer(cwd(rest))
      try producer.supports() finally producer.close()
    case "snapshot" :: rest =>
      val producer = new SnapshotProducer(cwd(rest))
      try producer.produce(requiredPath(rest, "--output")) finally producer.close()
    case "graph-server" :: rest => serve(cwd(rest))
    case _ => throw new IllegalArgumentException(
      "usage: samchon-scala-graph --version | supports --cwd ROOT | snapshot --cwd ROOT --output FILE | graph-server --cwd ROOT")

  private def serve(root: Path): Unit =
    val producer = new SnapshotProducer(root)
    val reader = new BufferedReader(new InputStreamReader(System.in, java.nio.charset.StandardCharsets.UTF_8))
    try
      Iterator.continually(reader.readLine()).takeWhile(_ != null).foreach { line =>
        if line.trim.nonEmpty then respond(producer, line)
      }
    finally producer.close()

  private def respond(producer: SnapshotProducer, line: String): Unit =
    var id = -1L
    try
      val request = AtomicJson.mapper.readTree(line)
      if request == null || !request.isObject then throw new IllegalArgumentException("request must be an object")
      val idNode = request.get("id")
      if idNode == null || !idNode.canConvertToLong || idNode.longValue < 0 then
        throw new IllegalArgumentException("request id must be a non-negative integer")
      id = idNode.longValue
      val protocol = request.get("protocolVersion")
      if protocol == null || !protocol.isInt || protocol.intValue != 1 then
        throw new IllegalArgumentException("unsupported protocol version")
      val output = request.get("output")
      if output == null || !output.isTextual || output.asText.isEmpty then
        throw new IllegalArgumentException("request output must be a path")
      producer.produce(Path.of(output.asText))
      writeResponse(id, true, null)
    catch case error: Throwable => writeResponse(id, false, message(error))

  private def writeResponse(id: Long, ok: Boolean, error: String | Null): Unit =
    val response = AtomicJson.mapper.createObjectNode()
    response.put("id", id)
    response.put("protocolVersion", 1)
    response.put("ok", ok)
    if error != null then response.put("error", error)
    System.out.println(AtomicJson.mapper.writeValueAsString(response))
    System.out.flush()

  private def cwd(arguments: List[String]): Path = requiredPath(arguments, "--cwd")

  private def requiredPath(arguments: List[String], option: String): Path =
    arguments.sliding(2).collectFirst { case List(`option`, value) if value.nonEmpty => Path.of(value) }
      .getOrElse(throw new IllegalArgumentException(s"$option is required"))

  private def message(error: Throwable): String =
    Iterator.iterate(error)(_.getCause).takeWhile(_ != null).map(current =>
      Option(current.getMessage).filter(_.nonEmpty).getOrElse(current.getClass.getSimpleName)).toList.last
