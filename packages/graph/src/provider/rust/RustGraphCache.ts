import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphSnapshotProtocol } from "../GraphSnapshotProtocol";
import { IRustGraphCacheState } from "./IRustGraphCacheState";

const CACHE_VERSION = 1;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const RETAINED_GENERATIONS = 2;
const GENERATION = /^[a-f0-9]{64}$/u;

export namespace RustGraphCache {
  export function load(
    props: IProps,
    accept: (state: IRustGraphCacheState) => boolean = () => true,
  ): IRustGraphCacheState | undefined {
    const directory = projectDirectory(props);
    let files: string[];
    try {
      files = fs
        .readdirSync(directory)
        .filter((file) => /^\d+-[a-f0-9]{64}\.json$/u.test(file))
        .sort((left, right) => sequenceOf(right) - sequenceOf(left));
    } catch {
      return undefined;
    }
    for (const file of files) {
      try {
        const coordinates = coordinatesOf(file);
        if (coordinates === undefined) continue;
        const absolute = path.join(directory, file);
        const size = fs.statSync(absolute).size;
        if (size < 1 || size > MAX_CACHE_BYTES) continue;
        const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as IRustGraphCacheState;
        if (
          parsed.version === CACHE_VERSION &&
          parsed.producerCommit === props.producerCommit &&
          Array.isArray(parsed.frames) &&
          Array.isArray(parsed.rawShards) &&
          parsed.checkpoint !== null &&
          typeof parsed.checkpoint === "object" &&
          parsed.checkpoint.generation === coordinates.generation &&
          isMatchingCommitFrame(
            parsed.frames.at(-1),
            coordinates.sequence,
            coordinates.generation,
          )
        ) {
          if (accept(parsed)) return parsed;
        }
      } catch {
        // A torn or obsolete cache generation is not evidence. Try the prior
        // immutable generation and let the live producer validate any winner.
      }
    }
    return undefined;
  }

  export function save(
    props: IProps,
    sequence: number,
    generation: string,
    state: IRustGraphCacheState,
  ): void {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      !GENERATION.test(generation) ||
      state.checkpoint.generation !== generation ||
      !isMatchingCommitFrame(state.frames.at(-1), sequence, generation)
    ) {
      throw new Error("rust HIR graph: invalid persisted generation coordinates");
    }
    const encoded = JSON.stringify(state);
    /* c8 ignore start -- exercising the hard 512 MiB corruption guard would
     * allocate a fixture larger than the test process's bounded heap. */
    if (Buffer.byteLength(encoded, "utf8") > MAX_CACHE_BYTES) {
      throw new Error("rust HIR graph: persisted generation exceeds the cache size limit");
    }
    /* c8 ignore stop */
    const directory = projectDirectory(props);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${String(sequence)}-${generation}.json`);
    if (!fs.existsSync(file)) {
      const temporary = path.join(
        directory,
        `.${String(process.pid)}-${String(sequence)}-${generation}.tmp`,
      );
      fs.writeFileSync(temporary, encoded, {
        encoding: "utf8",
        flag: "wx",
      });
      try {
        fs.renameSync(temporary, file);
      } catch (error) {
        if (!fs.existsSync(file)) throw error;
        fs.rmSync(temporary);
      }
    }
    const obsolete = fs
      .readdirSync(directory)
      .filter((entry) => /^\d+-[a-f0-9]{64}\.json$/u.test(entry))
      .sort((left, right) => sequenceOf(right) - sequenceOf(left))
      .slice(RETAINED_GENERATIONS);
    for (const entry of obsolete) fs.rmSync(path.join(directory, entry));
  }

  export function clear(props: IProps): void {
    const directory = projectDirectory(props);
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        /^\d+-[a-f0-9]{64}\.json$/u.test(entry) ||
        /^\.\d+-\d+-[a-f0-9]{64}\.tmp$/u.test(entry)
      ) {
        fs.rmSync(path.join(directory, entry));
      }
    }
  }

  export interface IProps {
    root: string;
    producerCommit: string;
    cacheRoot?: string;
  }
}

function projectDirectory(props: RustGraphCache.IProps): string {
  const root = path.resolve(props.root);
  /* c8 ignore start -- coverage runs on one host platform; Windows folds the
   * cache identity and POSIX preserves it. */
  const cacheIdentity = process.platform === "win32" ? root.toLowerCase() : root;
  /* c8 ignore stop */
  const key = createHash("sha256")
    .update(cacheIdentity)
    .digest("hex");
  return path.join(
    props.cacheRoot ?? defaultCacheRoot(),
    "rust",
    props.producerCommit,
    key,
  );
}

function defaultCacheRoot(): string {
  const configured = process.env.SAMCHON_GRAPH_CACHE_DIR;
  if (configured !== undefined && path.isAbsolute(configured)) return configured;
  /* c8 ignore start -- this branch is executable only on Windows; the Windows
   * CI lane exercises it while POSIX coverage cannot change process.platform. */
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local !== undefined && path.isAbsolute(local)) {
      return path.join(local, "samchon-graph");
    }
  }
  /* c8 ignore stop */
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg !== undefined && path.isAbsolute(xdg)) {
    return path.join(xdg, "samchon-graph");
  }
  return path.join(os.homedir(), ".cache", "samchon-graph");
}

function sequenceOf(file: string): number {
  return Number(file.slice(0, file.indexOf("-")));
}

function coordinatesOf(
  file: string,
): { sequence: number; generation: string } | undefined {
  const separator = file.indexOf("-");
  const sequence = Number(file.slice(0, separator));
  const generation = file.slice(separator + 1, -".json".length);
  return Number.isSafeInteger(sequence) && sequence >= 1 && GENERATION.test(generation)
    ? { sequence, generation }
    : undefined;
}

function isMatchingCommitFrame(
  value: unknown,
  sequence: number,
  generation: string,
): boolean {
  if (value === null || typeof value !== "object") return false;
  const frame = value as { type?: unknown; sequence?: unknown; generation?: unknown };
  return (
    frame.type === "commit" &&
    frame.sequence === sequence &&
    frame.generation === generation
  );
}
