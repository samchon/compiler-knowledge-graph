package org.samchon.graph.scala.server

import java.nio.file.{Files, Path}
import java.security.MessageDigest
import java.util.HexFormat
import org.samchon.graph.scala.model.{Evidence, GraphEdge, GraphNode, TypedShard}
import org.samchon.graph.scala.plugin.GraphShardWriter
import org.samchon.graph.scala.server.model.{DiagnosticFact, SemanticShard}
import scala.jdk.CollectionConverters.*
import scala.meta.internal.semanticdb.{Diagnostic as SemanticDiagnostic, Range as SemanticRange, SymbolInformation, SymbolOccurrence, TextDocument, TextDocuments}

private[server] final class SemanticDbReader(root: Path, target: TargetDescriptor, bsp: BspSession):
  private val documents = loadDocuments()

  def shard(source: SourceDescriptor): SemanticShard =
    val relative = relativeSource(source.path)
    val typed = loadTyped(relative)
    val document = documents.getOrElse(relative,
      fail(s"SemanticDB omitted $relative in ${target.uri}"))
    validateTyped(typed, source.path, relative)
    validateSemanticdb(document, source.path, relative, typed)
    val diagnostics = (
      document.diagnostics.toList.map(semanticDiagnostic(relative, _)) ++
      bsp.diagnostics(target.uri, source.path).map(bspDiagnostic(relative, _))
    ).distinct.sortBy(value => (
      value.evidence.startLine,
      value.evidence.startColumn,
      value.severity,
      value.message))
    new SemanticShard(
      typed.schemaVersion,
      typed.language,
      typed.source,
      typed.checkerDigest,
      typed.diskDigest,
      target.uri,
      typed.compilerVersion,
      typed.compilerPlugin,
      typed.compilerPluginVersion,
      document.schema.value,
      relative,
      document.md5.toLowerCase,
      target.uri,
      typed.nodes,
      typed.edges,
      typed.unresolved,
      diagnostics.asJava)

  private def loadDocuments(): Map[String, TextDocument] =
    val directory = target.classDirectory.resolve("META-INF").resolve("semanticdb")
    if !Files.isDirectory(directory) then
      fail(s"SemanticDB output is missing for ${target.uri}: $directory")
    val stream = Files.walk(directory)
    val entries = try stream.iterator.asScala
      .filter(path => Files.isRegularFile(path) && path.getFileName.toString.endsWith(".semanticdb"))
      .toList.sortBy(_.toString)
      .flatMap(path => TextDocuments.parseFrom(Files.readAllBytes(path)).documents.toList)
    finally stream.close()
    val grouped = entries.groupBy(document => normalize(document.uri))
    grouped.map { case (uri, values) =>
      val source = root.resolve(uri).normalize
      val current =
        if source.startsWith(root) && Files.isRegularFile(source) then
          val expected = md5(Files.readAllBytes(source))
          values.filter(_.md5.equalsIgnoreCase(expected)).distinct
        else Nil
      val document = current match
        case value :: Nil => value
        case Nil if values.size == 1 => values.head
        case Nil => fail(s"duplicate stale SemanticDB document $uri in ${target.uri}")
        case _ => fail(s"conflicting current SemanticDB documents $uri in ${target.uri}")
      uri -> document
    }

  private def loadTyped(relative: String): TypedShard =
    val targetKey = GraphShardWriter.digest(target.uri.getBytes(java.nio.charset.StandardCharsets.UTF_8))
    val sourceKey = GraphShardWriter.digest(relative.getBytes(java.nio.charset.StandardCharsets.UTF_8))
    val path = target.graphOutput.resolve("typed").resolve(targetKey).resolve(sourceKey + ".json")
    if !Files.isRegularFile(path) then fail(s"typed compiler shard is missing for ${target.uri} $relative")
    AtomicJson.mapper.readValue(Files.readAllBytes(path), classOf[TypedShard])

  private def validateTyped(typed: TypedShard, source: Path, relative: String): Unit =
    val bytes = Files.readAllBytes(source)
    val diskDigest = GraphShardWriter.digest(bytes)
    if typed.schemaVersion != 1 || typed.language != "scala" || typed.source != relative then
      fail(s"malformed typed compiler shard for ${target.uri} $relative")
    if typed.target != target.uri || typed.compilerVersion != target.scalaVersion ||
        typed.compilerPlugin != target.expectedPlugin || typed.compilerPluginVersion.isEmpty then
      fail(s"typed compiler identity does not match ${target.uri} $relative")
    if typed.diskDigest != diskDigest || typed.checkerDigest != diskDigest then
      fail(s"typed compiler source digest does not match ${target.uri} $relative")
    if typed.nodes.isEmpty then fail(s"typed compiler shard has no declarations for ${target.uri} $relative")

  private def validateSemanticdb(
    document: TextDocument,
    source: Path,
    relative: String,
    typed: TypedShard
  ): Unit =
    if !document.schema.isSemanticdb4 then fail(s"unsupported SemanticDB schema for ${target.uri} $relative")
    if normalize(document.uri) != relative then fail(s"SemanticDB URI does not match $relative")
    val expectedMd5 = md5(Files.readAllBytes(source))
    if !document.md5.equalsIgnoreCase(expectedMd5) then fail(s"SemanticDB md5 does not match $relative")
    if document.buildTarget.nonEmpty && document.buildTarget != target.uri then
      fail(s"SemanticDB build target does not match ${target.uri} $relative")

    val definitions = document.occurrences.toList
      .filter(_.role == SymbolOccurrence.Role.DEFINITION)
    val information = document.symbols.toList.groupBy(_.displayName)
    typed.nodes.asScala.filter(_.origin != "Synthetic").foreach { node =>
      val semanticNames =
        if node.kind == "constructor" then
          List(node.qualifiedName.split('.').dropRight(1).lastOption.getOrElse(node.name).stripSuffix("$"))
        else List(node.name)
      val named = semanticNames.flatMap(name => information.getOrElse(name, Nil))
      val namedSymbols = named.map(_.symbol).toSet
      val positionedSymbols = definitions.iterator.filter(occurrence =>
        namedSymbols.contains(occurrence.symbol) &&
          (node.kind == "constructor" || occurrence.range.exists(range => overlaps(node.evidence, range))))
        .map(_.symbol).toSet
      val anonymousContextual = node.modifiers.contains("declare") && named.nonEmpty
      val matched =
        if positionedSymbols.nonEmpty then named.filter(info => positionedSymbols.contains(info.symbol))
        else if anonymousContextual then named
        else Nil
      // SemanticDB records package definitions as occurrences but commonly
      // omits their SymbolInformation row. The typed plugin still owns the
      // declaration; cross-check it against the canonical package symbol.
      val packageMatched = node.kind == "package" && definitions.exists(occurrence =>
        occurrence.symbol == node.qualifiedName.replace('.', '/') + "/" &&
          occurrence.range.exists(range => overlaps(node.evidence, range)))
      if matched.isEmpty && !packageMatched then
        fail(s"typed declaration ${node.qualifiedName} has no SemanticDB definition in $relative")
      // Case-class constructor parameters have SymbolInformation entries, but
      // SemanticDB positions the generated accessor method at their source
      // token instead of the parameter symbol itself.
      val kindMatched =
        if node.kind == "parameter" then named.filter(info => compatibleKind(node.kind, info.kind))
        else matched.filter(info => compatibleKind(node.kind, info.kind))
      if kindMatched.isEmpty && !packageMatched then
        fail(s"typed declaration ${node.qualifiedName} disagrees with SemanticDB kind in $relative")
      if !Set("package", "type", "parameter").contains(node.kind) &&
          (node.signature.isEmpty || matched.forall(_.signature.isEmpty)) then
        fail(s"typed declaration ${node.qualifiedName} has no SemanticDB signature in $relative")
      val outgoing = typed.edges.asScala.filter(_.from == node.symbol)
      if outgoing.exists(_.kind == "overrides") && matched.forall(_.overriddenSymbols.isEmpty) then
        fail(s"typed override ${node.qualifiedName} is absent from SemanticDB in $relative")
      if outgoing.exists(_.kind == "decorates") && matched.forall(_.annotations.isEmpty) then
        fail(s"typed annotation ${node.qualifiedName} is absent from SemanticDB in $relative")
    }
    val semanticEdges = typed.edges.asScala.filter(edge =>
      Set("imports", "references", "type_ref").contains(edge.kind))
    if semanticEdges.nonEmpty && !document.occurrences.exists(_.role == SymbolOccurrence.Role.REFERENCE) then
      fail(s"typed semantic references are absent from SemanticDB in $relative")

  private def compatibleKind(typed: String, semantic: SymbolInformation.Kind): Boolean =
    typed match
      case "package" => semantic.isPackage || semantic.isPackageObject
      case "class" => semantic.isClass
      case "interface" => semantic.isTrait || semantic.isInterface
      case "module" => semantic.isObject || semantic.isPackageObject
      case "constructor" =>
        semantic.isClass || semantic.isTrait || semantic.isInterface || semantic.isObject
      case "method" | "function" => semantic.isMethod || semantic.isMacro
      case "field" | "property" | "variable" =>
        semantic.isField || semantic.isMethod || semantic.isLocal
      case "parameter" =>
        semantic.isParameter || semantic.isSelfParameter || semantic.isTypeParameter
      case "type" => semantic.isType || semantic.isTypeParameter
      case _ => false

  private def semanticDiagnostic(relative: String, value: SemanticDiagnostic): DiagnosticFact =
    val evidence = value.range.fold(new Evidence(relative, 1, 1, 1, 1))(semanticEvidence(relative, _))
    new DiagnosticFact(diagnosticSeverity(value.severity.toString), value.message, evidence)

  private def bspDiagnostic(relative: String, value: ch.epfl.scala.bsp4j.Diagnostic): DiagnosticFact =
    val range = value.getRange
    val evidence = new Evidence(
      relative,
      range.getStart.getLine + 1,
      range.getStart.getCharacter + 1,
      range.getEnd.getLine + 1,
      range.getEnd.getCharacter + 1)
    val severity = Option(value.getSeverity).fold("info")(value => diagnosticSeverity(value.toString))
    new DiagnosticFact(severity, value.getMessage, evidence)

  private def diagnosticSeverity(value: String): String =
    value.toLowerCase match
      case "information" => "info"
      case severity => severity

  private def semanticEvidence(relative: String, range: SemanticRange): Evidence =
    new Evidence(
      relative,
      range.startLine + 1,
      range.startCharacter + 1,
      range.endLine + 1,
      range.endCharacter + 1)

  private def overlaps(evidence: Evidence, range: SemanticRange): Boolean =
    val start = (range.startLine + 1, range.startCharacter + 1)
    val end = (range.endLine + 1, range.endCharacter + 1)
    val evidenceStart = (evidence.startLine, evidence.startColumn)
    val evidenceEnd = (evidence.endLine, evidence.endColumn)
    beforeOrEqual(start, evidenceEnd) && beforeOrEqual(evidenceStart, end)

  private def beforeOrEqual(left: (Int, Int), right: (Int, Int)): Boolean =
    left._1 < right._1 || left._1 == right._1 && left._2 <= right._2

  private def relativeSource(path: Path): String =
    root.relativize(path.toAbsolutePath.normalize).toString.replace('\\', '/')

  private def normalize(value: String): String =
    value.replace('\\', '/').stripPrefix("./")

  private def md5(bytes: Array[Byte]): String =
    HexFormat.of.formatHex(MessageDigest.getInstance("MD5").digest(bytes))

  private def fail(message: String): Nothing = throw new IllegalStateException(s"samchon-scala-graph: $message")
