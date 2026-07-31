import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const startMarker = "<!-- provider-support:start -->";
const endMarker = "<!-- provider-support:end -->";
const args = new Set(process.argv.slice(2));
const manifestArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--manifest="));
const manifestFile = path.resolve(
  root,
  manifestArgument?.slice("--manifest=".length) ??
    "docs/provider-support.json",
);
const write = args.has("--write");
const validateOnly = args.has("--validate-only");
const supportedPlatforms = new Set([
  "linux",
  "macos",
  "windows",
  "windows-when-installed",
]);

if (write && validateOnly) {
  throw new Error(
    "provider support: --write and --validate-only are mutually exclusive",
  );
}

const manifest = readJson(manifestFile);
const { GRAPH_PROVIDERS } = await import(
  pathToFileURL(
    path.join(root, "packages/graph/lib/provider/GRAPH_PROVIDERS.js"),
  ).href
);
const { LANGUAGE_EXPERIMENTS } = await import(
  pathToFileURL(path.join(root, "tests/experiment/src/catalog.mjs")).href
);
const benchmarkFile = path.resolve(root, manifest.benchmark?.artifact ?? "");
const benchmark = readJson(benchmarkFile);

validateManifest(
  manifest,
  GRAPH_PROVIDERS,
  LANGUAGE_EXPERIMENTS,
  benchmark,
);

if (!validateOnly) {
  const readmeFile = path.join(root, "README.md");
  const readme = fs.readFileSync(readmeFile, "utf8");
  const generated = [
    startMarker,
    renderSupport(manifest),
    endMarker,
  ].join("\n");
  const next = replaceGeneratedBlock(readme, generated);
  if (write) {
    fs.writeFileSync(readmeFile, next);
  } else if (next !== readme) {
    throw new Error(
      "provider support: README block is stale; run `pnpm provider-support:write` after building @samchon/graph",
    );
  }
}

