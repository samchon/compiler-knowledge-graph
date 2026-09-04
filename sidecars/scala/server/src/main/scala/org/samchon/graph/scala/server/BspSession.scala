package org.samchon.graph.scala.server

import ch.epfl.scala.bsp4j.*
import com.fasterxml.jackson.databind.JsonNode
import java.net.URI
import java.nio.file.{Files, Path}
import java.util.concurrent.{ConcurrentHashMap, Executors, TimeUnit}
import org.eclipse.lsp4j.jsonrpc.Launcher
import scala.collection.concurrent.TrieMap
import scala.jdk.CollectionConverters.*

private[server] final case class SourceDescriptor(uri: String, path: Path, generated: Boolean)

private[server] final case class TargetDescriptor(
  target: BuildTarget,
  scalaVersion: String,
  scalaBinaryVersion: String,
  platform: String,
  options: List[String],
  classpath: List[String],
  classDirectory: Path,
  sources: List[SourceDescriptor],
  sourceRoots: List[String],
  graphOutput: Path
):
  val uri: String = target.getId.getUri
  val expectedPlugin: String = if scalaVersion.startsWith("2.") then "scala2" else "scala3"

private[server] trait RemoteScalaBuildServer extends BuildServer with ScalaBuildServer

/** One resident, initialized BSP connection. It never requests a clean. */
private[server] final class BspSession private (
  root: Path,
  details: ConnectionDetails,
  process: Process,
  launcher: Launcher[RemoteScalaBuildServer],
  client: DiagnosticClient,
  executor: java.util.concurrent.ExecutorService
) extends AutoCloseable:
  private val server = launcher.getRemoteProxy
  private var reloadSupported = false

  def reload(): Unit =
    ensureAlive()
    if reloadSupported then await(server.workspaceReload(), 120)

  def describeTargets(): List[TargetDescriptor] =
    ensureAlive()
    val rawTargets = await(server.workspaceBuildTargets()).getTargets.asScala.toList
      .filter(target =>
        Option(target.getLanguageIds).exists(_.asScala.contains("scala")) &&
        Option(target.getCapabilities).exists(capabilities =>
          java.lang.Boolean.TRUE == capabilities.getCanCompile))
      .sortBy(_.getId.getUri)
    if rawTargets.isEmpty then fail("BSP workspace has no Scala build targets")
    val identifiers = rawTargets.map(_.getId)
    val sourcesByTarget = await(server.buildTargetSources(new SourcesParams(identifiers.asJava)))
      .getItems.asScala.map(item => item.getTarget.getUri -> item).toMap
    val optionsByTarget = await(server.buildTargetScalacOptions(new ScalacOptionsParams(identifiers.asJava)))
      .getItems.asScala.map(item => item.getTarget.getUri -> item).toMap

    val descriptors = rawTargets.flatMap { target =>
      val uri = target.getId.getUri
      val sourceItem = sourcesByTarget.getOrElse(uri, fail(s"BSP omitted sources for $uri"))
      val sources = expandSources(sourceItem)
      if sources.isEmpty then None
      else
        if target.getDataKind != BuildTargetDataKind.SCALA then
          fail(s"Scala BSP target $uri has no Scala target data")
        val scala = scalaTarget(target)
        val scalac = optionsByTarget.getOrElse(uri, fail(s"BSP omitted scalac options for $uri"))
        val options = scalac.getOptions.asScala.toList
        val graphOutput = graphOption(options, "output").map(pathValue).getOrElse(
          fail(s"BSP target $uri does not configure the samchon-graph output"))
        val expectedTarget = graphOption(options, "target").getOrElse(
          fail(s"BSP target $uri does not configure the samchon-graph target"))
        val expectedRoot = graphOption(options, "root").map(pathValue).getOrElse(
          fail(s"BSP target $uri does not configure the samchon-graph root"))
        if expectedTarget != uri then
          fail(s"BSP target $uri configures a different samchon-graph target: $expectedTarget")
        if expectedRoot != root then fail(s"BSP target $uri configures a different project root")
        if !graphOutput.startsWith(root) then fail(s"BSP target $uri graph output escapes the project root")
        requireSemanticdb(uri, scala._1, options)
        Some(TargetDescriptor(
          target,
          scala._1,
          scala._2,
          scala._3,
          options,
          scalac.getClasspath.asScala.toList,
          confinedPath(scalac.getClassDirectory, s"class directory for $uri"),
          sources,
          Option(sourceItem.getRoots).fold(List.empty[String])(_.asScala.toList.sorted),
          graphOutput))
    }
    if descriptors.isEmpty then fail("BSP workspace has no non-empty Scala build targets")
    descriptors

  def compile(targets: List[TargetDescriptor]): Unit =
    targets.foreach(target => client.clear(target.uri))
    val params = new CompileParams(targets.map(_.target.getId).asJava)
    params.setOriginId("samchon-scala-graph")
    val result = await(server.buildTargetCompile(params))
    result.getStatusCode match
      case StatusCode.OK => ()
      case StatusCode.CANCELLED => fail("BSP compile was cancelled")
      case _ => fail("BSP compile failed")

  def diagnostics(target: String, source: Path): List[ch.epfl.scala.bsp4j.Diagnostic] =
    client.diagnostics(target, source.toUri.toString)

  private def requireSemanticdb(uri: String, version: String, options: List[String]): Unit =
    val hasGraphPlugin = options.exists(_.startsWith("-P:samchon-graph:")) &&
      options.exists(option => option.startsWith("-Xplugin:") || option.startsWith("-Xplugin-require:samchon-graph"))
    val hasSemanticdb =
      if version.startsWith("2.") then
        options.exists(_.startsWith("-P:semanticdb:sourceroot:")) &&
          options.exists(_.startsWith("-P:semanticdb:buildtarget:")) &&
          options.exists(_.startsWith("-P:semanticdb:targetroot:"))
      else options.contains("-Xsemanticdb") || options.exists(_.startsWith("-Xsemanticdb:"))
    if !hasGraphPlugin then fail(s"BSP target $uri does not load the samchon-graph compiler plugin")
    if !hasSemanticdb then fail(s"BSP target $uri does not emit SemanticDB")

  private def graphOption(options: List[String], name: String): Option[String] =
    val prefix = s"-P:samchon-graph:$name="
    val values = options.filter(_.startsWith(prefix)).map(_.substring(prefix.length)).distinct
    values match
      case value :: Nil if value.nonEmpty => Some(value)
      case Nil => None
      case _ => fail(s"duplicate samchon-graph option $name")

  private def scalaTarget(target: BuildTarget): (String, String, String) =
    val node = AtomicJson.mapper.readTree(String.valueOf(target.getData))
    val version = requiredText(node, "scalaVersion", target)
    val binary = requiredText(node, "scalaBinaryVersion", target)
    if !(version.startsWith("2.12.") || version.startsWith("2.13.") || version.startsWith("3.")) then
      fail(s"unsupported Scala version $version in ${target.getId.getUri}")
    val expectedBinary = if version.startsWith("3.") then "3" else version.split('.').take(2).mkString(".")
    if binary != expectedBinary then fail(s"invalid Scala binary version $binary in ${target.getId.getUri}")
    val platformNode = node.get("platform")
    val platform =
      if platformNode == null then fail(s"missing Scala platform in ${target.getId.getUri}")
      else if platformNode.isNumber then platformNode.intValue match
        case 1 => "jvm"
        case 2 => "js"
        case 3 => "native"
        case value => fail(s"unsupported Scala platform $value in ${target.getId.getUri}")
      else platformNode.asText.toLowerCase
    (version, binary, platform)

  private def requiredText(node: JsonNode, key: String, target: BuildTarget): String =
    val value = if node == null then null else node.get(key)
    if value == null || !value.isTextual || value.asText.isEmpty then
      fail(s"missing $key in Scala BSP target ${target.getId.getUri}")
    value.asText

  private def expandSources(item: SourcesItem): List[SourceDescriptor] =
    val expanded = item.getSources.asScala.toList.flatMap { source =>
      val path = confinedPath(source.getUri, s"source in ${item.getTarget.getUri}")
      if Files.isDirectory(path) then
        val stream = Files.walk(path)
        try stream.iterator.asScala
          .filter(file => Files.isRegularFile(file) && file.getFileName.toString.endsWith(".scala"))
          .map(file => SourceDescriptor(file.toUri.toString, file, source.getGenerated.booleanValue))
          .toList
        finally stream.close()
      else if path.getFileName.toString.endsWith(".scala") then
        List(SourceDescriptor(source.getUri, path, source.getGenerated.booleanValue))
      else Nil
    }
    expanded.groupBy(_.path).values.map(_.head).toList.sortBy(_.path.toString)

  private def confinedPath(value: String, label: String): Path =
    val path = pathValue(value)
    if !path.startsWith(root) then fail(s"BSP $label escapes the project root: $path")
    path

  private def pathValue(value: String): Path =
    val path =
      if value.matches("^[A-Za-z]:[\\\\/].*") then Path.of(value)
      else
        val parsed = URI.create(value)
        if parsed.getScheme == null then Path.of(value)
        else if parsed.getScheme == "file" then Path.of(parsed)
        else fail(s"unsupported non-file BSP path: $value")
    (if path.isAbsolute then path else root.resolve(path)).toAbsolutePath.normalize

  private def ensureAlive(): Unit =
    if !process.isAlive then fail(s"BSP server ${details.name} exited")

  override def close(): Unit =
    try
      if process.isAlive then
        try await(server.buildShutdown(), 10)
        finally server.onBuildExit()
    catch case _: Throwable => ()
    finally
      if process.isAlive then
        process.destroy()
        if !process.waitFor(5, TimeUnit.SECONDS) then process.destroyForcibly()
      executor.shutdownNow()

  private def await[A](future: java.util.concurrent.CompletableFuture[A], seconds: Long = 300): A =
    future.get(seconds, TimeUnit.SECONDS)

  private def fail(message: String): Nothing = throw new IllegalStateException(s"samchon-scala-graph: $message")

