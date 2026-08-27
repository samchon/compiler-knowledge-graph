import fs from "node:fs";
import path from "node:path";

import { GraphEdgeKind, GraphLanguage } from "../../typings";
import { normalizePath } from "../../utils/normalizePath";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { IGraphProvider } from "../IGraphProvider";
import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { toolchainVersion } from "../toolchainVersion";
import { sidecarProvider } from "../sidecar";

const GO_GRAPH_TOOLS = Object.freeze({
  exporter: Object.freeze({
    command: "samchon-graph-go",
    override: "SAMCHON_GRAPH_GO",
  }),
  toolchain: Object.freeze({
    command: "go",
    override: "SAMCHON_GRAPH_GO_TOOLCHAIN",
  }),
  corroborator: Object.freeze({
    command: "scip-go",
    override: "SAMCHON_GRAPH_SCIP_GO",
  }),
});

const GO_GRAPH_RESOLUTION = Object.freeze({
  commands: Object.freeze(
    Object.values(GO_GRAPH_TOOLS).map((tool) => tool.command),
  ),
  environmentOverrides: Object.freeze(
    Object.values(GO_GRAPH_TOOLS).map((tool) => tool.override),
  ),
}) satisfies IGraphProvider.IResolution;

function goIndexArgs(artifact: string): string[] {
  return [`--output=${artifact}`];
}

function goInputs(root: string): string[] {
  const inputs = providerInputFiles(
    root,
    ["go"],
    GO_BUILD_FILE_NAMES,
    GO_AUXILIARY_EXTENSIONS,
  );
  return mergeInputs(
    inputs,
    vendorInputs(root),
    embeddedInputs(root, inputs),
  );
}

/** Compiler-owned Go workspace snapshots enriched through go/packages. */
export const goGraphProvider = Object.assign(
  sidecarProvider({
    name: "samchon-graph-go",
    languages: ["go"],
    authority: "compiler",
    facts: [
      "contains",
      "exports",
      "imports",
      "calls",
      "accesses",
      "instantiates",
      "type_ref",
      "implements",
      "dispatches",
      "tests",
      "references",
    ] satisfies readonly GraphEdgeKind[],
    resolution: GO_GRAPH_RESOLUTION,
    buildInputs: goBuildInputs,
    resolve: resolveGoGraphCommand,
    indexArgs: goIndexArgs,
    inputs: goInputs,
    configuration: goProviderConfigurationDerivation,
  }),
  {
    indexArgs: goIndexArgs,
    inputs: goInputs,
    providerConfiguration: goProviderConfiguration,
    effectiveConfiguration: goConfiguration,
  },
);

function goProviderConfiguration(
  root: string,
  _languages?: readonly GraphLanguage[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return goConfiguration(root, env);
}

function goProviderConfigurationDerivation(
  root: string,
  _languages?: readonly GraphLanguage[],
  env: NodeJS.ProcessEnv = process.env,
): toolchainVersion.IDerivation {
  return goConfigurationDerivation(root, env);
}

function resolveGoGraphCommand(
  root: string,
  env: NodeJS.ProcessEnv,
): IGraphProvider.ICommand | undefined {
  const installed = resolveProviderCommand(root, env, {
    ...GO_GRAPH_TOOLS.exporter,
  });
  if (installed !== undefined) {
    return spawnableCommand.append(
      { ...installed, args: [...installed.args] },
      ["--project", path.resolve(root)],
    );
  }
  const source = path.resolve(__dirname, "..", "..", "..", "sidecars", "go");
  if (!fs.existsSync(path.join(source, "go.mod"))) return undefined;
  const go = resolveProviderCommand(root, env, {
    ...GO_GRAPH_TOOLS.toolchain,
  });
  return go === undefined
    ? undefined
    : spawnableCommand.append(
        { ...go, args: [...go.args] },
        [
          "-C",
          source,
          "run",
          ".",
          "--project",
          path.resolve(root),
        ],
      );
}

function goBuildInputs(root: string): string[] {
  const sources = providerInputFiles(root, ["go"], []);
  return mergeInputs(
    providerInputFiles(
      root,
      [],
      GO_BUILD_FILE_NAMES,
      GO_AUXILIARY_EXTENSIONS,
    ),
    vendorInputs(root),
    embeddedInputs(root, sources),
  );
}

function embeddedInputs(root: string, inputs: readonly string[]): string[] {
  const resolved = path.resolve(root);
  const directories = new Set<string>();
  for (const input of inputs) {
    if (path.extname(input).toLowerCase() !== ".go") continue;
    const absolute = path.resolve(resolved, input);
    let body: string;
    try {
      body = fs.readFileSync(absolute, "utf8");
      /* c8 ignore start -- an input disappearing between the source walk and
       * this read is detected by the enclosing generation transaction. */
    } catch {
      continue;
    }
    /* c8 ignore stop */
    const packageRoot = path.dirname(absolute);
    const directives =
      body.match(/^[\t ]*\/\/go:embed[\t ]+.+$/gm) ?? [];
    for (const directive of directives) {
      const patterns = directive
        .replace(/^[\t ]*\/\/go:embed[\t ]+/, "")
        .trim()
        .split(/\s+/);
      for (const pattern of patterns) {
        const prefix = /^(?:all:)?["`]?(?!\.\.(?:\/|$))([A-Za-z0-9_.-]+)\//.exec(
          pattern,
        );
        directories.add(
          prefix === null
            ? packageRoot
            : path.join(packageRoot, prefix[1]!),
        );
      }
    }
  }
  return [...directories]
    .flatMap((directory) => allRegularFiles(directory))
    .filter((file) => path.extname(file).toLowerCase() !== ".go")
    .map((file) => normalizePath(path.relative(resolved, file)));
}

function mergeInputs(...groups: (readonly string[])[]): string[] {
  return [...new Set(groups.flat())].sort(compareOrdinal);
}

function vendorInputs(root: string): string[] {
  const resolved = path.resolve(root);
  const moduleRoots = [
    ...new Set([
      resolved,
      ...providerInputFiles(root, [], ["go.mod"]).map((file) =>
        path.dirname(path.resolve(resolved, file)),
      ),
    ]),
  ];
  const modules = moduleRoots
    .map((directory) => path.join(directory, "vendor"))
    .filter(
      (directory) =>
        fs.existsSync(directory) && fs.statSync(directory).isDirectory(),
    )
    .flatMap((directory) =>
      allRegularFiles(directory).map((file) =>
        normalizePath(path.relative(resolved, path.resolve(directory, file))),
      ),
    );
  return [...new Set(modules)].sort(compareOrdinal);
}

function allRegularFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== ".git") visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  };
  visit(root);
  return output;
}

