import {
  invalidWebsiteCellReason,
  websiteCellKey,
} from "./website-cell.mjs";
import {
  expectedPrimaryProvider,
  strictIntentOfTool,
} from "./index-time-cell.mjs";

/**
 * Start an agent-result merge without dropping a benchmark axis it does not own.
 */
export function agentPublicationDocument(prior) {
  if (prior !== null && prior !== undefined) {
    assertWebsitePublication(prior);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    structural: prior?.structural ?? null,
    agent: { cells: [...(prior?.agent?.cells ?? [])] },
    ...(prior?.index !== undefined ? { index: prior.index } : {}),
  };
}

export function assertIndexReport(value, label) {
  assertRecord(value, label);
  const schemaVersion = value.schemaVersion ?? 1;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new TypeError(
      `${label}.schemaVersion must be omitted, 1, or 2`,
    );
  }
  assertHost(value.host, `${label}.host`);
  if (value.toolchain !== undefined) {
    assertToolchainEvidence(value.toolchain, `${label}.toolchain`);
  }
  assertScale(value.scale, `${label}.scale`);
  const fixtures =
    schemaVersion === 2
      ? assertFixtureRevisions(value.fixtures, `${label}.fixtures`)
      : undefined;
  assertIndexCells(value.cells, `${label}.cells`, fixtures);
  if (fixtures !== undefined) {
    const scaleProjects = new Set(Object.keys(value.scale));
    for (const project of scaleProjects) {
      if (!fixtures.has(project)) {
        throw new TypeError(
          `${label}.fixtures must bind scaled project ${project} to its measured revision`,
        );
      }
    }
    for (const project of fixtures.keys()) {
      if (!scaleProjects.has(project)) {
        throw new TypeError(
          `${label}.fixtures binds unscaled project ${project}`,
        );
      }
    }
  }
}

export function assertWebsitePublication(value) {
  assertRecord(value, "existing benchmark publication");
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== 1
  ) {
    throw new TypeError(
      "existing benchmark publication.schemaVersion must be omitted or 1",
    );
  }
  if (value.agent !== undefined && value.agent !== null) {
    assertRecord(value.agent, "existing benchmark publication.agent");
    if (!Array.isArray(value.agent.cells)) {
      throw new TypeError(
        "existing benchmark publication.agent.cells must be an array",
      );
    }
    const identities = new Set();
    for (const [index, cell] of value.agent.cells.entries()) {
      const label = `existing benchmark publication.agent.cells[${String(index)}]`;
      assertRecord(cell, label);
      for (const field of ["harness", "tool", "repo", "model"]) {
        if (typeof cell[field] !== "string" || cell[field].trim() === "") {
          throw new TypeError(`${label}.${field} must be a nonempty string`);
        }
      }
      if (!Number.isSafeInteger(cell.runs) || cell.runs < 1) {
        throw new TypeError(`${label}.runs must be a positive safe integer`);
      }
      const invalidReason = invalidWebsiteCellReason(cell);
      if (invalidReason !== null) {
        throw new TypeError(`${label} is invalid: ${invalidReason}`);
      }
      const identity = websiteCellKey(cell);
      if (identities.has(identity)) {
        throw new TypeError(`${label} duplicates an earlier agent cell identity`);
      }
      identities.add(identity);
    }
  }
  if (value.structural !== undefined && value.structural !== null) {
    assertRecord(value.structural, "existing benchmark publication.structural");
  }
  if (value.index !== undefined && value.index !== null) {
    assertIndexReport(value.index, "existing benchmark publication.index");
  }
}

function assertScale(value, label) {
  assertRecord(value, label);
  for (const [project, scale] of Object.entries(value)) {
    assertRecord(scale, `${label}.${project}`);
    for (const field of ["files", "lines"]) {
      if (!Number.isSafeInteger(scale[field]) || scale[field] < 0) {
        throw new TypeError(
          `${label}.${project}.${field} must be a nonnegative safe integer`,
        );
      }
    }
  }
}

