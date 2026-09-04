package org.samchon.graph.scala2

import java.nio.file.Path
import java.util.{ArrayList, Collections, List => JList}

import org.samchon.graph.scala.model.{Evidence, GraphEdge, GraphNode, UnresolvedSite}
import org.samchon.graph.scala.plugin.{GraphShardWriter, PluginOptions}
import scala.tools.nsc.Global
import scala.tools.nsc.Phase
import scala.tools.nsc.plugins.{Plugin, PluginComponent}

/** Scala 2 typed-tree exporter. Its phase runs immediately after typer. */
final class Scala2GraphPlugin(val global: Global) extends Plugin {
  import global._

  override val name = "samchon-graph"
  override val description = "Emit compiler-owned graph shards after typer"
  override val components: List[PluginComponent] = List(GraphComponent)
  private var configured: Option[PluginOptions] = None

  override def processOptions(options: List[String], error: String => Unit): Unit =
    try configured = Some(PluginOptions.parse(java.util.List.copyOf(options.asJava)))
    catch { case exception: IllegalArgumentException => error(exception.getMessage) }

  override val optionsHelp: Option[String] = Some(
    "-P:samchon-graph:root=<absolute>:output=<absolute>:target=<bsp-uri>:version=<producer-version>")

  private object GraphComponent extends PluginComponent {
    override val global: Scala2GraphPlugin.this.global.type = Scala2GraphPlugin.this.global
    override val phaseName = "samchon-graph"
    override val runsAfter: List[String] = List("typer")
    override val runsBefore: List[String] = List("patmat")

    override def newPhase(previous: Phase): StdPhase = new StdPhase(previous) {
      override def apply(unit: CompilationUnit): Unit = configured match {
        case Some(options) => new Collector(unit, options).write()
        case None => reporter.error(unit.position(0), "samchon-graph plugin options are missing")
      }
    }
  }