function validateManifest(
  support,
  providers,
  experiments,
  benchmarkResult,
) {
  invariant(
    support.schemaVersion === 1,
    "manifest schemaVersion must be 1",
  );
  invariant(
    Array.isArray(support.providers),
    "manifest providers must be an array",
  );
  invariant(
    Array.isArray(support.ordinaryOnly),
    "manifest ordinaryOnly must be an array",
  );
  invariant(
    support.benchmark?.kind ===
      "cold end-to-end strict versus strict-disabled pairs",
    "benchmark kind must name the cold paired measurement",
  );
  assertUrl(support.benchmark?.workflowRun, "benchmark workflowRun");
  invariant(
    benchmarkResult.index?.schemaVersion === 2 &&
      Array.isArray(benchmarkResult.index?.cells),
    "benchmark artifact must contain index schemaVersion 2 cells",
  );

  const providerNames = unique(
    support.providers.map((provider) => provider.provider),
    "manifest provider",
  );
  const runtimeNames = providers.map((provider) => provider.name);
  const missingProviders = runtimeNames.filter(
    (provider) => !providerNames.includes(provider),
  );
  const absentProviders = providerNames.filter(
    (provider) => !runtimeNames.includes(provider),
  );
  invariant(
    missingProviders.length === 0,
    `undocumented registered provider ${missingProviders.join(", ")}`,
  );
  invariant(
    absentProviders.length === 0,
    `documented absent provider ${absentProviders.join(", ")}`,
  );
  invariant(
    equal(providerNames, runtimeNames),
    "manifest providers must appear exactly once in GRAPH_PROVIDERS order",
  );

  const registeredLanguages = new Set();
  const benchmarkRows = new Map();
  for (const [index, documented] of support.providers.entries()) {
    const provider = providers[index];
    invariant(
      provider !== undefined && provider.name === documented.provider,
      `documented absent provider ${documented.provider}`,
    );
    for (const field of [
      "install",
      "resolution",
      "requirements",
      "mode",
      "nativeAnalysis",
      "exportMerge",
      "reuseResident",
      "limitations",
      "decline",
      "fallback",
    ]) {
      invariant(
        typeof documented[field] === "string" &&
          documented[field].trim() !== "",
        `${documented.provider} must define ${field}`,
      );
    }
    invariant(
      documented.status === "registered",
      `${documented.provider} status must be registered`,
    );
    invariant(
      Array.isArray(documented.platforms) &&
        documented.platforms.length > 0,
      `${documented.provider} must name supported platforms`,
    );
    unique(documented.platforms, `${documented.provider} platform`);
    for (const platform of documented.platforms) {
      invariant(
        supportedPlatforms.has(platform),
        `${documented.provider} names unknown platform ${platform}`,
      );
    }
    invariant(
      Array.isArray(documented.installSources) &&
        documented.installSources.length > 0,
      `${documented.provider} must name install sources`,
    );
    unique(
      documented.installSources.map((source) => source.label),
      `${documented.provider} install-source label`,
    );
    unique(
      documented.installSources.map((source) => source.url),
      `${documented.provider} install-source URL`,
    );
    for (const source of documented.installSources) {
      invariant(
        typeof source.label === "string" && source.label.trim() !== "",
        `${documented.provider} install source must have a label`,
      );
      assertUrl(
        source.url,
        `${documented.provider} install source ${source.label}`,
      );
    }
    assertUrl(documented.upstream, `${documented.provider} upstream`);
    invariant(
      Array.isArray(documented.childIssues) &&
        documented.childIssues.length > 0,
      `${documented.provider} must name child issues`,
    );
    unique(documented.childIssues, `${documented.provider} child issue`);
    for (const issue of documented.childIssues) {
      assertUrl(issue, `${documented.provider} child issue`);
    }
    unique(documented.languages, `${documented.provider} language`);
    unique(documented.facts, `${documented.provider} fact`);
    unique(documented.commands, `${documented.provider} command`);
    unique(
      documented.projectCommandSources ?? [],
      `${documented.provider} project command source`,
    );
    unique(
      documented.environmentOverrides,
      `${documented.provider} environment override`,
    );
    invariant(
      equal(documented.languages, provider.languages),
      `${documented.provider} languages differ from GRAPH_PROVIDERS`,
    );
    invariant(
      documented.authority === provider.authority,
      `${documented.provider} authority differs from GRAPH_PROVIDERS`,
    );
    invariant(
      equal(documented.facts, provider.facts),
      `${documented.provider} facts differ from GRAPH_PROVIDERS`,
    );
    invariant(
      equal(documented.commands, provider.resolution?.commands),
      `${documented.provider} commands differ from its resolver descriptor`,
    );
    invariant(
      equal(
        documented.projectCommandSources ?? [],
        provider.resolution?.projectCommandSources ?? [],
      ),
      `${documented.provider} project command sources differ from its resolver descriptor`,
    );
    invariant(
      equal(
        documented.environmentOverrides,
        provider.resolution?.environmentOverrides,
      ),
      `${documented.provider} environment overrides differ from its resolver descriptor`,
    );
    invariant(
      equal(
        [...documented.experimentLanguages].sort(),
        [...documented.languages].sort(),
      ),
      `${documented.provider} experiment languages must cover its registry languages`,
    );
    invariant(
      typeof documented.experimentTool === "string" &&
        documented.experimentTool !== "",
      `${documented.provider} must name its experiment tool`,
    );
    invariant(
      Array.isArray(documented.experimentCapabilities) &&
        documented.experimentCapabilities.length > 0,
      `${documented.provider} must name experiment capabilities`,
    );

    for (const language of documented.languages) {
      invariant(
        !registeredLanguages.has(language),
        `registered language ${language} is documented more than once`,
      );
      registeredLanguages.add(language);
      const rows = experiments.filter(
        (experiment) => experiment.language === language,
      );
      invariant(
        rows.length === 1,
        `experiment catalog must contain one ${language} row`,
      );
      const experiment = rows[0];
      invariant(
        experiment.strictProvider === documented.provider,
        `${language} experiment provider differs from the support manifest`,
      );
      invariant(
        experiment.strictAuthority === documented.authority,
        `${language} experiment authority differs from the support manifest`,
      );
      invariant(
        experiment.strictTool === documented.experimentTool,
        `${language} experiment tool differs from the support manifest`,
      );
      invariant(
        equal(
          experiment.requiredCapabilities ?? [],
          documented.experimentCapabilities,
        ),
        `${language} experiment capabilities differ from the support manifest`,
      );
      for (const fact of experiment.semanticEdges ?? []) {
        invariant(
          documented.facts.includes(fact),
          `${language} experiment requires undocumented ${fact} facts`,
        );
      }
    }

    invariant(
      Array.isArray(documented.benchmarks) &&
        documented.benchmarks.length > 0,
      `${documented.provider} must name benchmark evidence`,
    );
    for (const row of documented.benchmarks) {
      invariant(
        typeof row.project === "string" && row.project !== "",
        `${documented.provider} has a benchmark without a project`,
      );
      invariant(
        !benchmarkRows.has(row.project),
        `benchmark project ${row.project} is documented more than once`,
      );
      benchmarkRows.set(row.project, {
        provider: documented.provider,
        row,
      });
    }
  }

  const ordinaryLanguages = unique(
    support.ordinaryOnly.map((row) => row.language),
    "ordinary-only language",
  );
  for (const row of support.ordinaryOnly) {
    invariant(
      typeof row.server === "string" && row.server !== "",
      `${row.language} must name its ordinary server`,
    );
    invariant(
      typeof row.reason === "string" && row.reason !== "",
      `${row.language} must explain its ordinary-only status`,
    );
    assertUrl(row.issue, `${row.language} issue`);
    invariant(
      !registeredLanguages.has(row.language),
      `${row.language} cannot be both registered and ordinary-only`,
    );
    const rows = experiments.filter(
      (experiment) => experiment.language === row.language,
    );
    invariant(
      rows.length === 1 &&
        rows[0].strictProvider === undefined &&
        rows[0].strictTool === undefined,
      `${row.language} experiment must remain ordinary-only`,
    );
  }
  const experimentLanguages = unique(
    experiments.map((experiment) => experiment.language),
    "experiment language",
  );
  invariant(
    equal(
      [...registeredLanguages, ...ordinaryLanguages].sort(),
      [...experimentLanguages].sort(),
    ),
    "support manifest must classify every experiment language exactly once",
  );

  const cells = benchmarkResult.index.cells;
  const cellProjects = [...new Set(cells.map((cell) => cell.project))];
  invariant(
    equal([...benchmarkRows.keys()].sort(), [...cellProjects].sort()),
    "manifest benchmark projects must match the exact artifact",
  );
  for (const [project, documented] of benchmarkRows) {
    const strict = cells.filter(
      (cell) => cell.project === project && cell.strict === true,
    );
    const fallback = cells.filter(
      (cell) => cell.project === project && cell.strict === false,
    );
    invariant(
      strict.length === 1 && fallback.length === 1,
      `${project} must have one strict and one strict-disabled cell`,
    );
    invariant(
      strict[0].measurementId === fallback[0].measurementId,
      `${project} benchmark cells must come from one paired measurement`,
    );
    invariant(
      strict[0].servedBy.includes(documented.provider),
      `${project} strict cell does not name ${documented.provider}`,
    );
    if (
      Object.hasOwn(documented.row, "strictTimedOutMs") ||
      Object.hasOwn(documented.row, "fallbackTimedOutMs")
    ) {
      invariant(
        documented.row.strictTimedOutMs === strict[0].timedOutMs &&
          strict[0].buildMs === null &&
          documented.row.fallbackTimedOutMs === fallback[0].timedOutMs &&
          fallback[0].buildMs === null,
        `${project} timeout limits differ from the benchmark artifact`,
      );
    } else {
      invariant(
        documented.row.strictMs === strict[0].buildMs &&
          documented.row.fallbackMs === fallback[0].buildMs,
        `${project} timings differ from the benchmark artifact`,
      );
    }
  }
}

