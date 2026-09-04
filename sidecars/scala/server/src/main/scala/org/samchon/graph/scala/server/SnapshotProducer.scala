package org.samchon.graph.scala.server

import java.nio.charset.StandardCharsets
import java.net.URI
import java.nio.file.attribute.{BasicFileAttributes, FileTime}
import java.nio.file.{Files, Path}
import java.util.LinkedHashMap
import org.samchon.graph.scala.plugin.GraphShardWriter
import org.samchon.graph.scala.server.model.{SnapshotArtifact, TargetSnapshot}
import scala.collection.mutable
import scala.jdk.CollectionConverters.*

/** Builds and publishes one all-target generation from the repository's own BSP compile. */
private[server] final class SnapshotProducer(rootValue: Path) extends AutoCloseable:
  private val root = rootValue.toAbsolutePath.normalize
  private var bsp: BspSession | Null = null
  private val contentDigests = mutable.HashMap.empty[Path, CachedDigest]

  def supports(): Unit = withSession { session =>
    session.reload()
    session.describeTargets()
  }

  def produce(outputValue: Path): Unit =
    val output = outputValue.toAbsolutePath.normalize
    withSession { session =>
      session.reload()
      val before = session.describeTargets()
      session.compile(before)
      val targets = session.describeTargets()
      if before.map(_.uri) != targets.map(_.uri) then fail("BSP target set changed during compile")
      val snapshots = targets.map(targetSnapshot(session, _))
      snapshots.foreach { target =>
        val descriptor = targets.find(_.uri == target.bspUri).get
        val manifest = descriptor.graphOutput.resolve("manifests")
          .resolve(digest(target.bspUri) + ".json")
        AtomicJson.write(manifest, target)
      }
      val artifact = new SnapshotArtifact(
        1,
        root.toString,
        new SnapshotArtifact.Producer(
          "samchon-scala-graph",
          Main.Version,
          1,
          new SnapshotArtifact.Capabilities(true, true, true, true, true, true, true)),
        snapshots.asJava)
      AtomicJson.write(output, artifact)
    }

  private def targetSnapshot(session: BspSession, target: TargetDescriptor): TargetSnapshot =
    val reader = new SemanticDbReader(root, target, session)
    val sources = target.sources.filter(source => Files.isRegularFile(source.path))
    if sources.isEmpty then fail(s"BSP target ${target.uri} has no Scala source files")
    val shards = sources.map(reader.shard)
    val scalacOptionsDigest = digestRows(target.options)
    // BSP commonly includes this target's own output directory in its
    // classpath. It is derived output, not a build input, and retaining it
    // makes a restored source tree inherit stale Zinc history. Other target
    // outputs remain real inputs and are still fenced by their bytes.
    val classpathDigest = digestRows(target.classpath
      .filterNot(value => classpathPath(value) == target.classDirectory)
      .map(classpathCoordinate))
    val sourceRootsDigest = digestSet(
      target.sourceRoots ++ sources.flatMap(source => Option(relative(source.path).getParent).map(_.toString)))
    val semanticdbOptionsDigest = digestRows(target.options.filter(_.toLowerCase.contains("semanticdb")))
    val compilerPluginsDigest = digestRows(target.options.filter(option =>
      option.startsWith("-Xplugin:") || option.startsWith("-P:samchon-graph:")))
    val zincAnalysisDigest = digestSet(zincCoordinates(target.classDirectory))
    val generatedSourcesDigest = digestSet(sources.filter(_.generated).map(source => relative(source.path).toString))
    val universe = digestRows(List(
      target.uri,
      target.scalaVersion,
      target.scalaBinaryVersion,
      target.platform,
      sourceEncoding(target.options),
      scalacOptionsDigest,
      classpathDigest,
      sourceRootsDigest,
      semanticdbOptionsDigest,
      compilerPluginsDigest,
      zincAnalysisDigest,
      generatedSourcesDigest))
    val generation = digestRows(universe :: shards.flatMap(shard => List(
      shard.source,
      shard.diskDigest,
      shard.checkerDigest,
      shard.semanticdbMd5,
      digestBytes(AtomicJson.mapper.writeValueAsBytes(shard)))))
    new TargetSnapshot(
      target.uri,
      generation,
      universe,
      target.uri,
      target.scalaVersion,
      target.scalaBinaryVersion,
      target.platform,
      sourceEncoding(target.options),
      scalacOptionsDigest,
      classpathDigest,
      sourceRootsDigest,
      semanticdbOptionsDigest,
      compilerPluginsDigest,
      zincAnalysisDigest,
      generatedSourcesDigest,
      coverage,
      shards.asJava)

  private def zincCoordinates(classDirectory: Path): List[String] =
    val parent = Option(classDirectory.getParent).getOrElse(classDirectory)
    if !Files.isDirectory(parent) then List(parent.toString)
    else
      val stream = Files.walk(parent, 2)
      try stream.iterator.asScala
        .filter(path => Files.isRegularFile(path) && path.getFileName.toString.toLowerCase.contains("inc_compile"))
        .map(path => root.relativize(path.toAbsolutePath.normalize).toString.replace('\\', '/'))
        .toList.sorted match
          case Nil => List(root.relativize(classDirectory).toString.replace('\\', '/'))
          case values => values
      finally stream.close()

  /** Preserve classpath order while fencing every file by its actual bytes. */
  private def classpathCoordinate(value: String): String =
    val path = classpathPath(value)
    if Files.isRegularFile(path) then s"$value\u0000${contentDigest(path)}"
    else if Files.isDirectory(path) then
      val stream = Files.walk(path)
      val files = try stream.iterator.asScala
        .filter(Files.isRegularFile(_))
        .toList.sortBy(_.toString)
      finally stream.close()
      val rows = files.map(file =>
        s"${path.relativize(file).toString.replace('\\', '/')}\u0000${contentDigest(file)}")
      s"$value\u0000${digestRows(rows)}"
    else fail(s"classpath entry is missing: $value")

  private def classpathPath(value: String): Path =
    val path =
      if value.matches("^[A-Za-z]:[\\\\/].*") then Path.of(value)
      else
        val parsed = URI.create(value)
        if parsed.getScheme == null then Path.of(value)
        else if parsed.getScheme == "file" then Path.of(parsed)
        else fail(s"unsupported non-file classpath entry: $value")
    (if path.isAbsolute then path else root.resolve(path)).toAbsolutePath.normalize

  private def contentDigest(path: Path): String =
    val attributes = Files.readAttributes(path, classOf[BasicFileAttributes])
    val stamp = FileStamp(
      attributes.size,
      attributes.lastModifiedTime,
      Option(attributes.fileKey).fold("")(_.toString))
    contentDigests.get(path) match
      case Some(cached) if cached.stamp == stamp => cached.digest
      case _ =>
        val value = digestBytes(Files.readAllBytes(path))
        contentDigests.put(path, CachedDigest(stamp, value))
        value

  private def coverage: java.util.Map[String, String] =
    val values = new LinkedHashMap[String, String]()
    List(
      "contains", "exports", "imports", "calls", "accesses", "instantiates",
      "type_ref", "extends", "implements", "overrides", "dispatches", "decorates",
      "renders", "tests", "references"
    ).foreach(family => values.put(
      family,
      if Set("renders", "tests").contains(family) then "unsupported" else "partial"))
    values.put("contains", "complete")
    values.put("calls", "partial")
    values

  private def withSession[A](body: BspSession => A): A =
    if bsp == null then bsp = BspSession.open(root)
    try body(bsp.nn)
    catch
      case error: Throwable =>
        bsp.nn.close()
        bsp = null
        throw error

  override def close(): Unit =
    if bsp != null then
      bsp.nn.close()
      bsp = null

  private def relative(path: Path): Path = root.relativize(path.toAbsolutePath.normalize)
  private def sourceEncoding(options: List[String]): String =
    val separated = options.sliding(2).collect {
      case List("-encoding", value) if value.nonEmpty => value
    }.toList
    val attached = options.flatMap { option =>
      List("-encoding:", "-encoding=").collectFirst {
        case prefix if option.startsWith(prefix) && option.length > prefix.length =>
          option.substring(prefix.length)
      }
    }
    (separated ++ attached).distinct match
      case Nil => "UTF-8"
      case value :: Nil => value
      case _ => fail("scalac configures more than one source encoding")
  private def digest(value: String): String = digestBytes(value.getBytes(StandardCharsets.UTF_8))
  private def digestRows(values: Iterable[String]): String =
    digestBytes(AtomicJson.mapper.writeValueAsBytes(values.toList.asJava))
  private def digestSet(values: Iterable[String]): String = digestRows(values.toList.distinct.sorted)
  private def digestBytes(bytes: Array[Byte]): String = GraphShardWriter.digest(bytes)
  private def fail(message: String): Nothing = throw new IllegalStateException(s"samchon-scala-graph: $message")

private final case class FileStamp(size: Long, modified: FileTime, fileKey: String)
private final case class CachedDigest(stamp: FileStamp, digest: String)
