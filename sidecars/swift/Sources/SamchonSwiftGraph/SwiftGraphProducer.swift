import Foundation
import IndexStoreDB

private let indexStoreDBCommit = "f4d7f08f6a078050d86aed10a06bf1fc871a8ded"
private let factFamilies = [
  "contains", "exports", "imports", "calls", "accesses", "instantiates",
  "type_ref", "extends", "implements", "overrides", "dispatches", "decorates",
  "renders", "tests", "references",
]

struct SwiftGraphProducer {
  let root: URL

  static func supports(root: URL) -> Bool {
    guard FileManager.default.fileExists(atPath: root.appendingPathComponent("Package.swift").path) else {
      return false
    }
    return (try? toolchain()) != nil
  }

  func write(to output: URL) throws {
    let artifact = try snapshot()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    var data = try encoder.encode(artifact)
    data.append(0x0a)
    try FileManager.default.createDirectory(
      at: output.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try data.write(to: output, options: .atomic)
  }

  func snapshot() throws -> GraphArtifact {
    let build = try run(
      [
        "swift", "build", "--enable-index-store", "--configuration", "debug",
        "--build-tests",
        "-Xswiftc", "-index-include-locals",
      ],
      cwd: root
    )
    guard build.status == 0 else {
      throw ProducerError.message("swift build failed:\n\(build.output)")
    }
    let bin = try successful(["swift", "build", "--show-bin-path"], cwd: root)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let binURL = URL(fileURLWithPath: bin).standardizedFileURL
    let store = binURL.appendingPathComponent("index/store", isDirectory: true)
    guard FileManager.default.fileExists(atPath: store.path) else {
      throw ProducerError.message("swift build produced no index store at \(store.path)")
    }
    let toolchain = try Self.toolchain()
    let buildDescription = binURL.appendingPathComponent("description.json")
    let buildDescriptionData = try Data(contentsOf: buildDescription)
    let plan = try buildPlan(from: buildDescriptionData)
    let sources = plan.sources
    let outputUnits = plan.outputUnits
    guard !sources.isEmpty else { throw ProducerError.message("the build plan has no project Swift sources") }
    guard !outputUnits.isEmpty else {
      throw ProducerError.message("swift build produced no object output units beneath \(binURL.path)")
    }
    let packageDump = try successful(["swift", "package", "dump-package"], cwd: root)
    let buildBefore = try buildIdentity(
      descriptionDigest: SHA256.hash(buildDescriptionData),
      packageDump: packageDump,
      targetTriple: toolchain.targetTriple
    )
    let enrichments = try Dictionary(uniqueKeysWithValues: sources.map { source in
      let relative = relativePath(source)
      return (relative, try SourceEnrichment(url: source, relativePath: relative))
    })
    let diagnostics = diagnosticsBySource(build.output, sources: Set(enrichments.keys))

    let queried = try query(
      store: store,
      library: toolchain.library,
      outputUnits: outputUnits,
      sources: sources,
      enrichments: enrichments,
      diagnostics: diagnostics,
      compilerVersion: toolchain.compilerVersion,
      targetTriple: toolchain.targetTriple
    )
    try fence(
      outputUnits: outputUnits,
      enrichments: enrichments,
      buildDescription: buildDescription,
      buildIdentity: buildBefore,
      targetTriple: toolchain.targetTriple
    )

    let encodedUnits = outputUnits.map {
      OutputUnit(path: relativePath($0.url), digest: $0.digest)
    }.sorted { $0.path < $1.path }
    let coverage = Dictionary(uniqueKeysWithValues: factFamilies.map {
      ($0, $0 == "renders" ? "unsupported" : "partial")
    })
    let modules = Set(queried.map(\.moduleName)).sorted()
    let targets = try modules.map { module -> TargetArtifact in
      let name = "\(module)@\(toolchain.targetTriple)/debug"
      let shards = queried.filter { $0.moduleName == module }.map { value in
        SourceShard(
          schemaVersion: 1,
          language: "swift",
          source: value.source,
          checkerDigest: value.checkerDigest,
          diskDigest: value.checkerDigest,
          target: name,
          compilerVersion: toolchain.compilerVersion,
          moduleName: module,
          targetTriple: toolchain.targetTriple,
          sourceEnrichmentPasses: 1,
          nodes: value.nodes,
          edges: value.edges,
          unresolved: value.unresolved,
          diagnostics: value.diagnostics
        )
      }.sorted { $0.source < $1.source }
      let universeSeed = [
        module, toolchain.targetTriple, toolchain.sdk, "debug",
        toolchain.compilerVersion, buildBefore.compilerFlagsDigest,
        buildBefore.moduleDependenciesDigest,
        buildBefore.packageResolutionDigest, buildBefore.pluginsDigest,
        buildBefore.generatedSourcesDigest,
        indexStoreDBCommit,
        encodedUnits.map { "\($0.path)=\($0.digest)" }.joined(separator: "\n"),
      ].joined(separator: "\0")
      let universe = SHA256.hash(universeSeed)
      let shardData = try JSONEncoder.sorted.encode(shards)
      let generation = SHA256.hash(Data(universe.utf8) + shardData)
      return TargetArtifact(
        name: name,
        generation: generation,
        universe: universe,
        moduleName: module,
        targetTriple: toolchain.targetTriple,
        sdk: toolchain.sdk,
        configuration: "debug",
        swiftLanguageVersion: toolchain.compilerVersion,
        compilerFlagsDigest: buildBefore.compilerFlagsDigest,
        moduleDependenciesDigest: buildBefore.moduleDependenciesDigest,
        packageResolutionDigest: buildBefore.packageResolutionDigest,
        pluginsDigest: buildBefore.pluginsDigest,
        generatedSourcesDigest: buildBefore.generatedSourcesDigest,
        indexStoreDBCommit: indexStoreDBCommit,
        outputUnits: encodedUnits,
        coverage: coverage,
        shards: shards
      )
    }
    guard !targets.isEmpty else {
      throw ProducerError.message("IndexStoreDB returned no Swift modules from the explicit output units")
    }
    return GraphArtifact(
      schemaVersion: 1,
      projectRoot: root.path,
      producer: Producer(
        name: "samchon-swift-graph",
        version: "0.1.0",
        protocolVersion: 1,
        capabilities: Capabilities(
          atomicGenerations: true,
          incremental: true,
          diagnostics: true,
          explicitOutputUnits: true,
          indexStoreDB: true,
          sourceEnrichment: true,
          swiftpm: true,
          sourceKitResident: false
        )
      ),
      targets: targets
    )
  }

  private func query(
    store: URL,
    library: URL,
    outputUnits: [UnitFile],
    sources: [URL],
    enrichments: [String: SourceEnrichment],
    diagnostics: [String: [DiagnosticFact]],
    compilerVersion: String,
    targetTriple: String
  ) throws -> [QueriedShard] {
    let database = root.appendingPathComponent(
      ".build/samchon-graph/indexstoredb-\(UUID().uuidString)",
      isDirectory: true
    )
    try FileManager.default.createDirectory(
      at: database.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    defer { try? FileManager.default.removeItem(at: database) }
    return try { () throws -> [QueriedShard] in
      let indexLibrary = try IndexStoreLibrary(dylibPath: library.path)
      let databaseView = try IndexStoreDB(
        storePath: store.path,
        databasePath: database.path,
        library: indexLibrary,
        useExplicitOutputUnits: true,
        waitUntilDoneInitializing: true,
        readonly: false,
        enableOutOfDateFileWatching: false,
        listenToUnitEvents: false
      )
      databaseView.addUnitOutFilePaths(outputUnits.map(\.url.path), waitForProcessing: true)

      var symbols = Set<String>()
      for source in sources {
        for symbol in databaseView.symbols(inFilePath: source.path) { symbols.insert(symbol.usr) }
      }
      var occurrences: [SymbolOccurrence] = []
      var occurrenceKeys = Set<String>()
      for usr in symbols.sorted() {
        for occurrence in databaseView.occurrences(ofUSR: usr, roles: .all) {
          guard confined(occurrence.location.path), occurrence.location.path.hasSuffix(".swift") else { continue }
          let key = [
            occurrence.symbol.usr, occurrence.location.path,
            String(occurrence.location.line), String(occurrence.location.utf8Column),
            String(occurrence.roles.rawValue),
          ].joined(separator: "\0")
          if occurrenceKeys.insert(key).inserted { occurrences.append(occurrence) }
        }
      }
      occurrences.sort()
      return buildShards(
        occurrences: occurrences,
        enrichments: enrichments,
        diagnostics: diagnostics,
        compilerVersion: compilerVersion,
        targetTriple: targetTriple
      )
    }()
  }

  private func buildShards(
    occurrences: [SymbolOccurrence],
    enrichments: [String: SourceEnrichment],
    diagnostics: [String: [DiagnosticFact]],
    compilerVersion: String,
    targetTriple: String
  ) -> [QueriedShard] {
    var sourceModules: [String: String] = [:]
    for occurrence in occurrences {
      let source = relativePath(URL(fileURLWithPath: occurrence.location.path))
      guard enrichments[source] != nil else { continue }
      if !occurrence.location.moduleName.isEmpty { sourceModules[source] = occurrence.location.moduleName }
    }
    for source in enrichments.keys where sourceModules[source] == nil {
      sourceModules[source] = inferredModule(source)
    }

    let declarationOccurrences = occurrences.filter {
      !$0.roles.intersection([.declaration, .definition]).isEmpty
    }
    var declarations: [String: Declaration] = [:]
    for occurrence in declarationOccurrences {
      let source = relativePath(URL(fileURLWithPath: occurrence.location.path))
      guard let enrichment = enrichments[source], declarations[occurrence.symbol.usr] == nil else { continue }
      let module = sourceModules[source] ?? inferredModule(source)
      let parent = occurrence.relations.first {
        !$0.roles.intersection([.childOf, .containedBy, .accessorOf]).isEmpty
      }?.symbol
      let qualified = [module, parent?.name, occurrence.symbol.name]
        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ".")
      let node = GraphNode(
        symbol: occurrence.symbol.usr,
        kind: graphKind(occurrence.symbol.kind),
        name: occurrence.symbol.name,
        qualifiedName: qualified,
        file: source,
        exported: enrichment.isExported(line: occurrence.location.line),
        modifiers: enrichment.modifiers(
          line: occurrence.location.line,
          properties: occurrence.symbol.properties.rawValue
        ),
        signature: enrichment.signature(line: occurrence.location.line),
        origin: "IndexStoreDB+source-enrichment",
        evidence: enrichment.evidence(
          line: occurrence.location.line,
          utf8Column: occurrence.location.utf8Column,
          name: occurrence.symbol.name
        )
      )
      declarations[occurrence.symbol.usr] = Declaration(
        node: node,
        module: module,
        staticallyClosed: enrichment.isStaticallyClosed(line: occurrence.location.line),
        unitTest: occurrence.symbol.properties.contains(.unitTest)
      )
    }

    var nodes: [String: [GraphNode]] = [:]
    var edges: [String: [GraphEdge]] = [:]
    var unresolved: [String: [UnresolvedSite]] = [:]
    for declaration in declarations.values {
      nodes[declaration.node.file, default: []].append(declaration.node)
    }
    for occurrence in occurrences {
      let source = relativePath(URL(fileURLWithPath: occurrence.location.path))
      guard let enrichment = enrichments[source] else { continue }
      let evidence = enrichment.evidence(
        line: occurrence.location.line,
        utf8Column: occurrence.location.utf8Column,
        name: occurrence.symbol.name
      )
      let owner = occurrence.relations.first {
        !$0.roles.intersection([.calledBy, .containedBy]).isEmpty
      }?.symbol.usr ?? source
      if !occurrence.roles.intersection([.declaration, .definition]).isEmpty,
         let declaration = declarations[occurrence.symbol.usr] {
        let parent = occurrence.relations.first {
          !$0.roles.intersection([.childOf, .containedBy, .accessorOf]).isEmpty
        }?.symbol.usr ?? source
        append(edge(
          from: parent, to: occurrence.symbol, kind: "contains",
          evidence: evidence, provenance: "IndexStoreDB"
        ), to: &edges[source, default: []])
        if declaration.node.exported {
          append(edge(
            from: source, to: occurrence.symbol, kind: "exports",
            evidence: evidence, provenance: "source-enrichment"
          ), to: &edges[source, default: []])
        }
        for attribute in enrichment.attributes(at: occurrence.location.line) {
          append(GraphEdge(
            from: occurrence.symbol.usr,
            to: "swift-attribute:\(attribute.name)",
            kind: "decorates",
            access: nil,
            provenance: "source-enrichment",
            targetKind: "type",
            targetName: attribute.name,
            targetQualifiedName: attribute.name,
            evidence: attribute.evidence
          ), to: &edges[source, default: []])
        }
      }
      if occurrence.roles.contains(.reference) {
        append(edge(
          from: owner, to: occurrence.symbol, kind: "references",
          evidence: evidence, provenance: "IndexStoreDB"
        ), to: &edges[source, default: []])
      }
      if !occurrence.roles.intersection([.read, .write]).isEmpty {
        let access = occurrence.roles.contains(.read) && occurrence.roles.contains(.write)
          ? "read-write" : (occurrence.roles.contains(.write) ? "write" : "read")
        append(edge(
          from: owner, to: occurrence.symbol, kind: "accesses",
          evidence: evidence, access: access, provenance: "IndexStoreDB"
        ), to: &edges[source, default: []])
      }
      if occurrence.roles.contains(.call) {
        append(edge(
          from: owner, to: occurrence.symbol, kind: "calls",
          evidence: evidence, provenance: "IndexStoreDB"
        ), to: &edges[source, default: []])
        if occurrence.symbol.kind == .constructor {
          append(edge(
            from: owner, to: occurrence.symbol, kind: "instantiates",
            evidence: evidence, provenance: "IndexStoreDB"
          ), to: &edges[source, default: []])
        }
        if declarations[owner]?.unitTest == true {
          append(edge(
            from: owner, to: occurrence.symbol, kind: "tests",
            evidence: evidence, provenance: "IndexStoreDB-call-graph"
          ), to: &edges[source, default: []])
        }
        if occurrence.roles.contains(.dynamic) {
          unresolved[source, default: []].append(UnresolvedSite(
            family: "dispatches",
            reason: "dynamic",
            evidence: evidence,
            candidates: occurrence.relations.map(\.symbol.usr).sorted()
          ))
        } else if declarations[occurrence.symbol.usr]?.staticallyClosed == true {
          append(edge(
            from: owner, to: occurrence.symbol, kind: "dispatches",
            evidence: evidence, provenance: "IndexStoreDB+source-enrichment"
          ), to: &edges[source, default: []])
        }
      }
      if typeKind(occurrence.symbol.kind) && occurrence.roles.contains(.reference) {
        append(edge(
          from: owner, to: occurrence.symbol, kind: "type_ref",
          evidence: evidence, provenance: "IndexStoreDB"
        ), to: &edges[source, default: []])
      }
      for relation in occurrence.relations {
        if relation.roles.contains(.overrideOf) {
          append(edge(
            from: occurrence.symbol.usr, to: relation.symbol, kind: "overrides",
            evidence: evidence, provenance: "IndexStoreDB"
          ), to: &edges[source, default: []])
        }
        if relation.roles.contains(.baseOf) {
          let kind = occurrence.symbol.kind == .protocol ? "implements" : "extends"
          append(edge(
            from: relation.symbol.usr, to: occurrence.symbol, kind: kind,
            evidence: evidence, provenance: "IndexStoreDB"
          ), to: &edges[source, default: []])
        }
      }
    }
    for (source, enrichment) in enrichments {
      for imported in enrichment.imports() {
        append(GraphEdge(
          from: source,
          to: "swift-module:\(imported.module)",
          kind: "imports",
          access: nil,
          provenance: "source-enrichment",
          targetKind: "module",
          targetName: imported.module,
          targetQualifiedName: imported.module,
          evidence: imported.evidence
        ), to: &edges[source, default: []])
      }
      unresolved[source, default: []].append(contentsOf: enrichment.unresolvedSyntax())
    }
    return enrichments.keys.sorted().map { source in
      let module = sourceModules[source] ?? inferredModule(source)
      return QueriedShard(
        source: source,
        moduleName: module,
        checkerDigest: enrichments[source]!.digest,
        nodes: (nodes[source] ?? []).sorted { $0.symbol < $1.symbol },
        edges: (edges[source] ?? []).sorted(by: edgeOrder),
        unresolved: (unresolved[source] ?? []).sorted(by: unresolvedOrder),
        diagnostics: diagnostics[source] ?? []
      )
    }
  }

  private func fence(
    outputUnits: [UnitFile],
    enrichments: [String: SourceEnrichment],
    buildDescription: URL,
    buildIdentity: BuildIdentity,
    targetTriple: String
  ) throws {
    for unit in outputUnits where try digest(unit.url) != unit.digest {
      throw ProducerError.message("an explicit output unit moved while the generation was queried")
    }
    for (source, enrichment) in enrichments {
      let current = try Data(contentsOf: root.appendingPathComponent(source))
      if SHA256.hash(current) != enrichment.digest {
        throw ProducerError.message("\(source) moved while the generation was queried")
      }
    }
    let packageDump = try successful(["swift", "package", "dump-package"], cwd: root)
    if try self.buildIdentity(
      descriptionDigest: SHA256.hash(try Data(contentsOf: buildDescription)),
      packageDump: packageDump,
      targetTriple: targetTriple
    ) != buildIdentity {
      throw ProducerError.message("SwiftPM build settings moved while the generation was queried")
    }
  }

  private func buildIdentity(
    descriptionDigest: String,
    packageDump: String,
    targetTriple: String
  ) throws -> BuildIdentity {
    let packageResolutionDigest = try digestFile("Package.resolved")
    return BuildIdentity(
      compilerFlagsDigest: SHA256.hash(
        targetTriple + "\0debug\0" + descriptionDigest + "\0" +
          (try digestFile("Package.swift")) + "\0-index-include-locals"
      ),
      moduleDependenciesDigest: SHA256.hash(packageDump + "\0" + packageResolutionDigest),
      packageResolutionDigest: packageResolutionDigest,
      pluginsDigest: try digestTree(root.appendingPathComponent(".build/plugins")),
      generatedSourcesDigest: try digestTree(root.appendingPathComponent(".build/plugins/outputs"))
    )
  }

  private func buildPlan(from description: Data) throws -> BuildPlan {
    guard let document = try JSONSerialization.jsonObject(with: description) as? [String: Any],
          let commands = document["swiftCommands"] as? [String: Any],
          !commands.isEmpty else {
      throw ProducerError.message("SwiftPM build description has no Swift compiler commands")
    }
    var objectPaths = Set<String>()
    var sourcePaths = Set<String>()
    for (name, raw) in commands {
      guard let command = raw as? [String: Any],
            let objects = command["objects"] as? [String],
            let sources = command["sources"] as? [String],
            !objects.isEmpty, !sources.isEmpty else {
        throw ProducerError.message("SwiftPM compiler command \(name) has no sources or object outputs")
      }
      objectPaths.formUnion(objects)
      sourcePaths.formUnion(sources)
    }
    let units = try objectPaths.sorted().map { path in
      let file = absoluteBuildPath(path)
      guard file.pathExtension == "o", confined(file.path),
            try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
        throw ProducerError.message("SwiftPM named an invalid output unit at \(file.path)")
      }
      return UnitFile(url: file, digest: try digest(file))
    }
    let sources = try sourcePaths.sorted().compactMap { path -> URL? in
      let file = absoluteBuildPath(path)
      guard file.pathExtension == "swift", confined(file.path) else { return nil }
      let relative = relativePath(file)
      guard !relative.hasPrefix(".build/checkouts/"),
            !relative.hasPrefix(".build/repositories/"),
            !relative.hasPrefix(".build/artifacts/") else { return nil }
      guard try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
        throw ProducerError.message("SwiftPM named a missing project source at \(file.path)")
      }
      return file
    }
    return BuildPlan(outputUnits: units, sources: sources)
  }

  private func digestFile(_ relative: String) throws -> String {
    let file = root.appendingPathComponent(relative)
    return FileManager.default.fileExists(atPath: file.path)
      ? try digest(file)
      : SHA256.hash("absent:\(relative)")
  }

  private func digestTree(_ directory: URL) throws -> String {
    guard FileManager.default.fileExists(atPath: directory.path),
          let enumerator = FileManager.default.enumerator(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
          ) else { return SHA256.hash("absent:\(directory.lastPathComponent)") }
    var rows: [String] = []
    for case let file as URL in enumerator {
      if (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
        rows.append("\(file.path.replacingOccurrences(of: directory.path, with: ""))=\(try digest(file))")
      }
    }
    return SHA256.hash(rows.sorted().joined(separator: "\n"))
  }

  private func relativePath(_ file: URL) -> String {
    String(file.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count))
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      .replacingOccurrences(of: "\\", with: "/")
  }

  private func absoluteBuildPath(_ path: String) -> URL {
    path.hasPrefix("/")
      ? URL(fileURLWithPath: path).standardizedFileURL
      : root.appendingPathComponent(path).standardizedFileURL
  }

  private func confined(_ file: String) -> Bool {
    let base = root.standardizedFileURL.path
    let candidate = URL(fileURLWithPath: file).standardizedFileURL.path
    return candidate.hasPrefix(base + "/")
  }

  private func inferredModule(_ source: String) -> String {
    let parts = source.split(separator: "/").map(String.init)
    if let marker = parts.firstIndex(where: { $0 == "Sources" || $0 == "Tests" }),
       parts.indices.contains(marker + 1) {
      return parts[marker + 1]
    }
    return root.lastPathComponent.replacingOccurrences(of: "-", with: "_")
  }

  private static func toolchain() throws -> Toolchain {
    let targetOutput = try successful(["swiftc", "-print-target-info"], cwd: nil)
    guard let json = try JSONSerialization.jsonObject(with: Data(targetOutput.utf8)) as? [String: Any],
          let target = json["target"] as? [String: Any],
          let triple = target["triple"] as? String,
          let compilerVersion = json["compilerVersion"] as? String,
          let paths = json["paths"] as? [String: Any] else {
      throw ProducerError.message("swiftc -print-target-info returned an unknown shape")
    }
    let runtimePaths = paths["runtimeLibraryPaths"] as? [String] ?? []
    let sdk = paths["sdkPath"] as? String ?? ""
    let swiftc = try successful(["which", "swiftc"], cwd: nil)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let resolved = URL(fileURLWithPath: swiftc).resolvingSymlinksInPath()
    #if os(macOS)
    let libraryName = "libIndexStore.dylib"
    #elseif os(Linux)
    let libraryName = "libIndexStore.so"
    #else
    throw ProducerError.message("samchon-swift-graph supports macOS and Linux only")
    #endif
    var candidates = [
      resolved.deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("lib/\(libraryName)"),
    ]
    for path in runtimePaths {
      let runtime = URL(fileURLWithPath: path)
      candidates.append(runtime.appendingPathComponent(libraryName))
      candidates.append(runtime.deletingLastPathComponent().appendingPathComponent(libraryName))
      candidates.append(runtime.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(libraryName))
    }
    guard let library = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
      throw ProducerError.message("the Swift toolchain has no loadable \(libraryName)")
    }
    _ = try IndexStoreLibrary(dylibPath: library.path)
    return Toolchain(
      compilerVersion: compilerVersion,
      targetTriple: triple,
      sdk: sdk,
      library: library
    )
  }
}

