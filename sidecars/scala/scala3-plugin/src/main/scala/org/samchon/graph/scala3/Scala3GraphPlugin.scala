package org.samchon.graph.scala3

import java.nio.file.Path
import java.util.{ArrayList, Collections}

import dotty.tools.dotc.ast.tpd
import dotty.tools.dotc.ast.tpd.*
import dotty.tools.dotc.core.Contexts.Context
import dotty.tools.dotc.core.Flags
import dotty.tools.dotc.core.Symbols.Symbol
import dotty.tools.dotc.plugins.{PluginPhase, StandardPlugin}
import dotty.tools.dotc.transform.{FirstTransform, PickleQuotes}
import org.samchon.graph.scala.model.{Evidence, GraphEdge, GraphNode, UnresolvedSite}
import org.samchon.graph.scala.plugin.{GraphShardWriter, PluginOptions}
import scala.jdk.CollectionConverters.*

/** Scala 3 typed-tree exporter. The phase observes trees after typer and before lowering. */
final class Scala3GraphPlugin extends StandardPlugin:
  override val name = "samchon-graph"
  override val description = "Emit compiler-owned graph shards after typer"
  override val optionsHelp = Some(
    "-P:samchon-graph:root=<absolute>:output=<absolute>:target=<bsp-uri>:version=<producer-version>")

  override def initialize(options: List[String])(using Context): List[PluginPhase] =
    val parsed = PluginOptions.parse(java.util.List.copyOf(options.asJava))
    List(new Scala3GraphPhase(parsed))

private final class Scala3GraphPhase(options: PluginOptions) extends PluginPhase:
  override val phaseName = "samchon-graph"
  override val runsAfter = Set("typer")
  override val runsBefore = Set(PickleQuotes.name, FirstTransform.name)

  private var collector: Collector | Null = null

  override def prepareForUnit(tree: Tree)(using Context): Context =
    collector = new Collector(options)
    summon[Context]

  override def transformUnit(tree: Tree)(using Context): Tree =
    current.write()
    collector = null
    tree

  override def transformTypeDef(tree: TypeDef)(using Context): Tree =
    current.declare(tree.symbol, tree)
    tree.rhs match
      case template: Template => current.parents(tree.symbol, template)
      case _ => ()
    tree

  override def transformPackageDef(tree: PackageDef)(using Context): Tree =
    current.declare(tree.symbol, tree)
    tree

  override def transformDefDef(tree: DefDef)(using Context): Tree =
    current.declare(tree.symbol, tree)
    current.typeReference(tree.symbol, tree)
    tree

  override def transformValDef(tree: ValDef)(using Context): Tree =
    current.declare(tree.symbol, tree)
    current.typeReference(tree.symbol, tree)
    tree

  override def transformApply(tree: Apply)(using Context): Tree =
    current.call(tree.fun.symbol, tree)
    tree

  override def transformNew(tree: New)(using Context): Tree =
    current.instantiate(tree.tpe.typeSymbol, tree)
    tree

  override def transformAssign(tree: Assign)(using Context): Tree =
    current.reference(tree.lhs.symbol, "write", tree.lhs)
    tree

  override def transformSelect(tree: Select)(using Context): Tree =
    current.reference(tree.symbol, "read", tree)
    tree

  override def transformIdent(tree: Ident)(using Context): Tree =
    current.reference(tree.symbol, "read", tree)
    tree

  override def transformTypeTree(tree: TypeTree)(using Context): Tree =
    current.typeReference(summon[Context].owner, tree, tree.tpe.typeSymbol)
    tree

  override def transformOther(tree: Tree)(using Context): Tree =
    tree match
      case importing: Import => current.importReference(importing.expr.symbol, importing)
      case _ => ()
    tree

  private def current: Collector =
    if collector == null then throw new IllegalStateException("samchon-graph: compilation unit is missing")
    collector.nn

