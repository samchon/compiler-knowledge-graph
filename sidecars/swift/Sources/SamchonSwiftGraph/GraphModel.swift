import Foundation

struct GraphArtifact: Codable {
  let schemaVersion: Int
  let projectRoot: String
  let producer: Producer
  let targets: [TargetArtifact]
}

struct Producer: Codable {
  let name: String
  let version: String
  let protocolVersion: Int
  let capabilities: Capabilities
}

struct Capabilities: Codable {
  let atomicGenerations: Bool
  let incremental: Bool
  let diagnostics: Bool
  let explicitOutputUnits: Bool
  let indexStoreDB: Bool
  let sourceEnrichment: Bool
  let swiftpm: Bool
  let sourceKitResident: Bool
}

struct TargetArtifact: Codable {
  let name: String
  let generation: String
  let universe: String
  let moduleName: String
  let targetTriple: String
  let sdk: String
  let configuration: String
  let swiftLanguageVersion: String
  let compilerFlagsDigest: String
  let moduleDependenciesDigest: String
  let packageResolutionDigest: String
  let pluginsDigest: String
  let generatedSourcesDigest: String
  let indexStoreDBCommit: String
  let outputUnits: [OutputUnit]
  let coverage: [String: String]
  let shards: [SourceShard]
}

struct OutputUnit: Codable, Equatable {
  let path: String
  let digest: String
}

struct SourceShard: Codable {
  let schemaVersion: Int
  let language: String
  let source: String
  let checkerDigest: String
  let diskDigest: String
  let target: String
  let compilerVersion: String
  let moduleName: String
  let targetTriple: String
  let sourceEnrichmentPasses: Int
  let nodes: [GraphNode]
  let edges: [GraphEdge]
  let unresolved: [UnresolvedSite]
  let diagnostics: [DiagnosticFact]
}

struct Evidence: Codable, Hashable {
  let file: String
  let startLine: Int
  let startColumn: Int
  let endLine: Int
  let endColumn: Int
}

struct GraphNode: Codable {
  let symbol: String
  let kind: String
  let name: String
  let qualifiedName: String
  let file: String
  let exported: Bool
  let modifiers: [String]
  let signature: String
  let origin: String
  let evidence: Evidence
}

struct GraphEdge: Codable {
  let from: String
  let to: String
  let kind: String
  let access: String?
  let provenance: String?
  let targetKind: String?
  let targetName: String?
  let targetQualifiedName: String?
  let evidence: Evidence
}

struct UnresolvedSite: Codable {
  let family: String
  let reason: String
  let evidence: Evidence
  let candidates: [String]
}

struct DiagnosticFact: Codable {
  let severity: String
  let message: String
  let evidence: Evidence
}