function renderSupport(manifest) {
  const capabilityRows = manifest.providers.map((provider) => [
    code(provider.provider),
    provider.languages.map(code).join(", "),
    code(provider.authority),
    provider.facts.length === 0
      ? "**none**"
      : provider.facts.map(code).join(", "),
    [
      `[upstream](${provider.upstream})`,
      ...provider.childIssues.map(
        (issue) =>
          `[route #${issue.slice(issue.lastIndexOf("/") + 1)}](${issue})`,
      ),
    ].join(" / "),
  ]);
  const lifecycleRows = manifest.providers.map((provider) => [
    code(provider.provider),
    code(provider.mode),
    provider.requirements,
    provider.nativeAnalysis,
    provider.exportMerge,
    provider.reuseResident,
  ]);
  const installRows = manifest.providers.map((provider) => [
    code(provider.provider),
    provider.install,
    provider.installSources
      .map((source) => `[${source.label}](${source.url})`)
      .join(", "),
    provider.commands.map(code).join(", "),
    provider.projectCommandSources?.map(code).join(", ") ?? "—",
    provider.environmentOverrides.map(code).join(", "),
    provider.resolution,
    provider.requirements,
    provider.platforms.map(code).join(", "),
  ]);
  const troubleshootingRows = manifest.providers.map((provider) => [
    provider.languages.map(code).join(", "),
    code(provider.provider),
    provider.limitations,
    provider.decline,
    provider.fallback,
  ]);
  const benchmarkRows = manifest.providers.flatMap((provider) =>
    provider.benchmarks.map((benchmark) => [
      code(benchmark.project),
      code(provider.provider),
      Object.hasOwn(benchmark, "strictTimedOutMs")
        ? `did not finish before ${seconds(benchmark.strictTimedOutMs)} s`
        : milliseconds(benchmark.strictMs),
      Object.hasOwn(benchmark, "fallbackTimedOutMs")
        ? `did not finish before ${seconds(benchmark.fallbackTimedOutMs)} s`
        : milliseconds(benchmark.fallbackMs),
    ]),
  );
  const ordinaryRows = manifest.ordinaryOnly.map((row) => [
    code(row.language),
    code(row.server),
    row.reason,
    `[tracked route](${row.issue})`,
  ]);

  return [
    "### Strict provider support",
    "",
    "_Generated from [`docs/provider-support.json`](https://github.com/samchon/compiler-graph/blob/master/docs/provider-support.json); do not edit this block by hand._",
    "",
    "Strict selection is per registered provider and may decline for missing tools, incompatible options, or incomplete build metadata. Authority grades differ. A provider's `facts` list means it can defend those edge families; it is not a universal-completeness claim. Strict dumps carry provider/tool provenance plus universe, input-manifest, and content digests. The MCP result reports operation coverage and uncertainty, but does not promise #63's future complete producer-owned per-generation coverage contract. Generic language-server and static fallbacks remain valid lower-authority results and are identified as such.",
    "",
    "#### Capability",
    "",
    table(
      ["Provider", "Languages", "Authority", "Defensible facts", "Evidence"],
      capabilityRows,
    ),
    "",
    "#### Lifecycle",
    "",
    `These are current implementation modes, not future route claims. Preparation and native/export/resident phases are stated separately because the [experiment catalog](https://github.com/samchon/compiler-graph/blob/master/tests/experiment/src/catalog.mjs) and [cold measurement artifact](https://github.com/samchon/compiler-graph/blob/master/${manifest.benchmark.artifact}) prove different boundaries; the artifact reports whole end-to-end cells, not isolated phase timings.`,
    "",
    table(
      ["Provider", "Mode", "Preparation", "Native analysis", "Export and merge", "Reuse or resident state"],
      lifecycleRows,
    ),
    "",
    "#### Installation and selection",
    "",
    "The troubleshooting table names the ordinary language-server/static fallback for each row. Resolution metadata is shared with the shipped registry and checked in CI.",
    "",
    table(
      ["Provider", "Install", "Install sources", "Fixed commands", "Project command sources", "Overrides", "Resolution order", "Project preparation", "Platforms"],
      installRows,
    ),
    "",
    "#### Verified cold index cells",
    "",
    `These are exact same-run cold end-to-end strict/strict-disabled pairs from [\`${manifest.benchmark.artifact}\`](https://github.com/samchon/compiler-graph/blob/master/${manifest.benchmark.artifact}), produced by [the pinned workflow run](${manifest.benchmark.workflowRun}). They do not prove warm or semantic-incremental behavior. A zero-fact strict provider is not called semantically complete. Ruby and Dart report only that both whole cells exceeded the 1,800-second guard; that limit is not an isolated producer duration.`,
    "",
    table(
      ["Project", "Strict provider", "Strict cell", "Strict-disabled cell"],
      benchmarkRows,
    ),
    "",
    "#### Troubleshooting",
    "",
    "A strict result's provenance name must equal the provider below. If it is absent, use the commands and overrides in the installation table, then follow the explicit decline reason; the fallback is still usable but does not inherit strict authority.",
    "",
    table(
      ["Languages", "Expected provenance", "Common boundary", "Common decline", "Fallback"],
      troubleshootingRows,
    ),
    "",
    "#### Ordinary-only strict status",
    "",
    "These languages are indexed through their ordinary server and static fallback today. They have no registered strict provider or strict timing claim.",
    "",
    table(
      ["Language", "Ordinary server", "Why no strict provider", "Route"],
      ordinaryRows,
    ),
  ].join("\n");
}