function assertIndexCells(value, label, fixtures) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const identities = new Set();
  for (const [index, cell] of value.entries()) {
    const cellLabel = `${label}[${String(index)}]`;
    assertRecord(cell, cellLabel);
    for (const field of ["project", "tool"]) {
      if (typeof cell[field] !== "string" || cell[field].trim() === "") {
        throw new TypeError(`${cellLabel}.${field} must be a nonempty string`);
      }
    }
    if (fixtures !== undefined) {
      const fixtureCommit = fixtures.get(cell.project);
      if (fixtureCommit === undefined) {
        throw new TypeError(
          `${cellLabel}.project has no fixture revision in its index document`,
        );
      }
      if (cell.fixtureCommit !== fixtureCommit) {
        throw new TypeError(
          `${cellLabel}.fixtureCommit must match the measured project revision`,
        );
      }
    } else if (
      cell.fixtureCommit !== undefined &&
      !isCommit(cell.fixtureCommit)
    ) {
      throw new TypeError(
        `${cellLabel}.fixtureCommit must be a full lowercase Git commit`,
      );
    }
    if (
      cell.buildMs !== undefined &&
      cell.buildMs !== null &&
      (typeof cell.buildMs !== "number" ||
        !Number.isFinite(cell.buildMs) ||
        cell.buildMs < 0)
    ) {
      throw new TypeError(
        `${cellLabel}.buildMs must be null or a nonnegative finite number`,
      );
    }
    if (
      cell.timedOutMs !== undefined &&
      cell.timedOutMs !== null &&
      (typeof cell.timedOutMs !== "number" ||
        !Number.isFinite(cell.timedOutMs) ||
        cell.timedOutMs <= 0)
    ) {
      throw new TypeError(
        `${cellLabel}.timedOutMs must be null or a positive finite number`,
      );
    }
    for (const field of ["hasBuildStep", "strict"]) {
      if (cell[field] !== undefined && typeof cell[field] !== "boolean") {
        throw new TypeError(`${cellLabel}.${field} must be a boolean`);
      }
    }
    if (
      cell.measuredAt !== undefined &&
      (typeof cell.measuredAt !== "string" ||
        Number.isNaN(Date.parse(cell.measuredAt)))
    ) {
      throw new TypeError(
        `${cellLabel}.measuredAt must be an ISO-compatible date string`,
      );
    }
    if (
      cell.measurementId !== undefined &&
      (typeof cell.measurementId !== "string" ||
        cell.measurementId.trim() === "")
    ) {
      throw new TypeError(
        `${cellLabel}.measurementId must be a nonempty string`,
      );
    }
    const outcomes = [
      typeof cell.buildMs === "number",
      typeof cell.timedOutMs === "number",
      cell.hasBuildStep === false,
    ].filter(Boolean).length;
    if (outcomes !== 1) {
      throw new TypeError(
        `${cellLabel} must carry exactly one build duration, timeout duration, or no-build marker`,
      );
    }
    assertHost(cell.host, `${cellLabel}.host`);
    if (cell.toolchain !== undefined) {
      assertToolchainEvidence(cell.toolchain, `${cellLabel}.toolchain`);
    }
    if (cell.route !== undefined) {
      assertIndexRoute(cell, cellLabel);
    }
    if (cell.quietWait !== undefined && cell.quietWait !== null) {
      assertRecord(cell.quietWait, `${cellLabel}.quietWait`);
    }
    const identity = JSON.stringify([cell.project, cell.tool]);
    if (identities.has(identity)) {
      throw new TypeError(`${cellLabel} duplicates an earlier index cell identity`);
    }
    identities.add(identity);
  }
}