private[server] object BspSession:
  def open(rootValue: Path): BspSession =
    val root = rootValue.toAbsolutePath.normalize
    val details = readConnection(root)
    val builder = new ProcessBuilder(details.argv.asJava)
      .directory(root.toFile)
      .redirectError(ProcessBuilder.Redirect.INHERIT)
    val process = builder.start()
    val client = new DiagnosticClient(root)
    val executor = Executors.newCachedThreadPool((task: Runnable) =>
      val thread = new Thread(task, "samchon-scala-bsp")
      thread.setDaemon(true)
      thread)
    val launcher = new Launcher.Builder[RemoteScalaBuildServer]()
      .setLocalService(client)
      .setRemoteInterface(classOf[RemoteScalaBuildServer])
      .setInput(process.getInputStream)
      .setOutput(process.getOutputStream)
      .setExecutorService(executor)
      .create()
    launcher.startListening()
    val session = new BspSession(root, details, process, launcher, client, executor)
    try
      val params = new InitializeBuildParams(
        "samchon-scala-graph",
        Main.Version,
        details.bspVersion,
        root.toUri.toString,
        new BuildClientCapabilities(List("scala").asJava))
      val initialized = session.await(launcher.getRemoteProxy.buildInitialize(params), 120)
      val compile = initialized.getCapabilities.getCompileProvider
      if compile == null || !compile.getLanguageIds.asScala.contains("scala") then
        session.fail("BSP server does not advertise Scala compilation")
      launcher.getRemoteProxy.onBuildInitialized()
      session.reloadSupported = java.lang.Boolean.TRUE == initialized.getCapabilities.getCanReload
      session
    catch
      case error: Throwable =>
        session.close()
        throw error

  private def readConnection(root: Path): ConnectionDetails =
    val directory = root.resolve(".bsp")
    if !Files.isDirectory(directory) then fail("the project has no .bsp directory")
    val stream = Files.list(directory)
    val files = try stream.iterator.asScala
      .filter(path => Files.isRegularFile(path) && path.getFileName.toString.endsWith(".json"))
      .toList.sortBy(_.getFileName.toString)
    finally stream.close()
    val connections = files.flatMap { file =>
      val node = AtomicJson.mapper.readTree(Files.readAllBytes(file))
      val languages = Option(node.get("languages")).filter(_.isArray)
        .fold(List.empty[String])(_.elements.asScala.map(_.asText).toList)
      if !languages.contains("scala") then None
      else
        val argvNode = node.get("argv")
        if argvNode == null || !argvNode.isArray then fail(s"invalid BSP argv in $file")
        val argv = argvNode.elements.asScala.map(_.asText).filter(_.nonEmpty).toList
        if argv.isEmpty then fail(s"empty BSP argv in $file")
        Some(ConnectionDetails(
          required(node, "name", file),
          argv,
          required(node, "bspVersion", file)))
    }
    connections match
      case connection :: Nil => connection
      case Nil => fail("the project has no Scala BSP connection")
      case _ => fail("the project has more than one Scala BSP connection")

  private def required(node: JsonNode, key: String, file: Path): String =
    val value = node.get(key)
    if value == null || !value.isTextual || value.asText.isEmpty then fail(s"missing $key in $file")
    value.asText

  private def fail(message: String): Nothing = throw new IllegalStateException(s"samchon-scala-graph: $message")

