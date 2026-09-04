import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CompilerGraphSnapshotAdapter } from "../compiler/CompilerGraphSnapshotAdapter";
import { IScalaGraphSnapshot } from "./IScalaGraphSnapshot";
import { SCALA_GRAPH_FACTS } from "./SCALA_GRAPH_FACTS";
import { SCALA_GRAPH_PRODUCER } from "./SCALA_GRAPH_PRODUCER";
import { SCALA_GRAPH_PROVIDER } from "./SCALA_GRAPH_PROVIDER";

const SHA256 = /^[0-9a-f]{64}$/u;
const MD5 = /^[0-9a-f]{32}$/u;

/** Validate and adapt one atomic set of BSP target generations. */
export class ScalaGraphSnapshotAdapter extends CompilerGraphSnapshotAdapter {
  public constructor(root: string) {
    super(root, {
      label: "Scala graph",
      language: "scala",
      provider: SCALA_GRAPH_PROVIDER,
      producer: SCALA_GRAPH_PRODUCER,
      facts: SCALA_GRAPH_FACTS,
      diagnosticCode: "scalac",
      shardKeyPrefix: "scala",
      schemaVersion: IScalaGraphSnapshot.SCHEMA_VERSION,
      protocolVersion: IScalaGraphSnapshot.PROTOCOL_VERSION,
      identitySalt: (rawTarget) => {
        const target = rawTarget as unknown as IScalaGraphSnapshot.ITarget;
        return `${target.scalaBinaryVersion}\0${target.sourceEncoding.toLowerCase()}`;
      },
      validateSnapshot: (raw) => {
        const snapshot = raw as unknown as IScalaGraphSnapshot;
        const capabilities = snapshot.producer.capabilities;
        if (
          capabilities.bsp !== true ||
          capabilities.semanticdb !== true ||
          capabilities.typedPlugins !== true ||
          capabilities.zinc !== true
        ) {
          throw new Error(
            "Scala graph: the producer does not prove BSP, SemanticDB, typed-plugin and Zinc ownership",
          );
        }
      },
      validateTarget: (raw) => {
        const target = raw as unknown as IScalaGraphSnapshot.ITarget;
        if (
          target.name !== target.bspUri ||
          !isUri(target.bspUri) ||
          !scalaVersion(target.scalaVersion) ||
          !scalaBinaryVersion(target.scalaVersion, target.scalaBinaryVersion) ||
          target.platform === "" ||
          !sourceEncoding(target.sourceEncoding) ||
          !SHA256.test(target.scalacOptionsDigest) ||
          !SHA256.test(target.classpathDigest) ||
          !SHA256.test(target.sourceRootsDigest) ||
          !SHA256.test(target.semanticdbOptionsDigest) ||
          !SHA256.test(target.compilerPluginsDigest) ||
          !SHA256.test(target.zincAnalysisDigest) ||
          !SHA256.test(target.generatedSourcesDigest)
        ) {
          throw new Error(`Scala graph: malformed BSP target ${target.name}`);
        }
      },
      validateShard: (raw, rawTarget, root) => {
        const shard = raw as unknown as IScalaGraphSnapshot.IShard;
        const target = rawTarget as unknown as IScalaGraphSnapshot.ITarget;
        const expectedPlugin = target.scalaVersion.startsWith("2.")
          ? "scala2"
          : "scala3";
        if (
          shard.compilerVersion !== target.scalaVersion ||
          shard.compilerPlugin !== expectedPlugin ||
          shard.compilerPluginVersion === "" ||
          shard.semanticdbSchema !== IScalaGraphSnapshot.SEMANTICDB_SCHEMA ||
          shard.semanticdbUri !== shard.source ||
          shard.semanticdbBuildTarget !== target.bspUri ||
          !MD5.test(shard.semanticdbMd5)
        ) {
          throw new Error(
            `Scala graph: malformed SemanticDB cross-check in ${shard.source}`,
          );
        }
        const source = path.resolve(root, shard.source);
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(source);
        } catch (error) {
          throw new Error(
            `Scala graph: cannot read SemanticDB source ${shard.source}: ${asError(error).message}`,
          );
        }
        const actual = createHash("md5").update(bytes).digest("hex");
        if (actual !== shard.semanticdbMd5) {
          throw new Error(
            `Scala graph: SemanticDB md5 does not match ${shard.source}`,
          );
        }
      },
    });
  }
}

function scalaVersion(value: unknown): value is string {
  return typeof value === "string" && /^(?:2\.1[23]|3)\./u.test(value);
}

function scalaBinaryVersion(version: string, binary: unknown): boolean {
  if (typeof binary !== "string") return false;
  return version.startsWith("3.")
    ? binary === "3"
    : binary === version.split(".").slice(0, 2).join(".");
}

function sourceEncoding(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/u.test(value);
}

function isUri(value: string): boolean {
  try {
    return new URL(value).protocol !== "";
  } catch {
    return false;
  }
}

function asError(value: unknown): Error {
  /* c8 ignore next -- Node's synchronous filesystem APIs throw Error objects. */
  return value instanceof Error ? value : new Error(String(value));
}