private struct Toolchain {
  let compilerVersion: String
  let targetTriple: String
  let sdk: String
  let library: URL
}

private struct UnitFile {
  let url: URL
  let digest: String
}

private struct BuildPlan {
  let outputUnits: [UnitFile]
  let sources: [URL]
}

private struct BuildIdentity: Equatable {
  let compilerFlagsDigest: String
  let moduleDependenciesDigest: String
  let packageResolutionDigest: String
  let pluginsDigest: String
  let generatedSourcesDigest: String
}

private struct Declaration {
  let node: GraphNode
  let module: String
  let staticallyClosed: Bool
  let unitTest: Bool
}

private struct QueriedShard {
  let source: String
  let moduleName: String
  let checkerDigest: String
  let nodes: [GraphNode]
  let edges: [GraphEdge]
  let unresolved: [UnresolvedSite]
  let diagnostics: [DiagnosticFact]
}

private struct ProcessResult {
  let status: Int32
  let output: String
}

private enum ProducerError: Error, CustomStringConvertible {
  case message(String)
  var description: String {
    switch self { case .message(let text): return text }
  }
}

private func run(_ arguments: [String], cwd: URL?) throws -> ProcessResult {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  process.arguments = arguments
  process.currentDirectoryURL = cwd
  let output = Pipe()
  process.standardOutput = output
  process.standardError = output
  try process.run()
  let data = output.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  return ProcessResult(status: process.terminationStatus, output: String(decoding: data, as: UTF8.self))
}