function replaceGeneratedBlock(readme, generated) {
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  invariant(start !== -1 && end !== -1, "README support markers are missing");
  invariant(
    readme.indexOf(startMarker, start + startMarker.length) === -1 &&
      readme.indexOf(endMarker, end + endMarker.length) === -1,
    "README support markers must be unique",
  );
  invariant(start < end, "README support markers are reversed");
  return `${readme.slice(0, start)}${generated}${readme.slice(
    end + endMarker.length,
  )}`;
}

function table(headers, rows) {
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function cell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function code(value) {
  return `\`${value}\``;
}

function milliseconds(value) {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 3,
    minimumFractionDigits: 3,
    useGrouping: true,
  }).format(value)} ms`;
}

function seconds(value) {
  return new Intl.NumberFormat("en-US").format(value / 1_000);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `provider support: cannot read ${path.relative(root, file)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertUrl(value, label) {
  try {
    const url = new URL(value);
    invariant(
      url.protocol === "https:",
      `${label} must be an HTTPS URL`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("provider support:")) {
      throw error;
    }
    throw new Error(`provider support: ${label} is not a valid URL`);
  }
}

function unique(values, label) {
  const rows = new Set(values);
  invariant(rows.size === values.length, `${label} rows must be unique`);
  return [...rows];
}

function equal(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function invariant(condition, message) {
  if (!condition) throw new Error(`provider support: ${message}`);
}