function assertIndexRoute(cell, label) {
  const strict = strictIntentOfTool(cell.tool);
  if (strict === undefined) {
    throw new TypeError(`${label}.route belongs only to a samchon-graph cell`);
  }
  if (cell.strict !== strict) {
    throw new TypeError(`${label}.strict reverses its measured tool intent`);
  }
  if (typeof cell.language !== "string" || cell.language.trim() === "") {
    throw new TypeError(`${label}.language must name the routed language`);
  }
  assertRecord(cell.route, `${label}.route`);
  if (cell.route.schemaVersion !== 1) {
    throw new TypeError(`${label}.route.schemaVersion must be 1`);
  }
  const intentLabel = `${label}.route.intent`;
  const outcomeLabel = `${label}.route.outcome`;
  assertRecord(cell.route.intent, intentLabel);
  assertRecord(cell.route.outcome, outcomeLabel);
  const expected = expectedPrimaryProvider(cell.language);
  const intent = cell.route.intent;
  if (
    (strict && intent.strictProviders !== "enabled") ||
    (!strict && intent.strictProviders !== "stood-down")
  ) {
    throw new TypeError(`${intentLabel}.strictProviders reverses its tool`);
  }
  if (
    (strict && intent.expectedPrimaryProvider !== expected) ||
    (!strict && intent.expectedPrimaryProvider !== null)
  ) {
    throw new TypeError(
      `${intentLabel}.expectedPrimaryProvider disagrees with the canonical registry`,
    );
  }

  const outcome = cell.route.outcome;
  if (!["served", "fallback", "static", "unknown"].includes(outcome.verdict)) {
    throw new TypeError(`${outcomeLabel}.verdict is invalid`);
  }
  if (
    outcome.indexer !== null &&
    !["lsp", "hybrid", "static"].includes(outcome.indexer)
  ) {
    throw new TypeError(`${outcomeLabel}.indexer is invalid`);
  }
  if (!Array.isArray(outcome.provenance)) {
    throw new TypeError(`${outcomeLabel}.provenance must be an array`);
  }
  if (outcome.truncated !== undefined && outcome.truncated !== true) {
    throw new TypeError(`${outcomeLabel}.truncated must be true when present`);
  }
  const providers = new Set();
  for (const [index, provenance] of outcome.provenance.entries()) {
    const provenanceLabel = `${outcomeLabel}.provenance[${String(index)}]`;
    assertRecord(provenance, provenanceLabel);
    for (const field of ["provider", "authority"]) {
      if (
        typeof provenance[field] !== "string" ||
        provenance[field].trim() === ""
      ) {
        throw new TypeError(`${provenanceLabel}.${field} must be nonempty`);
      }
    }
    if (providers.has(provenance.provider)) {
      throw new TypeError(`${provenanceLabel}.provider is duplicated`);
    }
    providers.add(provenance.provider);
    if (
      !Array.isArray(provenance.languages) ||
      !provenance.languages.includes(cell.language) ||
      provenance.languages.some(
        (language) => typeof language !== "string" || language.trim() === "",
      ) ||
      new Set(provenance.languages).size !== provenance.languages.length
    ) {
      throw new TypeError(
        `${provenanceLabel}.languages must include the measured language`,
      );
    }
    assertRecord(provenance.producer, `${provenanceLabel}.producer`);
    for (const field of ["tool", "version"]) {
      if (
        typeof provenance.producer[field] !== "string" ||
        provenance.producer[field].trim() === ""
      ) {
        throw new TypeError(
          `${provenanceLabel}.producer.${field} must be nonempty`,
        );
      }
    }
    for (const field of ["schemaVersion", "protocolVersion"]) {
      if (
        !Number.isSafeInteger(provenance.producer[field]) ||
        provenance.producer[field] < 1
      ) {
        throw new TypeError(
          `${provenanceLabel}.producer.${field} must be a positive safe integer`,
        );
      }
    }
    if (
      cell.toolchain?.status === "recorded" &&
      !producerDescribedByToolchain(
        provenance.producer,
        cell.toolchain.tools,
      )
    ) {
        throw new TypeError(
          `${provenanceLabel}.producer is absent from the claimed toolchain`,
        );
    }
  }
  const primaryServed = providers.has(expected);
  if (
    outcome.truncated === true &&
    (outcome.verdict !== "unknown" || outcome.provenance.length !== 0)
  ) {
    throw new TypeError(
      `${outcomeLabel}.truncated can describe only unknown empty provenance`,
    );
  }
  if (
    outcome.verdict === "served" &&
    (!strict ||
      !primaryServed ||
      (outcome.indexer !== "lsp" && outcome.indexer !== "hybrid"))
  ) {
    throw new TypeError(`${outcomeLabel} falsely claims the primary served`);
  }
  if (
    outcome.verdict === "fallback" &&
    ((outcome.indexer !== "lsp" && outcome.indexer !== "hybrid") ||
      (strict && primaryServed))
  ) {
    throw new TypeError(`${outcomeLabel} is not a fallback result`);
  }
  if (
    outcome.verdict === "static" &&
    (outcome.indexer !== "static" || outcome.provenance.length !== 0)
  ) {
    throw new TypeError(`${outcomeLabel} is not a static result`);
  }
  if (
    outcome.verdict === "unknown" &&
    (outcome.provenance.length !== 0 ||
      (outcome.indexer !== null && outcome.truncated !== true))
  ) {
    throw new TypeError(`${outcomeLabel} claims evidence despite being unknown`);
  }
}