private func successful(_ arguments: [String], cwd: URL?) throws -> String {
  let result = try run(arguments, cwd: cwd)
  guard result.status == 0 else {
    throw ProducerError.message("\(arguments.joined(separator: " ")) failed:\n\(result.output)")
  }
  return result.output
}

private func digest(_ file: URL) throws -> String {
  SHA256.hash(try Data(contentsOf: file))
}

private func graphKind(_ kind: IndexSymbolKind) -> String {
  switch kind {
  case .module: return "module"
  case .namespace, .namespaceAlias: return "namespace"
  case .enum: return "enum"
  case .class: return "class"
  case .protocol: return "interface"
  case .struct, .extension, .union, .typealias, .concept, .macro: return "type"
  case .function, .conversionFunction, .destructor: return "function"
  case .variable: return "variable"
  case .field, .enumConstant: return "field"
  case .instanceMethod, .classMethod, .staticMethod: return "method"
  case .instanceProperty, .classProperty, .staticProperty: return "property"
  case .constructor: return "constructor"
  case .parameter: return "parameter"
  case .using, .commentTag, .unknown: return "type"
  }
}

private func typeKind(_ kind: IndexSymbolKind) -> Bool {
  switch kind {
  case .module, .namespace, .namespaceAlias, .enum, .struct, .class, .protocol,
       .extension, .union, .typealias, .concept:
    return true
  default:
    return false
  }
}