private final class Collector(options: PluginOptions)(using initialContext: Context):
  private val nodes = new ArrayList[GraphNode]()
  private val edges = new ArrayList[GraphEdge]()
  private val unresolved = new ArrayList[UnresolvedSite]()
  private val declared = scala.collection.mutable.HashSet.empty[String]
  private val sourcePath = Path.of(initialContext.source.path).toAbsolutePath.normalize
  private val source = options.projectRoot.relativize(sourcePath).toString.replace('\\', '/')

  def write()(using Context): Unit =
    GraphShardWriter.write(
      options,
      sourcePath,
      initialContext.source.content.mkString,
      dotty.tools.dotc.config.Properties.versionNumberString,
      "scala3",
      nodes,
      edges,
      unresolved)

  def declare(symbol: Symbol, tree: Tree)(using Context): Unit =
    if !usable(symbol, tree) then return
    val key = symbolKey(symbol)
    if !declared.add(key) then return
    val modifiers = new ArrayList[String]()
    if exported(symbol) then modifiers.add("public")
    if symbol.is(Flags.Private) then modifiers.add("private")
    if symbol.is(Flags.Protected) then modifiers.add("protected")
    if symbol.is(Flags.Deferred) then modifiers.add("abstract")
    if symbol.is(Flags.Final) then modifiers.add("readonly")
    if symbol.isOneOf(Flags.GivenOrImplicit) then modifiers.add("declare")
    nodes.add(new GraphNode(
      key,
      kind(symbol),
      symbol.name.show,
      qualified(symbol),
      source,
      exported(symbol),
      modifiers,
      signature(symbol),
      if generated(symbol) then "Synthetic" else "Source",
      position(tree)))
    edges.add(edge(ownerKey(symbol.owner), symbol, "contains", tree, "typed-plugin"))
    if exported(symbol) then edges.add(edge(source, symbol, "exports", tree, "semanticdb"))
    symbol.allOverriddenSymbols.foreach(overridden =>
      edges.add(edge(key, overridden, "overrides", tree, "semanticdb")))
    symbol.annotations.foreach(annotation =>
      val target = annotation.symbol
      if target.exists && !target.fullName.show.startsWith("scala.annotation.internal.") then
        edges.add(edge(key, target, "decorates", tree, "semanticdb")))

  def parents(symbol: Symbol, template: Template)(using Context): Unit =
    template.parents.foreach(parent =>
      val target = parent.tpe.typeSymbol
      if target.exists then
        val family = if target.is(Flags.Trait) then "implements" else "extends"
        edges.add(edge(symbolKey(symbol), target, family, parent, "semanticdb")))

  def call(target: Symbol, tree: Tree)(using Context): Unit =
    if !usable(target, tree) then return
    val owner = ownerKey(summon[Context].owner)
    edges.add(edge(owner, target, "calls", tree, "typed-plugin"))
    edges.add(edge(owner, target, "references", tree, "semanticdb"))
    if target.is(Flags.Method) && !target.is(Flags.Final) && !target.owner.is(Flags.Final) then
      unresolved.add(new UnresolvedSite(
        "dispatches", "dynamic", position(tree), Collections.singletonList(symbolKey(target))))
    if target.is(Flags.Inline) then
      unresolved.add(new UnresolvedSite(
        "calls", "macro-or-generated", position(tree), Collections.singletonList(symbolKey(target))))

  def instantiate(target: Symbol, tree: Tree)(using Context): Unit =
    if usable(target, tree) then
      edges.add(edge(ownerKey(summon[Context].owner), target, "instantiates", tree, "typed-plugin"))

  def reference(target: Symbol, access: String, tree: Tree)(using Context): Unit =
    if !usable(target, tree) || target.is(Flags.Package) then return
    edges.add(new GraphEdge(
      ownerKey(summon[Context].owner),
      symbolKey(target),
      "accesses",
      access,
      "typed-plugin",
      kind(target),
      target.name.show,
      qualified(target),
      position(tree)))
    if target.isOneOf(Flags.GivenOrImplicit) then
      unresolved.add(new UnresolvedSite(
        "references", "macro-or-generated", position(tree), Collections.singletonList(symbolKey(target))))

  def importReference(target: Symbol, tree: Tree)(using Context): Unit =
    if usable(target, tree) then
      edges.add(edge(ownerKey(summon[Context].owner), target, "imports", tree, "semanticdb"))

  def typeReference(symbol: Symbol, tree: Tree)(using Context): Unit =
    if symbol.exists then typeReference(symbol, tree, symbol.info.finalResultType.typeSymbol)

  def typeReference(symbol: Symbol, tree: Tree, target: Symbol)(using Context): Unit =
    if symbol.exists && target.exists && target != symbol then
      edges.add(edge(symbolKey(symbol), target, "type_ref", tree, "semanticdb"))

  private def edge(from: String, target: Symbol, family: String, tree: Tree, provenance: String)(using Context) =
    new GraphEdge(
      from,
      symbolKey(target),
      family,
      null,
      provenance,
      kind(target),
      target.name.show,
      qualified(target),
      position(tree))

  private def usable(symbol: Symbol, tree: Tree)(using Context): Boolean =
    symbol.exists && tree.sourcePos.exists

  private def exported(symbol: Symbol): Boolean =
    !symbol.isOneOf(Flags.Private | Flags.Protected)

  private def generated(symbol: Symbol): Boolean =
    symbol.isOneOf(Flags.Synthetic | Flags.Artifact | Flags.ModuleVal) ||
      symbol.name.show.contains("$anon") ||
      symbol.name.show.contains("$proxy") ||
      symbol.name.show.endsWith("$package") ||
      symbol.name.show == "MirroredMonoType" ||
      symbol.isOneOf(Flags.Module | Flags.ModuleClass) &&
        symbol.companionClass.exists &&
        symbol.companionClass.isOneOf(Flags.Case | Flags.Enum) ||
      symbol.isConstructor && symbol.owner.isOneOf(Flags.Synthetic | Flags.Artifact) ||
      symbol.is(Flags.Param) && (
        symbol.owner.isOneOf(Flags.Synthetic | Flags.Artifact) ||
          symbol.owner.isConstructor &&
            symbol.owner.owner.isOneOf(Flags.Synthetic | Flags.Artifact))

  private def ownerKey(symbol: Symbol)(using Context): String =
    if !symbol.exists || symbol.is(Flags.Package) then source else symbolKey(symbol)

  private def symbolKey(symbol: Symbol)(using Context): String =
    // A package declaration is source syntax repeated in every compilation
    // unit, unlike the single package symbol the compiler interns globally.
    if symbol.is(Flags.Package) then s"scala-package $source|${symbol.fullName.show}"
    else s"scala-structural ${ownerIdentity(symbol.owner)}|${kind(symbol)}|${symbol.name.show}|${signature(symbol)}${lexical(symbol)}"

  private def ownerIdentity(symbol: Symbol)(using Context): String =
    if !symbol.exists then ""
    else if symbol.is(Flags.Package) then symbol.fullName.show
    else s"${ownerIdentity(symbol.owner)}|${kind(symbol)}|${symbol.name.show}|${signature(symbol)}${lexical(symbol)}"

  private def lexical(symbol: Symbol): String =
    if symbol.owner.exists && symbol.owner.is(Flags.Method) && !symbol.is(Flags.Param) &&
        symbol.sourcePos.exists
    then s"|lexical=${symbol.sourcePos.start}"
    else ""

  private def signature(symbol: Symbol)(using Context): String =
    val value =
      if symbol.isClass then symbol.typeParams.map(_.name.show).mkString("[", ",", "]")
      else symbol.info.show
    value.replaceAll("\\u001b\\[[;\\d]*m", "").replaceAll("\\s+", " ").trim

  private def qualified(symbol: Symbol)(using Context): String =
    symbol.fullName.show

  private def kind(symbol: Symbol): String =
    if symbol.is(Flags.Package) then "package"
    else if symbol.isOneOf(Flags.Module | Flags.ModuleClass) then "module"
    else if symbol.is(Flags.Trait) then "interface"
    else if symbol.isClass then "class"
    else if symbol.isConstructor then "constructor"
    else if symbol.is(Flags.Method) then "method"
    else if symbol.isType then "type"
    else if symbol.is(Flags.Param) then "parameter"
    else if symbol.owner.exists && symbol.owner.isClass then "field"
    else "variable"

  private def position(tree: Tree)(using Context): Evidence =
    val pos = tree.sourcePos
    new Evidence(
      source,
      math.max(1, pos.startLine + 1),
      math.max(1, pos.startColumn + 1),
      math.max(1, pos.endLine + 1),
      math.max(1, pos.endColumn + 1))
