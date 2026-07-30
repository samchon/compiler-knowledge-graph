import { TestValidator } from "@nestia/e2e";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ISidecarSnapshot,
  SidecarSession,
  sidecarProvider,
} from "@samchon/graph";

import { GraphPaths } from "../internal/GraphPaths";

/** Every language sidecar is held to one bounded, atomic wire contract. */
export const test_sidecar_session_enforces_the_common_semantic_contract =
  async () => {
    const root = GraphPaths.createTempDirectory("graph-sidecar-");
    try {
      const source = "package main\n";
      fs.writeFileSync(path.join(root, "main.go"), source);
      const payload = path.join(root, "wire.json");
      write(payload, snapshotOf(root, source));

      const session = sessionOf(root, payload);
      TestValidator.equals("a new sidecar has no current snapshot", session.current, undefined);
      TestValidator.equals("a new sidecar starts at generation zero", session.generation, 0);
      const initial = await session.refresh();
      TestValidator.equals("the first sidecar artifact is initial", initial.mode, "initial");
      TestValidator.equals(
        "the sidecar publishes its normalized node",
        initial.snapshot.nodes.map((node) => node.name),
        ["main"],
      );
      TestValidator.equals(
        "relative and bundled manifests survive",
        [...initial.snapshot.sources.keys()],
        [path.join(root, "main.go"), "bundled:///go/builtin"],
      );
      TestValidator.equals(
        "a virtual source has no fabricated disk digest",
        initial.snapshot.sources.get("bundled:///go/builtin")?.diskDigest,
        "",
      );
      TestValidator.equals(
        "the registered fact families own provenance",
        initial.snapshot.provenance.facts,
        ["contains", "calls"],
      );

      const unchanged = await session.refresh();
      TestValidator.equals("unchanged input reuses the exact snapshot", unchanged, {
        changed: false,
        generation: 1,
        mode: "unchanged",
        snapshot: initial.snapshot,
      });
      configuration = "GOOS=windows";
      const reconfigured = await session.refresh();
      TestValidator.equals(
        "a non-file build setting replaces the complete artifact",
        [reconfigured.mode, reconfigured.generation],
        ["rebuild", 2],
      );
      fs.appendFileSync(path.join(root, "main.go"), "// edit\n");
      const rebuilt = await session.refresh();
      TestValidator.equals("moved input rebuilds one whole artifact", rebuilt.mode, "rebuild");
      TestValidator.equals("a rebuild advances one generation", rebuilt.generation, 3);
      await session.close();
      await session.close();

      await rejected(root, payload, "an oversized artifact is refused", {
        maxArtifactBytes: 1,
      });

      // A producer that crashed mid-write, or printed a message where its
      // snapshot should be, used to surface as a bare `Unexpected token` with
      // no provider name and no trace of the bytes — the least useful sentence
      // available about the failure.
      const notJson = path.join(root, "not-json.txt");
      fs.writeFileSync(notJson, "panic: sidecar exploded\n");
      const broken = sessionOf(root, notJson);
      let brokenMessage = "";
      try {
        await broken.refresh();
      } catch (error) {
        brokenMessage = error instanceof Error ? error.message : String(error);
      }
      await broken.close();
      TestValidator.predicate(
        "a snapshot that is not JSON names its provider and what was there",
        brokenMessage.includes("is not JSON") &&
          brokenMessage.includes("panic: sidecar exploded"),
      );

      // Nothing at all is its own failure, and quoting an empty string would
      // leave a message trailing off after a colon.
      const empty = path.join(root, "empty.txt");
      fs.writeFileSync(empty, "");
      const silent = sessionOf(root, empty);
      let silentMessage = "";
      try {
        await silent.refresh();
      } catch (error) {
        silentMessage = error instanceof Error ? error.message : String(error);
      }
      await silent.close();
      TestValidator.predicate(
        "and an empty artifact says it is empty rather than quoting nothing",
        silentMessage.includes("the file is empty"),
      );
      TestValidator.error("zero artifact bounds are refused", () =>
        sessionOf(root, payload, { maxArtifactBytes: 0 }),
      );
      TestValidator.error("fractional artifact bounds are refused", () =>
        sessionOf(root, payload, { maxArtifactBytes: 1.5 }),
      );

      await invalid(root, payload, "a malformed wire shape is refused", {
        languages: ["no-such-language"],
      });
      await invalid(root, payload, "another project root is refused", {
        projectRoot: path.join(root, "other"),
      });
      await invalid(root, payload, "an empty project root is refused", {
        projectRoot: "",
      });
      await invalid(root, payload, "duplicate languages are refused", {
        languages: ["go", "go"],
      });
      await invalid(root, payload, "a moved language set is refused", {
        languages: ["rust"],
      });
      await invalid(root, payload, "duplicate capabilities are refused", {
        capabilities: ["sourceDigests", "sourceDigests"],
      });
      await invalid(root, payload, "an empty tool name is refused", {
        tool: { ...snapshotOf(root, source).tool, name: "" },
      });
      await invalid(root, payload, "an empty universe is refused", {
        universe: "",
      });
      await invalid(root, payload, "a fractional protocol is refused", {
        tool: { ...snapshotOf(root, source).tool, protocolVersion: 1.5 },
      });
      await invalid(root, payload, "a negative protocol is refused", {
        tool: { ...snapshotOf(root, source).tool, protocolVersion: -1 },
      });
      await invalid(root, payload, "duplicate normalized sources are refused", {
        sources: [
          ...snapshotOf(root, source).sources,
          {
            file: path.join(root, "main.go"),
            checkerDigest: digest(source),
            diskDigest: digest(source),
          },
        ],
      });
      await invalid(root, payload, "a malformed checker digest is refused", {
        sources: sourceRows(source, { checkerDigest: "ABC" }),
      });
      await invalid(root, payload, "a malformed disk digest is refused", {
        sources: sourceRows(source, { diskDigest: "xyz" }),
      });
      await invalid(root, payload, "claimed source digests must be complete", {
        sources: sourceRows(source, { checkerDigest: "" }),
      });
      await invalid(root, payload, "checker evidence requires its capability", {
        capabilities: ["diskDigests"],
      });
      await invalid(root, payload, "disk evidence requires its capability", {
        capabilities: ["sourceDigests"],
      });
      await invalid(root, payload, "an empty source identity is refused", {
        capabilities: [],
        sources: [{ file: "", checkerDigest: "", diskDigest: "" }],
      });
      await invalid(root, payload, "a traversal source identity is refused", {
        capabilities: [],
        sources: [{ file: "src/../main.go", checkerDigest: "", diskDigest: "" }],
      });
      await invalid(root, payload, "an empty path segment is refused", {
        capabilities: [],
        sources: [{ file: "src//main.go", checkerDigest: "", diskDigest: "" }],
      });
      await invalid(root, payload, "a dot path segment is refused", {
        capabilities: [],
        sources: [{ file: "src/./main.go", checkerDigest: "", diskDigest: "" }],
      });

      const unclaimed = snapshotOf(root, source);
      unclaimed.capabilities = [];
      unclaimed.sources = sourceRows(source, {
        checkerDigest: "",
        diskDigest: "",
      });
      write(payload, unclaimed);
      const noDigestClaims = sessionOf(root, payload);
      TestValidator.equals(
        "empty digests remain honest when no capability is claimed",
        (await noDigestClaims.refresh()).snapshot.provenance.capabilities,
        [],
      );
      await noDigestClaims.close();
      write(payload, snapshotOf(root, source));

      const boundedStdout = sessionOf(root, payload, { maxStdoutBytes: 1 });
      await boundedStdout.close();

      const provider = sidecarProvider({
        name: "go-sidecar",
        languages: ["go"],
        authority: "compiler",
        facts: ["contains", "calls"],
        resolve: () => ({ command: process.execPath, args: [GraphPaths.fakeSidecar] }),
        indexArgs: (artifact) => [`--output=${artifact}`, `--input=${payload}`],
        inputs: () => ["main.go"],
      });
      TestValidator.equals("an unbounded build selects the sidecar", provider.refuse({ cwd: root }), undefined);
      TestValidator.predicate(
        "a custom server refuses the sidecar",
        provider
          .refuse({ cwd: root, server: "custom" })
          ?.includes("that option") === true,
      );
      TestValidator.predicate(
        "a file cap refuses the sidecar",
        provider.refuse({ cwd: root, maxFiles: 1 })?.includes("maxFiles") ===
          true,
      );
      TestValidator.predicate(
        "several caps name their plural refusal",
        provider
          .refuse({ cwd: root, maxFiles: 1, lspReferenceLimit: 1 })
          ?.includes("those options") === true,
      );
      TestValidator.equals("the factory omits undeclared build inputs", provider.buildInputs, undefined);
      TestValidator.equals("the factory omits absent preparation", provider.prepare, undefined);
      const opened = provider.open({
        root,
        command: provider.resolve(root, process.env)!,
        languages: ["go"],
        options: { cwd: root },
      });
      const openedRefresh = await opened.refresh();
      TestValidator.equals(
        "the provider factory routes its input and output arguments",
        [opened.generation, opened.current],
        [1, openedRefresh.snapshot],
      );
      await opened.close();

      const rejectedCandidate = provider.open({
        root,
        command: provider.resolve(root, process.env)!,
        languages: ["go"],
        options: { cwd: root },
      });
      const missingManifest = snapshotOf(root, source);
      missingManifest.sources = missingManifest.sources.filter(
        (entry) => entry.file.startsWith("bundled:///"),
      );
      write(payload, missingManifest);
      await TestValidator.error(
        "sidecar facts without their source manifest are refused before caching",
        () => rejectedCandidate.refresh(),
      );
      TestValidator.equals(
        "a refused sidecar candidate does not poison current state",
        [rejectedCandidate.generation, rejectedCandidate.current],
        [0, undefined],
      );
      const fractionalSpan = snapshotOf(root, source);
      fractionalSpan.nodes[0]!.evidence = { startLine: 1.5 };
      write(payload, fractionalSpan);
      await TestValidator.error(
        "sidecar facts share the public safe-integer span boundary",
        () => rejectedCandidate.refresh(),
      );
      write(payload, snapshotOf(root, source));
      TestValidator.equals(
        "the same session can publish a later valid candidate",
        (await rejectedCandidate.refresh()).generation,
        1,
      );
      await rejectedCandidate.close();

      const configured = sidecarProvider({
        name: "configured-go-sidecar",
        languages: ["go"],
        authority: "compiler",
        facts: ["contains", "calls"],
        resolve: () => ({
          command: process.execPath,
          args: [GraphPaths.fakeSidecar],
        }),
        indexArgs: (artifact) => [
          `--output=${artifact}`,
          `--input=${payload}`,
        ],
        inputs: () => ["main.go"],
        configuration: () => ["GOOS=fixture"],
      });
      const configuredSession = configured.open({
        root,
        command: configured.resolve(root, process.env)!,
        languages: ["go"],
        options: { cwd: root },
      });
      TestValidator.equals(
        "the provider-level configuration preserves its language binding",
        configured.configuration?.(root, process.env),
        ["GOOS=fixture"],
      );
      await configuredSession.refresh();
      await configuredSession.close();

      const prepared = sidecarProvider({
        name: "prepared-sidecar",
        languages: ["go"],
        authority: "analyzer",
        facts: [],
        buildInputs: ["go.mod"],
        resolve: () => undefined,
        prepare: () => undefined,
        indexArgs: () => [],
        inputs: () => [],
      });
      TestValidator.equals("declared build inputs survive the factory", prepared.buildInputs, ["go.mod"]);
      TestValidator.predicate("declared preparation survives the factory", prepared.prepare !== undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

async function invalid(
  root: string,
  payload: string,
  label: string,
  override: Record<string, unknown>,
): Promise<void> {
  const source = fs.readFileSync(path.join(root, "main.go"), "utf8");
  write(payload, { ...snapshotOf(root, source), ...override });
  await rejected(root, payload, label);
}

async function rejected(
  root: string,
  payload: string,
  label: string,
  options: Partial<SidecarSession.IOptions> = {},
): Promise<void> {
  const session = sessionOf(root, payload, options);
  await TestValidator.error(label, () => session.refresh());
  await session.close();
}

function sessionOf(
  root: string,
  payload: string,
  options: Partial<SidecarSession.IOptions> = {},
): SidecarSession {
  return new SidecarSession({
    root,
    languages: ["go"],
    provider: "fake-sidecar",
    authority: "compiler",
    facts: ["contains", "calls"],
    command: { command: process.execPath, args: [GraphPaths.fakeSidecar] },
    indexArgs: (artifact) => [`--output=${artifact}`, `--input=${payload}`],
    inputs: () => ["main.go"],
    configuration: () => [configuration],
    ...options,
  });
}

let configuration = "GOOS=linux";

function snapshotOf(root: string, source: string): ISidecarSnapshot {
  return {
    schemaVersion: 1,
    projectRoot: `file://${root.startsWith("/") ? "" : "/"}${root.replace(/\\/g, "/")}`,
    languages: ["go"],
    tool: {
      name: "go-sidecar",
      version: "1.0.0",
      compilerVersion: "go1.26",
      protocolVersion: 1,
    },
    universe: digest("go-build"),
    capabilities: ["universe", "sourceDigests", "diskDigests"],
    sources: [
      ...sourceRows(source),
      {
        file: "bundled:///go/builtin",
        checkerDigest: digest("builtin"),
        diskDigest: "",
      },
    ],
    nodes: [
      {
        id: "@v2/go/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#main:function",
        kind: "function",
        language: "go",
        name: "main",
        file: "main.go",
        external: false,
      },
    ],
    edges: [],
    diagnostics: [],
    warnings: [],
  };
}

function sourceRows(
  source: string,
  override: { checkerDigest?: string; diskDigest?: string } = {},
): ISidecarSnapshot["sources"] {
  return [
    {
      file: "main.go",
      checkerDigest: override.checkerDigest ?? digest(source),
      diskDigest: override.diskDigest ?? digest(source),
    },
  ];
}

function write(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
