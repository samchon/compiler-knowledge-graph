export interface ICppGraphSnapshot {
  protocolVersion: number;
  schemaVersion: number;
  producer: ICppGraphSnapshot.IProducer;
  universe: ICppGraphSnapshot.IUniverse;
  sequence: number;
  generation: string;
  baseGeneration: string | null;
  upserts: ICppGraphSnapshot.IShard[];
  deletes: string[];
  manifest: ICppGraphSnapshot.IManifestEntry[];
  page: ICppGraphSnapshot.IPage;
  phases: ICppGraphSnapshot.IPhases;
}

export namespace ICppGraphSnapshot {
  export interface IProducer {
    name: string;
    version: string;
    commit: string;
  }

  export interface IUniverse {
    digest: string;
    targets: string[];
    workspaceRoots: string[];
    toolchains: string[];
    configurations: string[];
  }

  export interface IManifestEntry {
    key: string;
    digest: string;
  }

  export interface IPage {
    offset: number;
    count: number;
    total: number;
    nextCursor: string | null;
  }

  export interface IPhases {
    validationMillis: number;
    semanticMillis: number;
    shardMillis: number;
    encodeMillis: number;
    totalMillis: number;
    cacheHit: boolean;
  }

  export interface IShard {
    key: string;
    source: string;
    configuration: string;
    checkerDigest: string;
    interfaceFingerprint: string;
    digest: string;

    /**
     * The body's own content digest, and where the producer published it.
     *
     * A body is the largest thing this route moves and the only part that is
     * wanted whole, so the producer writes it once and the page names it. The
     * name is the digest of the bytes, which is why a header two hundred
     * translation units include resolves to one file: the second unit to see
     * it writes the same name with the same content and the write is a no-op.
     *
     * `graph` is carried inline instead when the producer had nowhere to
     * publish -- a project with no cache directory -- so a generation is
     * readable either way. Exactly one of the two is present.
     */
    bodyDigest: string;
    graphPath?: string;
    graph: ITU;
    coverage: Array<{
      family: string;
      state: string;
    }>;
  }

  export interface ITU {
    producerFingerprint: string;
    mainFileUri: string;
    mainFile: string;
    directory: string;
    commandLine: string[];
    output: string;
    commandDigest: string;
    toolchainFingerprint: string;
    targetTriple: string;
    language: string;
    hadErrors: boolean;
    sources: ISource[];
    symbols: ISymbol[];
    occurrences: IOccurrence[];
    relations: IRelation[];
    macros: IMacro[];
    includes: IInclude[];
    missingIncludes: IMissingInclude[];
    modules: IModule[];
    diagnostics: IDiagnostic[];
  }

  export interface IRange {
    file: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }

  export interface ISource {
    uri: string;
    digest: string;
    diskDigest: string;
    flags: number;
  }

  export interface ISymbol {
    usr: string;
    id: string;
    name: string;
    qualifiedName: string;
    ownerUsr: string;
    signature: string;
    kind: number;
    subKind: number;
    properties: number;
    local: boolean;
    internal: boolean;
    anonymous: boolean;
    exported: boolean;
    declaration: IRange;
    definition: IRange;
    attributes: Array<{
      name: string;
      range: IRange;
    }>;
  }

  export interface IOccurrence {
    usr: string;
    id: string;
    containerId: string;
    roles: number;
    targetKind: number;
    spelling: IRange;
    expansion: IRange;
  }

  export interface IRelation {
    subjectId: string;
    objectId: string;
    roles: number;
    evidence: IRange;
  }

  export interface IMacro {
    usr: string;
    id: string;
    name: string;
    roles: number;
    definition: IRange;
    spelling: IRange;
    expansion: IRange;
  }

  export interface IInclude {
    source: string;
    target: string;
    spelling: string;
    angled: boolean;
    moduleImported: boolean;
    evidence: IRange;
  }

  export interface IMissingInclude {
    source: string;
    spelling: string;
    angled: boolean;
  }

  export interface IModule {
    name: string;
    roles: number;
    evidence: IRange;
  }

  export interface IDiagnostic {
    message: string;
    code: string;
    severity: string;
    range: IRange;
  }
}