  private final class Collector(unit: CompilationUnit, options: PluginOptions)
      extends Traverser {
    private val nodes = new ArrayList[GraphNode]()
    private val edges = new ArrayList[GraphEdge]()
    private val unresolved = new ArrayList[UnresolvedSite]()
    private val declared = scala.collection.mutable.HashSet.empty[String]
    private val sourcePath = unit.source.file.file.toPath.toAbsolutePath.normalize
    private val source = options.projectRoot.relativize(sourcePath).toString.replace('\\', '/')
    private var owner: String = source

    def write(): Unit = {
      traverse(unit.body)
      GraphShardWriter.write(
        options,
        sourcePath,
        new String(unit.source.content),
        scala.util.Properties.versionNumberString,
        "scala2",
        nodes,
        edges,
        unresolved)
    }

    override def traverse(tree: Tree): Unit = tree match {
      case definition: PackageDef => within(definition.symbol, definition) { super.traverse(tree) }
      case definition: ClassDef => within(definition.symbol, definition) { super.traverse(tree) }
      case definition: ModuleDef => within(definition.symbol, definition) { super.traverse(tree) }
      case definition: DefDef => within(definition.symbol, definition) { super.traverse(tree) }
      case definition: ValDef =>
        declare(definition.symbol, definition)
        typeReference(definition.symbol, definition)
        super.traverse(tree)
      case definition: TypeDef =>
        declare(definition.symbol, definition)
        super.traverse(tree)
      case function: Function => within(function.symbol, function) { super.traverse(tree) }
      case application: Apply =>
        call(application.fun.symbol, application)
        application.fun match {
          case Select(New(target), _) => instantiate(target.tpe.typeSymbol, application)
          case _ => ()
        }
        super.traverse(tree)
      case assignment: Assign =>
        reference(assignment.lhs.symbol, "write", assignment.lhs)
        super.traverse(tree)
      case selection: Select =>
        reference(selection.symbol, "read", selection)
        super.traverse(tree)
      case identifier: Ident if identifier.symbol != null && identifier.symbol != NoSymbol =>
        reference(identifier.symbol, "read", identifier)
        super.traverse(tree)
      case importing: Import =>
        val target = importing.expr.symbol
        if (usable(target, importing)) addEdge(owner, target, "imports", importing, "semanticdb")
        super.traverse(tree)
      case _ => super.traverse(tree)
    }

    private def within(symbol: Symbol, tree: Tree)(body: => Unit): Unit = {
      declare(symbol, tree)
      if (tree.isInstanceOf[ClassDef]) parents(symbol, tree.asInstanceOf[ClassDef])
      val previous = owner
      if (symbol != null && symbol != NoSymbol) owner = symbolKey(symbol)
      try body finally owner = previous
    }

    private def declare(symbol: Symbol, tree: Tree): Unit = {
      if (!usable(symbol, tree)) return
      val key = symbolKey(symbol)
      if (!declared.add(key)) return
      val evidence = position(tree)
      val modifiers = new ArrayList[String]()
      if (symbol.isPublic) modifiers.add("public")
      if (symbol.isPrivate) modifiers.add("private")
      if (symbol.isProtected) modifiers.add("protected")
      if (symbol.isAbstract) modifiers.add("abstract")
      if (symbol.isFinal) modifiers.add("readonly")
      if (symbol.isImplicit) modifiers.add("declare")
      nodes.add(new GraphNode(
        key,
        kind(symbol),
        symbol.name.decodedName.toString.trim,
        qualified(symbol),
        source,
        symbol.isPublic,
        modifiers,
        signature(symbol),
        if (symbol.isSynthetic || symbol.isAccessor) "Synthetic" else "Source",
        evidence))
      edges.add(edge(owner, symbol, "contains", tree, "typed-plugin"))
      if (symbol.isPublic) edges.add(edge(source, symbol, "exports", tree, "semanticdb"))
      symbol.allOverriddenSymbols.foreach(overridden =>
        edges.add(edge(key, overridden, "overrides", tree, "semanticdb")))
      symbol.annotations.foreach(annotation => {
        val target = annotation.tree.tpe.typeSymbol
        if (target != NoSymbol) edges.add(edge(key, target, "decorates", tree, "semanticdb"))
      })
    }

    private def parents(symbol: Symbol, definition: ClassDef): Unit =
      definition.impl.parents.foreach(parent => {
        val target = parent.tpe.typeSymbol
        if (target != null && target != NoSymbol) {
          val family = if (target.isTrait) "implements" else "extends"
          edges.add(edge(symbolKey(symbol), target, family, parent, "semanticdb"))
        }
      })

    private def call(target: Symbol, tree: Tree): Unit = {
      if (!usable(target, tree)) return
      edges.add(edge(owner, target, "calls", tree, "typed-plugin"))
      edges.add(edge(owner, target, "references", tree, "semanticdb"))
      if (target.isMethod && !target.isFinal && !target.owner.isFinal) {
        unresolved.add(new UnresolvedSite(
          "dispatches", "dynamic", position(tree), Collections.singletonList(symbolKey(target))))
      }
      if (target.isMacro) {
        unresolved.add(new UnresolvedSite(
          "calls", "macro-or-generated", position(tree), Collections.singletonList(symbolKey(target))))
      }
    }

    private def instantiate(target: Symbol, tree: Tree): Unit =
      if (usable(target, tree)) edges.add(edge(owner, target, "instantiates", tree, "typed-plugin"))

    private def reference(target: Symbol, access: String, tree: Tree): Unit = {
      if (!usable(target, tree) || target.isPackage) return
      edges.add(new GraphEdge(
        owner,
        symbolKey(target),
        "accesses",
        access,
        "typed-plugin",
        kind(target),
        target.name.decodedName.toString.trim,
        qualified(target),
        position(tree)))
      if (target.isImplicit) {
        unresolved.add(new UnresolvedSite(
          "references", "macro-or-generated", position(tree), Collections.singletonList(symbolKey(target))))
      }
    }

    private def typeReference(symbol: Symbol, tree: Tree): Unit = {
      if (symbol == null || symbol == NoSymbol || symbol.info == null) return
      val target = symbol.info.finalResultType.typeSymbol
      if (target != null && target != NoSymbol && target != symbol) {
        edges.add(edge(symbolKey(symbol), target, "type_ref", tree, "semanticdb"))
      }
    }

    private def addEdge(from: String, target: Symbol, family: String, tree: Tree, provenance: String): Unit =
      edges.add(edge(from, target, family, tree, provenance))

    private def edge(from: String, target: Symbol, family: String, tree: Tree, provenance: String) =
      new GraphEdge(
        from,
        symbolKey(target),
        family,
        null,
        provenance,
        kind(target),
        target.name.decodedName.toString.trim,
        qualified(target),
        position(tree))

    private def usable(symbol: Symbol, tree: Tree): Boolean =
      symbol != null && symbol != NoSymbol && tree.pos != null && tree.pos.isDefined

    private def symbolKey(symbol: Symbol): String =
      // A package declaration is source syntax repeated in every compilation
      // unit, unlike the single package symbol the compiler interns globally.
      if (symbol.isPackage) s"scala-package $source|${symbol.fullName}"
      else s"scala-structural ${ownerIdentity(symbol.owner)}|${kind(symbol)}|${symbol.name.decodedName}|${signature(symbol)}${lexical(symbol)}"

    private def ownerIdentity(symbol: Symbol): String =
      if (symbol == null || symbol == NoSymbol) ""
      else if (symbol.isPackage) symbol.fullName
      else s"${ownerIdentity(symbol.owner)}|${kind(symbol)}|${symbol.name.decodedName}|${signature(symbol)}${lexical(symbol)}"

    private def lexical(symbol: Symbol): String =
      if (symbol.owner != null && symbol.owner != NoSymbol && symbol.owner.isMethod &&
          !symbol.isParameter && symbol.pos != null && symbol.pos.isDefined)
        s"|lexical=${symbol.pos.point}"
      else ""

    private def signature(symbol: Symbol): String =
      if (symbol.info == null) ""
      else if (symbol.isClass) symbol.typeParams.map(_.name.decodedName.toString).mkString("[", ",", "]")
      else symbol.info.dealias.toString.replaceAll("\\s+", " ").trim

    private def qualified(symbol: Symbol): String =
      try symbol.fullName catch { case _: Throwable => symbol.name.decodedName.toString }

    private def kind(symbol: Symbol): String =
      if (symbol.isPackage) "package"
      else if (symbol.isModule || symbol.isModuleClass) "module"
      else if (symbol.isTrait) "interface"
      else if (symbol.isClass) "class"
      else if (symbol.isConstructor) "constructor"
      else if (symbol.isMethod) "method"
      else if (symbol.isType) "type"
      else if (symbol.isParameter) "parameter"
      else if (symbol.owner != null && symbol.owner.isClass) "field"
      else "variable"

    private def position(tree: Tree): Evidence = {
      val pos = tree.pos
      val end = if (pos.isRange) pos.end else pos.point + math.max(1, tree.toString.length)
      val endPosition =
        if (unit.source.length == 0) pos
        else unit.source.position(math.max(0, math.min(end, unit.source.length - 1)))
      new Evidence(
        source,
        math.max(1, pos.line),
        math.max(1, pos.column + 1),
        math.max(1, endPosition.line),
        math.max(1, endPosition.column + 1))
    }
  }

  private implicit final class JavaListOps[A](private val values: List[A]) {
    def asJava: JList[A] = {
      val out = new ArrayList[A](values.size)
      values.foreach(out.add)
      out
    }
  }
}