/** Bind producer self-identification to the provisioned launcher/build pin. */
export function producerDescribedByToolchain(producer, tools) {
  const alias = PRODUCER_TOOLCHAIN_ALIASES[producer.tool];
  return tools.some((tool) => {
    if (tool.version === "unpinned") {
      return false;
    }
    if (tool.tool === producer.tool) {
      return (
        tool.version === producer.version ||
        (isImmutableBuildPin(tool.version) &&
          containsExactPin(producer.version, tool.version))
      );
    }
    return Boolean(
      alias?.tool === tool.tool &&
        alias.producerVersions.includes(producer.version) &&
        (containsExactPin(tool.source, tool.version) ||
          containsExactPin(tool.digest, tool.version)),
    );
  });
}

const PRODUCER_TOOLCHAIN_ALIASES = {
  "scip-java-javac-graph": {
    tool: "scip-java",
    producerVersions: ["0.0.0-SNAPSHOT"],
  },
};

function isImmutableBuildPin(version) {
  return /^[0-9a-f]{40,64}$/i.test(version);
}

function containsExactPin(evidence, pin) {
  const index = evidence.indexOf(pin);
  if (index === -1) return false;
  const before = evidence[index - 1];
  const after = evidence[index + pin.length];
  return !isPinCharacter(before) && !isPinCharacter(after);
}

function isPinCharacter(character) {
  return character !== undefined && /[A-Za-z0-9]/.test(character);
}

function assertToolchainEvidence(value, label) {
  assertRecord(value, label);
  if (value.status !== "recorded" && value.status !== "unreported") {
    throw new TypeError(
      `${label}.status must be recorded or unreported`,
    );
  }
  if (!Array.isArray(value.tools)) {
    throw new TypeError(`${label}.tools must be an array`);
  }
  if (
    (value.status === "recorded" && value.tools.length === 0) ||
    (value.status === "unreported" && value.tools.length !== 0)
  ) {
    throw new TypeError(
      `${label}.status must agree with whether tools were recorded`,
    );
  }
  const identities = new Set();
  for (const [index, tool] of value.tools.entries()) {
    const toolLabel = `${label}.tools[${String(index)}]`;
    assertRecord(tool, toolLabel);
    for (const field of ["tool", "version", "source", "digest"]) {
      if (typeof tool[field] !== "string" || tool[field].trim() === "") {
        throw new TypeError(
          `${toolLabel}.${field} must be a nonempty string`,
        );
      }
    }
    if (identities.has(tool.tool)) {
      throw new TypeError(
        `${toolLabel}.tool duplicates an earlier tool identity`,
      );
    }
    identities.add(tool.tool);
  }
}

function assertFixtureRevisions(value, label) {
  assertRecord(value, label);
  const fixtures = new Map();
  for (const [project, commit] of Object.entries(value)) {
    if (project.trim() === "") {
      throw new TypeError(`${label} must not contain an empty project name`);
    }
    if (!isCommit(commit)) {
      throw new TypeError(
        `${label}.${project} must be a full lowercase Git commit`,
      );
    }
    fixtures.set(project, commit);
  }
  return fixtures;
}

function isCommit(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function assertHost(value, label) {
  assertRecord(value, label);
  for (const field of ["cpu", "os", "kernel", "node"]) {
    if (
      !Object.hasOwn(value, field) ||
      typeof value[field] !== "string" ||
      value[field].trim() === ""
    ) {
      throw new TypeError(`${label}.${field} must be a nonempty string`);
    }
  }
  for (const field of ["cores", "ramGB"]) {
    if (
      !Object.hasOwn(value, field) ||
      !Number.isSafeInteger(value[field]) ||
      value[field] < 1
    ) {
      throw new TypeError(
        `${label}.${field} must be a positive safe integer`,
      );
    }
  }
}

function assertRecord(value, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
}
