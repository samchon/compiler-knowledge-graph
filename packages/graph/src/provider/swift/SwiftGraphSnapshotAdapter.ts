import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CompilerGraphSnapshotAdapter } from "../compiler/CompilerGraphSnapshotAdapter";
import { ISwiftGraphSnapshot } from "./ISwiftGraphSnapshot";
import { SWIFT_GRAPH_FACTS } from "./SWIFT_GRAPH_FACTS";
import { SWIFT_GRAPH_PRODUCER } from "./SWIFT_GRAPH_PRODUCER";
import { SWIFT_GRAPH_PROVIDER } from "./SWIFT_GRAPH_PROVIDER";

const SHA256 = /^[0-9a-f]{64}$/u;

/** Validate and adapt one explicit set of Swift compiler output units. */
export class SwiftGraphSnapshotAdapter extends CompilerGraphSnapshotAdapter {
  public constructor(root: string) {
    super(root, {
      label: "Swift graph",
      language: "swift",
      provider: SWIFT_GRAPH_PROVIDER,
      producer: SWIFT_GRAPH_PRODUCER,
      facts: SWIFT_GRAPH_FACTS,
      capabilities: [
        "explicitOutputUnits",
        "indexStoreDB",
        "sourceEnrichment",
        "swiftpm",
      ],
      diagnosticCode: "swiftc",
      shardKeyPrefix: "swift",
      schemaVersion: ISwiftGraphSnapshot.SCHEMA_VERSION,
      protocolVersion: ISwiftGraphSnapshot.PROTOCOL_VERSION,
      identitySalt: (rawTarget) => {
        const target = rawTarget as unknown as ISwiftGraphSnapshot.ITarget;
        return `${target.moduleName}\0${target.targetTriple}\0${target.configuration}`;
      },
      validateSnapshot: (raw) => {
        const snapshot = raw as unknown as ISwiftGraphSnapshot;
        const capabilities = snapshot.producer.capabilities;
        if (
          capabilities.explicitOutputUnits !== true ||
          capabilities.indexStoreDB !== true ||
          capabilities.sourceEnrichment !== true ||
          capabilities.swiftpm !== true ||
          capabilities.sourceKitResident !== false
        ) {
          throw new Error(
            "Swift graph: the standalone producer must prove explicit IndexStoreDB output units, one source enrichment lane and SwiftPM ownership without claiming SourceKit residency",
          );
        }
      },
      validateTarget: (raw) => {
        const target = raw as unknown as ISwiftGraphSnapshot.ITarget;
        if (
          target.moduleName === "" ||
          target.targetTriple === "" ||
          target.configuration === "" ||
          target.swiftLanguageVersion === "" ||
          target.name !== targetIdentity(target) ||
          target.indexStoreDBCommit !==
            ISwiftGraphSnapshot.INDEX_STORE_DB_COMMIT ||
          ![
            target.compilerFlagsDigest,
            target.moduleDependenciesDigest,
            target.packageResolutionDigest,
            target.pluginsDigest,
            target.generatedSourcesDigest,
          ].every((value) => SHA256.test(value)) ||
          !outputUnits(target.outputUnits, root)
        ) {
          throw new Error(`Swift graph: malformed build target ${target.name}`);
        }
      },
      validateShard: (raw, rawTarget) => {
        const shard = raw as unknown as ISwiftGraphSnapshot.IShard;
        const target = rawTarget as unknown as ISwiftGraphSnapshot.ITarget;
        if (
          shard.moduleName !== target.moduleName ||
          shard.targetTriple !== target.targetTriple ||
          shard.sourceEnrichmentPasses !== 1
        ) {
          throw new Error(
            `Swift graph: malformed source enrichment in ${shard.source}`,
          );
        }
      },
    });
  }
}

function targetIdentity(target: ISwiftGraphSnapshot.ITarget): string {
  return `${target.moduleName}@${target.targetTriple}/${target.configuration}`;
}

function outputUnits(
  units: readonly ISwiftGraphSnapshot.IOutputUnit[],
  root: string,
): boolean {
  if (units.length === 0) return false;
  let previous: string | undefined;
  for (const unit of units) {
    if (
      unit.path === "" ||
      path.isAbsolute(unit.path) ||
      !SHA256.test(unit.digest) ||
      (previous !== undefined && previous >= unit.path)
    ) {
      return false;
    }
    const resolved = path.resolve(root, unit.path);
    if (!confined(root, resolved)) return false;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(resolved);
    } catch {
      return false;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== unit.digest) {
      return false;
    }
    previous = unit.path;
  }
  return true;
}

function confined(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}