function compareOrdinal(left: string, right: string): number {
  // Two-way: input sets contain distinct normalized paths, so the equal arm
  // cannot run, and an ignore directive over it would take the two reachable
  // arms out of the coverage gate with it -- which is how a reversed ordering
  // stops being a failing test.
  return left < right ? -1 : 1;
}

function goConfiguration(
  root: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [...goConfigurationDerivation(root, env).rows];
}

function goConfigurationDerivation(
  root: string,
  env: NodeJS.ProcessEnv,
): toolchainVersion.IDerivation {
  const rows = GO_ENVIRONMENT_KEYS.map((key) => `${key}=${env[key] ?? ""}`);
  return toolchainVersion.derive([
    ...rows,
    // Through the shared probe like every other row. Its own `spawnSync` here
    // reported `go-env=unavailable` for any failure, and since a non-serving
    // candidate's configuration is part of the resident topology snapshot, one
    // transient launch failure moved that snapshot and rebuilt every language.
    toolchainVersion.observe({
      root,
      env,
      ...GO_GRAPH_TOOLS.toolchain,
      args: ["env", "-json", ...GO_PROBED_ENVIRONMENT_KEYS],
      label: "go-env",
    }),
    toolObservation(
      root,
      env,
      GO_GRAPH_TOOLS.corroborator.command,
      GO_GRAPH_TOOLS.corroborator.override,
      ["--version"],
    ),
  ]);
}

function toolObservation(
  root: string,
  env: NodeJS.ProcessEnv,
  command: string,
  override: string,
  args: readonly string[],
): toolchainVersion.IObservation {
  return toolchainVersion.observe({
    root,
    env,
    command,
    override,
    args,
  });
}

const GO_BUILD_FILE_NAMES: readonly string[] = [
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
];

// Files the Go command accepts beside .go sources. They can alter cgo types,
// assembly linkage, generated SWIG declarations, or the selected object file
// without changing one byte in a .go file.
const GO_AUXILIARY_EXTENSIONS: readonly string[] = [
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".f",
  ".for",
  ".f90",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".m",
  ".s",
  ".sx",
  ".swig",
  ".swigcxx",
  ".syso",
];

const GO_ENVIRONMENT_KEYS: readonly string[] = [
  "CGO_ENABLED",
  "CGO_CFLAGS",
  "CGO_CPPFLAGS",
  "CGO_CXXFLAGS",
  "CGO_FFLAGS",
  "CGO_LDFLAGS",
  "CC",
  "CXX",
  "FC",
  "GO111MODULE",
  "GOARCH",
  "GO386",
  "GOAMD64",
  "GOARM",
  "GOARM64",
  "GOENV",
  "GODEBUG",
  "GOEXPERIMENT",
  "GOFIPS140",
  "GOFLAGS",
  "GONOPROXY",
  "GONOSUMDB",
  "GOOS",
  "GOMIPS",
  "GOMIPS64",
  "GOPPC64",
  "GORISCV64",
  "GOWASM",
  "GOPATH",
  "GOPRIVATE",
  "GOPROXY",
  "GOSUMDB",
  "GOTOOLCHAIN",
  "GOWORK",
  "PATH",
  GO_GRAPH_TOOLS.corroborator.override,
  GO_GRAPH_TOOLS.toolchain.override,
  "PKG_CONFIG",
];

const GO_PROBED_ENVIRONMENT_KEYS: readonly string[] = [
  "GOVERSION",
  "GOOS",
  "GOARCH",
  "CGO_ENABLED",
  "CGO_CFLAGS",
  "CGO_CPPFLAGS",
  "CGO_CXXFLAGS",
  "CGO_FFLAGS",
  "CGO_LDFLAGS",
  "CC",
  "CXX",
  "FC",
  "GO111MODULE",
  "GOFLAGS",
  "GO386",
  "GOAMD64",
  "GOARM",
  "GOARM64",
  "GOWORK",
  "GOENV",
  "GODEBUG",
  "GOEXPERIMENT",
  "GOFIPS140",
  "GOMIPS",
  "GOMIPS64",
  "GOPPC64",
  "GORISCV64",
  "GOWASM",
  "GOTOOLCHAIN",
  "GOPROXY",
  "GOPRIVATE",
  "PKG_CONFIG",
];