private func edge(
  from: String,
  to symbol: Symbol,
  kind: String,
  evidence: Evidence,
  access: String? = nil,
  provenance: String
) -> GraphEdge {
  GraphEdge(
    from: from,
    to: symbol.usr,
    kind: kind,
    access: access,
    provenance: provenance,
    targetKind: graphKind(symbol.kind),
    targetName: symbol.name,
    targetQualifiedName: symbol.name,
    evidence: evidence
  )
}

private func append(_ edge: GraphEdge, to edges: inout [GraphEdge]) {
  if !edges.contains(where: { $0.kind == edge.kind && $0.from == edge.from && $0.to == edge.to }) {
    edges.append(edge)
  }
}

private func edgeOrder(_ left: GraphEdge, _ right: GraphEdge) -> Bool {
  [left.kind, left.from, left.to, String(left.evidence.startLine), String(left.evidence.startColumn)]
    .joined(separator: "\0") <
  [right.kind, right.from, right.to, String(right.evidence.startLine), String(right.evidence.startColumn)]
    .joined(separator: "\0")
}

private func unresolvedOrder(_ left: UnresolvedSite, _ right: UnresolvedSite) -> Bool {
  [left.family, left.reason, String(left.evidence.startLine), String(left.evidence.startColumn)]
    .joined(separator: "\0") <
  [right.family, right.reason, String(right.evidence.startLine), String(right.evidence.startColumn)]
    .joined(separator: "\0")
}

