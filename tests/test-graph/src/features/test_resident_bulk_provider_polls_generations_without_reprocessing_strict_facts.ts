import { TestValidator } from "@nestia/e2e";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createResidentGraphSource } from "../../../../packages/graph/src/indexer/createResidentGraphSource";
import { IIndexerResult } from "../../../../packages/graph/src/indexer/IIndexerResult";
import { IBulkGraphSession } from "../../../../packages/graph/src/provider/IBulkGraphSession";

export const test_resident_bulk_provider_polls_generations_without_reprocessing_strict_facts =
  async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "samchon-graph-resident-bulk-"),
    );
    const file = path.join(root, "a.ts");
    const text = "export const answer = 1;\n";
    fs.writeFileSync(file, text);
    const first = snapshot(file, text, "first");
    const second = snapshot(file, text, "second");
    let current = first;
    let generation = 1;
    let refreshes = 0;
    let closes = 0;
    let builds = 0;
    const session: IBulkGraphSession = {
      kind: "bulk",
      languages: ["typescript"],
      root,
      get generation() {
        return generation;
      },
      get current() {
        return current;
      },
      async refresh() {
        refreshes += 1;
        if (refreshes === 2) {
          current = second;
          generation = 2;
          return {
            changed: true,
            generation,
            mode: "incremental",
            snapshot: current,
          };
        }
        if (refreshes === 3) throw new Error("synthetic provider failure");
        return {
          changed: false,
          generation,
          mode: "unchanged",
          snapshot: current,
        };
      },
      async close() {
        closes += 1;
      },
    };
    const initialDump = {
      project: root,
      // Exercise bookkeeping independently of the buildLspGraph regression:
      // an older/mocked pure-strict result may omit language metadata, but its
      // owned bulk session still determines the resident topology.
      languages: [] as const,
      indexer: "lsp" as const,
      nodes: first.nodes.map(({ evidence, ...node }) => ({
        ...node,
        evidence: {
          startLine: evidence!.startLine,
          endLine: evidence!.endLine,
        },
      })),
      edges: [],
      warnings: [],
    };
    const resident = createResidentGraphSource(
      { cwd: root, languages: ["typescript"] },
      {
        // Keep this hand-written legacy result independent of whichever
        // optional strict tools the coverage runner exposes through PATH.
        providers: [],
        buildLspGraph: async () => {
          builds += 1;
          return {
            dump: initialDump,
            warnings: [],
            sessions: new Map([["typescript", session]]),
            // The session must remain authoritative even before it has exposed
            // a source-text snapshot.
            sources: new Map(),
            modes: new Map<string, IBulkGraphSession.Mode>([
              ["ttscgraph", "initial"],
            ]),
          } as IIndexerResult;
        },
      },
    );

    TestValidator.equals(
      "resident modes are empty before the first generation",
      [...resident.modes()],
      [],
    );
    const loaded = await resident.load();
    TestValidator.equals(
      "the cold provider mode is observable",
      [...resident.modes()],
      [["ttscgraph", "initial"]],
    );
    const originalReadFileSync = fs.readFileSync;
    const originalReaddirSync = fs.readdirSync;
    let sourceReads = 0;
    let directoryReads = 0;
    fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof target === "string" && path.resolve(target) === file) {
        sourceReads += 1;
      }
      return Reflect.apply(originalReadFileSync, fs, [
        target,
        ...args,
      ]) as ReturnType<typeof fs.readFileSync>;
    }) as typeof fs.readFileSync;
    fs.readdirSync = ((...args: unknown[]) => {
      directoryReads += 1;
      return Reflect.apply(
        originalReaddirSync as (...values: unknown[]) => unknown,
        fs,
        args,
      );
    }) as typeof fs.readdirSync;
    let unchanged;
    try {
      unchanged = await resident.load();
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.readdirSync = originalReaddirSync;
    }
    TestValidator.equals(
      "an unchanged compiler-owned generation performs no coordinator corpus walk or source read",
      [directoryReads, sourceReads],
      [0, 0],
    );
    TestValidator.predicate(
      "an unchanged bulk generation reuses the resident dump object",
      unchanged === loaded,
    );
    TestValidator.equals(
      "an unchanged poll reports reuse independently of dump identity",
      [...resident.modes()],
      [["ttscgraph", "unchanged"]],
    );
    const changed = await resident.load();
    TestValidator.predicate(
      "a changed full slice atomically replaces the resident dump",
      changed !== loaded &&
        changed.nodes.length === 1 &&
        changed.nodes[0]?.name === "second" &&
        changed.nodes[0]?.ignored === true &&
        changed.nodes[0]?.closure === true,
    );
    TestValidator.equals(
      "a changed provider exposes its actual computation mode",
      [...resident.modes()],
      [["ttscgraph", "incremental"]],
    );
    await rejects(resident.load(), "a provider poll failure is surfaced");
    const recovered = await resident.load();
    TestValidator.predicate(
      "the last published generation survives a failed provider poll",
      recovered === changed && recovered.nodes[0]?.name === "second",
    );
    TestValidator.equals(
      "the recovered unchanged poll is measured without replacing the dump",
      [...resident.modes()],
      [["ttscgraph", "unchanged"]],
    );
    TestValidator.equals(
      "an empty dump language list cannot misclassify or replace its strict session",
      builds,
      1,
    );
    await resident.close();
    TestValidator.equals("resident shutdown closes its owned bulk session once", closes, 1);
  };

function snapshot(
  file: string,
  text: string,
  name: string,
): IBulkGraphSession.ISnapshot {
  const digest = createHash("sha256").update(text).digest("hex");
  return {
    languages: ["typescript"],
    nodes: [
      {
        id: `a.ts#${name}:function`,
        kind: "function",
        language: "typescript",
        name,
        file: "a.ts",
        external: false,
        ignored: true,
        closure: true,
        evidence: { file: "a.ts", startLine: 1, endLine: 1 },
      },
    ],
    edges: [],
    diagnostics: [],
    // A bulk snapshot names its files and the digest its checker read; it never
    // carries their text, so a resident refresh has nothing to re-read either.
    sources: new Map([[file, { checkerDigest: digest, diskDigest: digest }]]),
    provenance: {
      provider: "ttscgraph",
      authority: "compiler",
      facts: ["exports", "calls"],
      schemaVersion: 6,
      tool: "ttscgraph",
      toolVersion: "0.20.1",
      compilerVersion: "5.9.0",
      protocolVersion: 1,
      universe: createHash("sha256").update("universe").digest("hex"),
      capabilities: ["universe", "sourceDigests", "diskDigests", "diagnostics"],
    },
    warnings: [],
  };
}

async function rejects(task: Promise<unknown>, label: string): Promise<void> {
  let error: unknown;
  try {
    await task;
  } catch (caught) {
    error = caught;
  }
  TestValidator.predicate(label, error instanceof Error);
}