private[server] final case class ConnectionDetails(name: String, argv: List[String], bspVersion: String)

private[server] final class DiagnosticClient(root: Path) extends BuildClient:
  private val values = TrieMap.empty[String, TrieMap[String, Vector[ch.epfl.scala.bsp4j.Diagnostic]]]

  def clear(target: String): Unit = values.remove(target)

  def diagnostics(target: String, source: String): List[ch.epfl.scala.bsp4j.Diagnostic] =
    values.get(target).flatMap(_.get(source)).fold(List.empty[ch.epfl.scala.bsp4j.Diagnostic])(_.toList)

  override def onBuildPublishDiagnostics(params: PublishDiagnosticsParams): Unit =
    val target = params.getBuildTarget.getUri
    val source = params.getTextDocument.getUri
    val targetValues = values.getOrElseUpdate(target, TrieMap.empty)
    val incoming = params.getDiagnostics.asScala.toVector
    if java.lang.Boolean.TRUE == params.getReset then targetValues.put(source, incoming)
    else targetValues.updateWith(source)(previous => Some(previous.getOrElse(Vector.empty) ++ incoming))

  override def onBuildShowMessage(params: ShowMessageParams): Unit = ()
  override def onBuildLogMessage(params: LogMessageParams): Unit = ()
  override def onBuildTargetDidChange(params: DidChangeBuildTarget): Unit = ()
  override def onBuildTaskStart(params: TaskStartParams): Unit = ()
  override def onBuildTaskProgress(params: TaskProgressParams): Unit = ()
  override def onBuildTaskFinish(params: TaskFinishParams): Unit = ()