private func diagnosticsBySource(_ output: String, sources: Set<String>) -> [String: [DiagnosticFact]] {
  let expression = try! NSRegularExpression(
    pattern: #"^(.+\.swift):(\d+):(\d+):\s*(warning|note):\s*(.+)$"#
  )
  var result: [String: [DiagnosticFact]] = [:]
  for line in output.split(separator: "\n").map(String.init) {
    let range = NSRange(line.startIndex..<line.endIndex, in: line)
    guard let match = expression.firstMatch(in: line, range: range),
          let fileRange = Range(match.range(at: 1), in: line),
          let severityRange = Range(match.range(at: 4), in: line),
          let messageRange = Range(match.range(at: 5), in: line),
          let rowRange = Range(match.range(at: 2), in: line),
          let columnRange = Range(match.range(at: 3), in: line),
          let row = Int(line[rowRange]), let column = Int(line[columnRange]) else { continue }
    let file = String(line[fileRange]).replacingOccurrences(of: "\\", with: "/")
    guard let source = sources.first(where: { file.hasSuffix($0) }) else { continue }
    result[source, default: []].append(DiagnosticFact(
      severity: String(line[severityRange]) == "warning" ? "warning" : "info",
      message: String(line[messageRange]),
      evidence: Evidence(
        file: source,
        startLine: row,
        startColumn: column,
        endLine: row,
        endColumn: column + 1
      )
    ))
  }
  return result
}

private extension JSONEncoder {
  static var sorted: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}
