import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dartPackageConfigInputs } from "../../indexer/dartPackageConfigInputs";
import { languageOf } from "../../indexer/languageOf";
import { GraphEdgeKind, GraphLanguage } from "../../typings";
import { BoundedMap } from "../../utils/BoundedMap";
import { spawnableCommand } from "../../utils/spawnableCommand";
import { IGraphProvider } from "../IGraphProvider";
import { providerInputFiles } from "../providerInputFiles";
import { resolveProviderCommand } from "../resolveProviderCommand";
import { toolchainVersion } from "../toolchainVersion";
import { scipProvider } from "./scipProvider";

const clangScipProvider = createScipProvider({
  name: "scip-clang",
  // scip-clang 0.4.0 writes occurrence range/symbol/roles only. Its
  // SymbolInformation never sets enclosing_symbol, and its relationships set
  // implementation/reference flags but never is_type_definition. None of
  // those fields can ground the common adapter's three edge families.
  omitFacts: ["contains", "references", "type_ref"],
  // Not `clang`. scip-clang carries its own Clang and needs an external driver
  // only for CUDA; requiring one declined every project built with GCC or MSVC
  // even though its compilation database was exactly what the indexer consumes.
  // What the index means is decided by the driver each translation unit was
  // actually compiled with, and the database records that per entry.
  toolchain: { label: "cc", fromProject: compilationDatabaseCompilers },
  languages: ["c", "cpp"],
  command: "scip-clang",
  override: "SAMCHON_GRAPH_SCIP_CLANG",
  buildFiles: [
    "compile_commands.json",
    "CMakeLists.txt",
    "CMakePresets.json",
    "Makefile",
    "meson.build",
  ],
  // `.h`, `.inc`, and extensionless include documents can be accepted from a
  // C++-only SCIP artifact, so resident freshness has to watch the same
  // identities even when the C registry is not part of the selected slice.
  buildExtensions: [".cmake", ".h", ".inc", ""],
  // scip-clang 0.4.0 writes `CPP` into every SCIP document, with an upstream
  // FIXME to detect the language. Trusting it makes a C-only session discard
  // every `.c` document as foreign C++ even though the path identifies it.
  preferFileLanguage: true,
  // Build output directories stay out of the ordinary source walk, but this is
  // the exact generated file scip-clang consumes. Without declaring it
  // separately, editing build/compile_commands.json leaves a resident session
  // on the old universe even though the next producer run would read the new
  // database.
  derivedInputs: compilationDatabaseInputs,
  validateConfiguration: (_root, configuration) => {
    if (
      configuration
        .slice(2)
        .some((row) => row.endsWith("=unavailable"))
    ) {
      throw new Error(
        "scip-clang: the current compilation database is invalid or names an unavailable compiler command",
      );
    }
  },
  resolveArgs: (root) => {
    const compdb = compilationDatabase(root);
    return compdb === undefined ? undefined : [`--compdb-path=${compdb}`];
  },
  indexArgs: (artifact) => [
    `--index-output-path=${artifact}`,
    `--temporary-output-dir=${path.join(path.dirname(artifact), "clang")}`,
  ],
});

const jvmScipProvider = createScipProvider({
  name: "scip-java",
  // scip-java 0.13.1 sets enclosing ranges in both the javac and kotlinc
  // producers and enclosing_symbol for javac locals, but no producer sets a
  // type-definition relationship.
  omitFacts: ["type_ref"],
  toolchain: {
    label: "java",
    aliases: ["java"],
    override: "SAMCHON_GRAPH_JAVA_TOOLCHAIN",
  },
  // Upstream calls this a Java and Kotlin indexer and ships only javac and
  // kotlinc producers. Claiming Scala made an installed scip-java displace the
  // Scala language-server lane with a tool that cannot index the language.
  languages: ["java", "kotlin"],
  command: "scip-java",
  override: "SAMCHON_GRAPH_SCIP_JAVA",
  buildFiles: [
    ".mvn/extensions.xml",
    ".mvn/jvm.config",
    ".mvn/maven.config",
    ".mvn/wrapper/MavenWrapperDownloader.java",
    ".mvn/wrapper/maven-wrapper.jar",
    ".mvn/wrapper/maven-wrapper.properties",
    "pom.xml",
    "mvnw",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "gradle.lockfile",
    "gradle/wrapper/gradle-wrapper.properties",
    "gradle/verification-metadata.xml",
    "gradle/wrapper/gradle-wrapper.jar",
    "gradlew",
    "libs.versions.toml",
  ],
  buildExtensions: [".gradle", ".gradle.kts"],
  // scip-java's injected Gradle tasks are not compatible with a project's
  // configuration cache in the released producer. The build command after
  // `--` replaces its defaults, so retain those exact tasks while disabling
  // only the cache for this isolated indexing build. Maven must keep its own
  // default command; choosing by the root is therefore part of the provider
  // contract rather than a fixture-specific Gradle property change.
  indexArgs: jvmScipIndexArgs,
  // Java is both the runtime that launches scip-java and the compiler for a
  // Java-only slice. It is not Kotlin's compiler. Until the producer exposes
  // the Kotlin compiler revision it drove, a Kotlin-containing slice leaves
  // the compiler field empty instead of misnaming the JVM.
  compilerVersion: (languages, configuration) =>
    languages.includes("kotlin")
      ? ""
      : standardCompilerVersion("scip-java", configuration),
});

function jvmScipIndexArgs(artifact: string, root: string): string[] {
  const output = ["index", "--output", artifact];
  const gradle = [
    "settings.gradle",
    "settings.gradle.kts",
    "gradlew",
    "build.gradle",
    "build.gradle.kts",
  ].some((file) =>
    fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile(),
  );
  return gradle
    ? [
        ...output,
        "--",
        "--no-configuration-cache",
        "clean",
        "scipPrintDependencies",
        "scipCompileAll",
      ]
    : output;
}

const dotnetScipProvider = createScipProvider({
  name: "scip-dotnet",
  // scip-dotnet 0.2.14 emits semantic declarations, but its occurrences carry
  // no enclosing_range and its SymbolInformation carries neither
  // enclosing_symbol nor type-definition relationships. The common adapter
  // therefore cannot ground an origin for references or derive the other two
  // families without guessing from C# syntax.
  omitFacts: ["contains", "references", "type_ref"],
  toolchain: {
    label: "dotnet",
    aliases: ["dotnet"],
    override: "SAMCHON_GRAPH_DOTNET_TOOLCHAIN",
  },
  languages: ["csharp"],
  command: "scip-dotnet",
  override: "SAMCHON_GRAPH_SCIP_DOTNET",
  buildFiles: [
    "global.json",
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "packages.lock.json",
    "nuget.config",
  ],
  buildExtensions: [".sln", ".csproj", ".fsproj", ".props", ".targets"],
  indexArgs: (artifact) => ["index", "--output", artifact],
});

const pythonScipProvider = createScipProvider({
  name: "scip-python",
  // scip-python 0.6.6 never populates `SymbolInformation.enclosing_symbol`.
  // Every construction site in the published bundle passes `symbol`,
  // `documentation` and `relationships` only, and the field appears nowhere but
  // the generated protobuf accessors. `contains` is derived from exactly that
  // field, so claiming the family told a consumer containment was proven and
  // left it to read the absence as a project with no structure rather than an
  // indexer that cannot describe one.
  // The same bundle's only relationships are implementation relationships;
  // it never sets Relationship.is_type_definition.
  omitFacts: ["contains", "type_ref"],
  // `python3` is not the command a Windows Python answers to. The python.org
  // installer creates `python.exe` and `py.exe`; only the Microsoft Store build
  // creates `python3.exe`, so requiring the one spelling declined the strict
  // lane on most Windows machines that had a working interpreter.
  toolchain: {
    label: "python3",
    aliases: ["python3", "python", "py"],
    override: "SAMCHON_GRAPH_PYTHON_TOOLCHAIN",
  },
  languages: ["python"],
  command: "scip-python",
  override: "SAMCHON_GRAPH_SCIP_PYTHON",
  buildFiles: [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "Pipfile.lock",
    "poetry.lock",
    "uv.lock",
    "pyrightconfig.json",
  ],
  resolveArgs: (root) => [
    "index",
    ".",
    "--project-name",
    path.basename(root),
  ],
  indexArgs: (artifact) => ["--output", artifact],
});

const rubyScipProvider = createScipProvider({
  name: "scip-ruby",
  // scip-ruby 0.4.7 sets range/symbol/roles on occurrences, but no enclosing
  // range, enclosing symbol, or type-definition relationship.
  omitFacts: ["contains", "references", "type_ref"],
  toolchain: {
    label: "ruby",
    aliases: ["ruby"],
    override: "SAMCHON_GRAPH_RUBY_TOOLCHAIN",
  },
  languages: ["ruby"],
  command: "scip-ruby",
  override: "SAMCHON_GRAPH_SCIP_RUBY",
  buildFiles: [
    "Gemfile",
    "Gemfile.lock",
    ".ruby-version",
    "sorbet/config",
  ],
  buildExtensions: [".gemspec"],
  indexArgs: rubyScipIndexArgs,
});

/**
 * Dart, which used to be registered as a sidecar that was never written.
 *
 * `samchon-graph-dart` named a program that does not exist anywhere in this
 * repository — `sidecars/` holds exactly one directory, `go` — so every Dart
 * build fell through to the language-server lane, which exceeded an hour on a
 * mid-sized package twice over. A real indexer for the language has existed on
 * pub.dev the whole time. The entry was not unfinished work; it was the wrong
 * architecture.
 *
 * `--output` despite the published docs listing no such flag: `bin/scip_dart.dart`
 * declares it (`addOption('output', abbr: 'o', defaultsTo: 'index.scip')`). The
 * source settles what a summary could not, which is the same reason the CLI
 * contracts of every other entry here were read out of their upstream sources
 * rather than their READMEs.
 */
const dartScipProvider = createScipProvider({
  name: "scip-dart",
  // scip-dart 1.6.2 constructs occurrences without enclosing ranges and emits
  // only implementation/reference relationships on symbols.
  omitFacts: ["contains", "references", "type_ref"],
  toolchain: {
    label: "dart",
    aliases: ["dart"],
    override: "SAMCHON_GRAPH_DART_TOOLCHAIN",
  },
  languages: ["dart"],
  command: "scip_dart",
  override: "SAMCHON_GRAPH_SCIP_DART",
  buildFiles: ["pubspec.yaml", "pubspec.lock", "analysis_options.yaml"],
  derivedInputs: dartPackageConfigInputs,
  indexArgs: (artifact) => ["--output", artifact, "."],
});

/**
 * PHP, whose indexer cannot be told where to put its own output.
 *
 * `bin/scip-php` declares exactly two options, `--help` and `--memory-limit`.
 * It takes `getcwd()` as the project root and ends with
 * `file_put_contents('index.scip', …)`, so it writes into the tree it is
 * indexing and there is no flag to say otherwise. `artifactFrom` names that
 * path and the session moves the file out before anything reads it — which is
 * why this needed a mechanism rather than a registry line, and why it arrived
 * after dart despite both having had a real indexer all along.
 *
 * Composer, and inside the project rather than beside it. Its instructions are
 * `composer require --dev` followed by `vendor/bin/scip-php`, and current main
 * explicitly falls back to the analyzed project's `cwd/vendor` when Composer
 * has flattened the package dependencies there. The latest v0.0.2 tag predates
 * that upstream fix, so a fixture using the documented arrangement has to pin
 * a revision that contains it.
 *
 * That is why `resolveProviderCommand` looks in `vendor/bin`: for this
 * ecosystem, an indexer installed into the project is the expected arrangement
 * and a global copy is the unusual one.
 */
const phpScipProvider = createScipProvider({
  name: "scip-php",
  // scip-php 0.0.2 writes only range/symbol/roles for occurrences and symbol
  // metadata without any of the common adapter's grounding fields.
  omitFacts: ["contains", "references", "type_ref"],
  toolchain: {
    label: "php",
    aliases: ["php"],
    override: "SAMCHON_GRAPH_PHP_TOOLCHAIN",
  },
  languages: ["php"],
  command: "scip-php",
  override: "SAMCHON_GRAPH_SCIP_PHP",
  buildFiles: [
    "composer.json",
    "composer.lock",
    "phpstan.neon",
    "phpstan.neon.dist",
  ],
  // The CLI has no version flag: its only options are `--help` and
  // `--memory-limit`. Invoking the conventional `--version` does not fail; it
  // performs a full index and writes `index.scip`, so a probe would mutate the
  // project before the guarded build even starts. Composer's pinned package
  // metadata is the stable identity when present, and `unreported` is the
  // honest answer for a global binary or the package's own checkout.
  producerConfiguration: phpProducerConfiguration,
  indexArgs: () => [],
  artifactFrom: (root) => path.join(root, "index.scip"),
});

/** Standard SCIP producers in deterministic registry order. */
export const standardScipProviders: readonly IGraphProvider[] = [
  clangScipProvider,
  jvmScipProvider,
  dotnetScipProvider,
  pythonScipProvider,
  rubyScipProvider,
  dartScipProvider,
  phpScipProvider,
];

interface IStandardScipProvider {
  name: string;

  /** Fact families this indexer provably does not emit. */
  omitFacts: readonly GraphEdgeKind[];
  languages: readonly GraphLanguage[];
  command: string;
  override: string;
  buildFiles: readonly string[];
  buildExtensions?: readonly string[];

  /**
   * Build inputs that are not a filename pattern but a fact about the project.
   *
   * Dart's resolved dependency set lives in `.dart_tool/package_config.json`,
   * which `pub get` writes and no glob over the tracked tree would find. Leaving
   * it out would let a changed dependency graph produce the same universe, so a
   * project that resolved differently would serve an index built against the
   * packages it used to have.
   */
  derivedInputs?: (root: string) => readonly string[];
  validateConfiguration?: (
    root: string,
    configuration: readonly string[],
  ) => void;
  preferFileLanguage?: boolean;
  resolveArgs?: (root: string) => readonly string[] | undefined;
  indexArgs: (artifact: string, root: string) => string[];

  /** Select the compiler row this language slice can honestly publish. */
  compilerVersion?: (
    languages: readonly GraphLanguage[],
    configuration: readonly string[],
  ) => string;

  /**
   * Derive the producer's configuration row without assuming `--version`.
   *
   * Most indexers implement that conventional flag. scip-php does not, and
   * treating an unsupported flag as a harmless probe runs the indexer.
   */
  producerConfiguration?: (
    root: string,
    env: NodeJS.ProcessEnv,
    attempt: resolveProviderCommand.IAttempt,
  ) => toolchainVersion.IObservation;

  /** Where a producer that takes no output flag writes, relative to the root. */
  artifactFrom?: (root: string) => string;

  /**
   * The toolchain whose semantics this index describes.
   *
   * A `semantic-index` provider still answers "which language version resolved
   * these facts", and it is not the indexer's own version: scip-python 0.6.6
   * says what built the artifact, while the interpreter it inferred the
   * environment from says what the artifact means. A consumer that cannot tell
   * them apart cannot know whether a rebuilt index describes the same program.
   */
  toolchain: IToolchain;
}

/**
 * How to find the programs whose versions say what an index means.
 *
 * Two shapes, because two different questions were being answered by one
 * hard-coded command name.
 *
 * `aliases` is one program with more than one spelling. Which spelling exists
 * is a property of the machine — a Windows Python answers to `python` or `py`
 * and usually not to `python3` — so the first that resolves is the program, and
 * the row names the spelling that answered.
 *
 * `fromProject` is a set of programs the project itself names. A compilation
 * database records the driver each translation unit was compiled with, and that
 * is the compiler whose semantics the index carries; it may be `gcc`, `cl.exe`,
 * or several at once, and no fixed name can stand in for it.
 */
type IToolchain =
  | {
      aliases: readonly string[];
      fromProject?: never;

      /** Absolute development build selected for this one alias family. */
      override?: string;

      /** What the row calls this toolchain when nothing resolved. */
      label: string;
    }
  | {
      aliases?: never;
      fromProject: (root: string) => readonly string[];
      override?: never;

      /** What the rows call this toolchain when the project names none. */
      label: string;
    };

/** One deduplicated, ordinally sorted input list, derived entries included. */
function withDerived(
  found: readonly string[],
  derived: readonly string[] | undefined,
): string[] {
  if (derived === undefined || derived.length === 0) return [...found];
  return [...new Set([...found, ...derived])].sort(compareInputPath);
}

function compareInputPath(left: string, right: string): number {
  /* c8 ignore next 2 -- merged input identities are distinct set members. */
  return left < right ? -1 : left > right ? 1 : 0;
}

function createScipProvider(
  props: IStandardScipProvider,
): IGraphProvider {
  const validateConfiguration = props.validateConfiguration;
  const producerConfiguration = props.producerConfiguration;
  return scipProvider({
    name: props.name,
    languages: props.languages,
    authority: "semantic-index",
    omitFacts: props.omitFacts,
    ...(props.preferFileLanguage === undefined
      ? {}
      : { preferFileLanguage: props.preferFileLanguage }),
    buildInputs: (root) =>
      withDerived(
        providerInputFiles(root, [], props.buildFiles, props.buildExtensions),
        props.derivedInputs?.(root),
      ),
    resolve: (root, env) => {
      const indexer = resolveProviderCommand(root, env, {
        command: props.command,
        override: props.override,
      });
      const decoder = resolveScipDecoder(root, env);
      // The toolchain is required, not merely reported. A snapshot states which
      // language version resolved its facts, and a provider that cannot answer
      // that would publish `unavailable` into the field a consumer degrades
      // against — which is worse than declining, because a fallback at least
      // says so. `rust-analyzer-scip` refuses without `rustc` and `cargo` for
      // the same reason.
      //
      // What has to resolve is the toolchain the project actually uses, not one
      // chosen name for it. Requiring `clang` declined every GCC or MSVC project
      // whose compilation database scip-clang would have consumed, and requiring
      // `python3` declined a Windows interpreter installed as `python`.
      const toolchain = resolveToolchain(root, env, props.toolchain);
      const resolvedArgs = props.resolveArgs?.(root);
      if (
        indexer === undefined ||
        decoder === undefined ||
        toolchain.some((tool) => tool.resolved === undefined) ||
        (props.resolveArgs !== undefined && resolvedArgs === undefined)
      ) {
        return undefined;
      }
      const args = resolvedArgs ?? [];
      return spawnableCommand.append(
        { ...indexer, args: [...indexer.args] },
        args,
      );
    },
    decode: (root) => {
      const decoder = resolveScipDecoder(root, process.env);
      if (decoder === undefined) {
        throw new Error(
          `${props.name}: the SCIP decoder disappeared after provider selection`,
        );
      }
      return spawnableCommand.append(
        { ...decoder, args: [...decoder.args] },
        ["print", "--json"],
      );
    },
    indexArgs: props.indexArgs,
    ...(props.artifactFrom === undefined
      ? {}
      : { artifactFrom: props.artifactFrom }),
    inputs: (root, languages) =>
      withDerived(
        providerInputFiles(
          root,
          languages,
          props.buildFiles,
          props.buildExtensions,
        ),
        props.derivedInputs?.(root),
      ),
    ...(validateConfiguration === undefined
      ? {}
      : {
          validateConfiguration: (
            root,
            _languages,
            configuration,
          ) => validateConfiguration(root, configuration),
        }),
    configuration: (root, _languages, env = process.env) => {
      const producerRow =
        producerConfiguration === undefined
          ? toolVersion(root, env, props.command, props.override)
          : producerConfiguration(
              root,
              env,
              resolveProviderCommand.attempt(root, env, {
                command: props.command,
                override: props.override,
              }),
            );
      return toolchainVersion.derive([
        producerRow,
        toolVersion(root, env, "scip", "SAMCHON_GRAPH_SCIP"),
        ...toolchainVersions(root, env, props.toolchain),
      ]);
    },
    // Selected from the configuration rather than re-derived, so the
    // published compiler is the one this universe was computed from. Labelled
    // rather than positional: the indexer and the decoder are named exactly,
    // and whatever remains is the toolchain.
    compilerVersion: (_root, selectedLanguages, configuration) =>
      props.compilerVersion?.(selectedLanguages, configuration) ??
      standardCompilerVersion(props.command, configuration),
    sourceText: true,
    languageOf,
  });
}

/**
 * Invoke scip-ruby with explicit package identity only when none is declared.
 *
 * The producer documents `--gem-metadata` for repositories without a
 * `Gemfile.lock` or gemspec. Omitting it makes that supported project shape
 * fail before indexing, which is exactly what the upstream config-only fixture
 * exposed. A declared package keeps the producer's native inference.
 */
function rubyScipIndexArgs(artifact: string, root: string): string[] {
  const args = [".", "--index-file", artifact];
  const declared =
    fs.statSync(path.join(root, "Gemfile.lock"), {
      throwIfNoEntry: false,
    })?.isFile() === true ||
    fs
      .readdirSync(root, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(".gemspec"));
  if (declared) return args;
  const inferred =
    path
      .basename(root)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  return [...args, "--gem-metadata", `${inferred}@workspace`];
}

/**
 * Identify scip-php from the Composer lock that installed it.
 *
 * The lock is already a declared build input. Including both its version and
 * immutable source reference distinguishes two commits published under the
 * same development version without executing the indexer as a probe.
 */
function phpProducerConfiguration(
  root: string,
  _env: NodeJS.ProcessEnv,
  attempt: resolveProviderCommand.IAttempt,
): toolchainVersion.IObservation {
  const label = "scip-php";
  if (!attempt.asked) return toolchainVersion.unasked(label);
  const executable = attempt.executable;
  if (executable === undefined) {
    return toolchainVersion.conclusive(`${label}=unavailable`);
  }
  // A Composer lock identifies only the project-local binary that Composer
  // installed. An override, private development build, npm shim, or PATH binary
  // may be different bytes even when this checkout happens to contain a lock;
  // attributing the lock's commit to it would make the build universe lie.
  if (!isComposerScipPhp(root, executable)) {
    return phpExecutableConfiguration(label, executable);
  }
  try {
    const lock = JSON.parse(
      fs.readFileSync(path.join(root, "composer.lock"), "utf8"),
    ) as {
      packages?: unknown;
      "packages-dev"?: unknown;
    };
    const packages = [
      ...(Array.isArray(lock.packages) ? lock.packages : []),
      ...(Array.isArray(lock["packages-dev"]) ? lock["packages-dev"] : []),
    ];
    const installed = packages.find(
      (entry): entry is {
        name: string;
        version?: unknown;
        source?: { reference?: unknown };
      } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { name?: unknown }).name === "davidrjenni/scip-php",
    );
    if (installed === undefined) {
      return toolchainVersion.conclusive(`${label}=unreported`);
    }
    const version =
      typeof installed.version === "string" && installed.version.trim() !== ""
        ? installed.version.trim()
        : "unreported";
    const reference =
      typeof installed.source?.reference === "string" &&
      installed.source.reference.trim() !== ""
        ? `@${installed.source.reference.trim()}`
        : "";
    return toolchainVersion.conclusive(
      `${label}=${version}${reference}`,
    );
  } catch {
    return toolchainVersion.conclusive(`${label}=unreported`);
  }
}

/**
 * Identify an executable that has no safe version command.
 *
 * Both the selected path and its bytes decide the program: two equal wrappers
 * in different installations can target different dependency trees, while an
 * in-place replacement keeps the path and changes the implementation. Hashing
 * both avoids publishing a machine path while still moving the build universe
 * for either change. A read that cannot complete is inconclusive, not evidence
 * that the resolved binary has no identity.
 */
function phpExecutableConfiguration(
  label: string,
  executable: string,
): toolchainVersion.IObservation {
  try {
    const selected = path.resolve(executable);
    const digest = createHash("sha256")
      .update(selected, "utf8")
      .update("\0", "utf8")
      .update(fs.readFileSync(selected))
      .digest("hex");
    return toolchainVersion.conclusive(`${label}=sha256:${digest}`);
    /* c8 ignore start -- resolution stat'd this exact regular file immediately
     * before the callback; only a synchronous removal or permission race can
     * make this read fail, and no deterministic cross-platform fixture can
     * enter between those two calls. */
  } catch {
    return toolchainVersion.unasked(label);
  }
  /* c8 ignore stop */
}

function isComposerScipPhp(
  root: string,
  executable: string,
): boolean {
  const vendorBin = path.resolve(root, "vendor", "bin");
  const relative = path.relative(vendorBin, path.resolve(executable));
  return (
    path.dirname(relative) === "." &&
    /^scip-php(?:\.(?:exe|cmd|bat))?$/i.test(path.basename(relative))
  );
}

function standardCompilerVersion(
  indexer: string,
  configuration: readonly string[],
): string {
  return configuration
    .filter((row) => {
      const label = row.slice(0, Math.max(0, row.indexOf("=")));
      return label !== indexer && label !== "scip";
    })
    .join("; ");
}

/**
 * Every program the toolchain names, carrying both answers and non-answers.
 *
 * An `aliases` toolchain stops at the first spelling that resolves, because the
 * alternatives are one program; if none resolves, its one entry records whether
 * every lookup actually ran. A `fromProject` toolchain keeps one entry for every
 * driver the project named, including an absent or unasked one, because omitting
 * one compiler would publish only part of the program's semantic identity.
 */
function resolveToolchain(
  root: string,
  env: NodeJS.ProcessEnv,
  toolchain: IToolchain,
): IToolchainTool[] {
  if (toolchain.aliases !== undefined) {
    const triedAliases = new Set<string>();
    let aliasesAsked = true;
    // The override selects one absolute program, so it is consulted once under
    // the toolchain's own label. Offering it to each alias in turn would make
    // the first spelling always resolve, and the row would name `python3` for a
    // binary the developer pointed at deliberately.
    //
    // Consulted, not obeyed: `resolveProviderCommand` rejects an override that
    // no longer points at a program and then continues its ordinary search, so
    // a stale one resolves to whatever the label finds anyway. The aliases
    // below then only run on a machine where that spelling is absent too.
    if (
      toolchain.override !== undefined &&
      env[toolchain.override] !== undefined
    ) {
      const overridden = resolved(root, env, {
        command: toolchain.label,
        identity: `toolchain:${toolchain.label}`,
        override: toolchain.override,
      });
      triedAliases.add(toolchain.label);
      aliasesAsked &&= overridden.asked;
      if (overridden.resolved !== undefined) return [overridden];
    }
    for (const command of toolchain.aliases) {
      if (triedAliases.has(command)) continue;
      const alias = resolved(root, env, {
        command,
        identity: `toolchain:${toolchain.label}`,
      });
      aliasesAsked &&= alias.asked;
      if (alias.resolved !== undefined) return [alias];
    }
    return [
      {
        command: toolchain.label,
        identity: `toolchain:${toolchain.label}`,
        label: toolchain.label,
        asked: aliasesAsked,
      },
    ];
  }
  const namedTools = toolchain.fromProject(root);
  if (namedTools.length === 0) {
    return [
      {
        command: toolchain.label,
        identity: `toolchain:${toolchain.label}`,
        label: toolchain.label,
        asked: true,
      },
    ];
  }
  return namedTools.map((named) => {
    // An absolute driver is probed exactly as recorded. The build named that
    // file, and another program of the same basename on this machine's `PATH`
    // is not the one those translation units were compiled with.
    return resolved(
      root,
      env,
      path.isAbsolute(named)
        ? {
            command: named,
            identity: driverIdentity(named),
            label: driverLabel(named),
            executable: named,
          }
        : {
            command: named,
            identity: driverIdentity(named),
            label: driverLabel(named),
          },
    );
  });
}

/**
 * Resolve one candidate and carry the answer, rather than asking twice.
 *
 * Deciding whether a toolchain exists and then reading its version used to be
 * two independent resolutions of the same name, and on Windows a resolution
 * that misses the project's own bin is a `where.exe` launch. Every extra launch
 * is another chance for a hiccup to report an installed tool as absent, which
 * moves a build universe that nothing about the project moved.
 */
function resolved(
  root: string,
  env: NodeJS.ProcessEnv,
  tool: Omit<IToolchainTool, "asked">,
): IToolchainTool {
  const attempt = toolchainVersion.attempt({
    root,
    env,
    args: VERSION_ARGS,
    ...tool,
  });
  return {
    ...tool,
    asked: attempt.asked,
    ...(attempt.command === undefined ? {} : { resolved: attempt.command }),
  };
}

function toolchainVersions(
  root: string,
  env: NodeJS.ProcessEnv,
  toolchain: IToolchain,
): toolchainVersion.IObservation[] {
  const tools = resolveToolchain(root, env, toolchain);
  return tools.map((tool) => {
    const label = tool.label ?? tool.command;
    if (tool.resolved === undefined) {
      return tool.asked
        ? toolchainVersion.conclusive(
            `${label}=unavailable`,
            tool.identity,
          )
        : toolchainVersion.unasked(label, tool.identity);
    }
    return toolchainVersion.observe({
      root,
      env,
      args: VERSION_ARGS,
      ...tool,
    });
  });
}

interface IToolchainTool {
  command: string;
  identity: string;
  asked: boolean;
  label?: string;
  override?: string;
  executable?: string;

  /** The invocation this candidate resolved to, once it has. */
  resolved?: IGraphProvider.ICommand;
}

/**
 * What a compile command's driver is called, once the machine is taken off it.
 *
 * A database records the path the build ran, so the same compiler is
 * `/usr/lib/ccache/gcc`, `gcc`, or `C:\LLVM\bin\clang.exe` depending on where
 * it was configured. The provenance field is compared across platforms and
 * checkouts, so it carries the program's name rather than one machine's spelling
 * of its location.
 */
function driverLabel(named: string): string {
  return lastSegment(named).replace(/\.(?:exe|cmd|bat)$/i, "");
}

/** Stable private identity for one project-selected compiler driver. */
function driverIdentity(named: string): string {
  return `toolchain-driver:sha256:${createHash("sha256")
    .update(named.replaceAll("\\", "/"), "utf8")
    .digest("hex")}`;
}

/**
 * The last path segment, on either platform's separator.
 *
 * `path.basename` follows the *running* platform's rules, and a compilation
 * database is written by one machine and can be read on another: a
 * Windows-authored `C:\ccache\ccache.exe` read on Linux comes back whole, so
 * every comparison against it fails.
 */
function lastSegment(named: string): string {
  const segments = named.split(/[\\/]/);
  return segments[segments.length - 1]!;
}

/**
 * Every distinct compiler driver the project's compilation database names.
 *
 * The database is the build's own record of how each translation unit was
 * compiled, so the program each entry runs is the compiler whose semantics the
 * index carries. Both documented shapes are read: `command` is one shell string
 * and `arguments` is an already-split vector.
 *
 * Memoized against the bytes actually parsed. Size plus modification time is
 * not content identity: a build can preserve a timestamp while replacing one
 * same-length driver name with another, and the surrounding generation fence
 * would then rebuild with stale compiler provenance. The memo still avoids
 * repeated JSON parsing, which is the expensive part for a database routinely
 * tens of megabytes long.
 */
function compilationDatabaseCompilers(root: string): string[] {
  const database = compilationDatabase(root);
  if (database === undefined) return [];
  let contents: Buffer;
  try {
    contents = fs.readFileSync(database);
    /* c8 ignore start -- the database was stat'd moments ago by
     * `compilationDatabase`; a removal in between leaves nothing to parse and
     * the read below reports it. */
  } catch {
    return [];
  }
  /* c8 ignore stop */
  const key = `${database}${SEPARATOR}${createHash("sha256")
    .update(contents)
    .digest("hex")}`;
  const memoized = compilationDatabases.get(key);
  if (memoized !== undefined) return [...memoized];
  const drivers = readCompilationDatabaseCompilers(contents);
  compilationDatabases.set(key, drivers);
  return [...drivers];
}

function readCompilationDatabaseCompilers(contents: Buffer): string[] {
  let entries: unknown;
  try {
    entries = JSON.parse(contents.toString("utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const drivers = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as {
      command?: unknown;
      arguments?: unknown;
      directory?: unknown;
    };
    const tokens = Array.isArray(record.arguments)
      ? record.arguments.filter(
          (argument): argument is string => typeof argument === "string",
        )
      : typeof record.command === "string"
        ? splitCommand(record.command)
        : [];
    const driver = compilerToken(tokens);
    if (driver === undefined) continue;
    // A driver written with a separator is relative to the entry's own
    // directory, not to the project root — the database records where each
    // translation unit was compiled precisely because they differ.
    drivers.add(
      path.isAbsolute(driver) ||
        !/[\\/]/.test(driver) ||
        typeof record.directory !== "string"
        ? driver
        : path.resolve(record.directory, driver),
    );
  }
  return [...drivers].sort(compareOrdinal);
}

/**
 * The compiler among a compile command's leading tokens.
 *
 * Two things stand in front of it in ordinary builds. A leading `NAME=value` is
 * a shell assignment, not a program. A compiler launcher — `ccache`, `sccache`,
 * `distcc`, `icecc`, which CMake inserts through `CMAKE_<LANG>_COMPILER_LAUNCHER`
 * — runs the real compiler as its argument, and publishing ccache's version as
 * the toolchain that decided the index's semantics would name a cache.
 */
function compilerToken(tokens: readonly string[]): string | undefined {
  for (const token of tokens) {
    if (token === "") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (COMPILER_LAUNCHERS.has(programName(token))) continue;
    return token;
  }
  return undefined;
}

/**
 * The name a launcher list can be matched against.
 *
 * {@link driverLabel} without the case, because `CCACHE.EXE` is `ccache` and a
 * launcher that is not recognised gets published as the compiler that decided
 * the program's semantics.
 */
function programName(token: string): string {
  return driverLabel(token).toLowerCase();
}

/**
 * Split one compile command into tokens.
 *
 * A database is a record of what a shell was given, and nothing in it says
 * which shell. A Windows build records
 * `"C:\Program Files\LLVM\bin\clang.exe" -c a.c`, a Ninja or Make build on
 * POSIX records `'/usr/bin/g++' -c a.cc` or `/opt/my\ compiler -c a.cc`, and
 * splitting any of them on whitespace names a directory.
 *
 * So a backslash escapes only what a backslash is used to escape here — a
 * space, a tab, or a quote, and never another backslash. Before anything else
 * it is a path separator, and treating it as an escape unconditionally turned
 * `C:\Program Files\LLVM` into `C:Program FilesLLVM`, which is exactly the
 * input the quoting exists for.
 */
function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    const next = command[index + 1];
    if (
      character === "\\" &&
      next !== undefined &&
      ESCAPABLE.has(next)
    ) {
      current += next;
      started = true;
      index += 1;
      continue;
    }
    if (quote === undefined && (character === '"' || character === "'")) {
      quote = character;
      started = true;
      continue;
    }
    if (quote === character) {
      quote = undefined;
      continue;
    }
    if (quote === undefined && /\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * What a backslash can escape here, and what it cannot.
 *
 * Not another backslash. `\\server\share\clang.exe` is a UNC path whose two
 * leading separators are two separators, and consuming the pair as one escaped
 * backslash names a host that does not exist. A POSIX command with a literal
 * backslash in a path is the losing side of that trade, and it is the rarer one
 * by a wide margin in a file whose whole purpose is recording build commands.
 */
const ESCAPABLE = new Set([" ", "\t", '"', "'"]);

const COMPILER_LAUNCHERS = new Set([
  "ccache",
  "sccache",
  "distcc",
  "icecc",
  "icecream",
  "env",
  "buildcache",
]);

/** A separator no path can contain. */
const SEPARATOR = String.fromCharCode(0);
const COMPILATION_DATABASE_INPUTS: readonly string[] = [
  "compile_commands.json",
  "build/compile_commands.json",
];

const compilationDatabases = new BoundedMap<string[]>(64);

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- driver names are distinct set members. */
  return left < right ? -1 : left > right ? 1 : 0;
}

const VERSION_ARGS: readonly string[] = ["--version"];

function resolveScipDecoder(
  root: string,
  env: NodeJS.ProcessEnv,
): IGraphProvider.ICommand | undefined {
  return resolveProviderCommand(root, env, {
    command: "scip",
    override: "SAMCHON_GRAPH_SCIP",
  });
}

function toolVersion(
  root: string,
  env: NodeJS.ProcessEnv,
  command: string,
  override: string,
): toolchainVersion.IObservation {
  return toolchainVersion.observe({
    root,
    env,
    command,
    override,
    args: ["--version"],
  });
}

function compilationDatabase(root: string): string | undefined {
  for (const relative of COMPILATION_DATABASE_INPUTS) {
    const candidate = path.join(root, relative);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function compilationDatabaseInputs(_root: string): string[] {
  // Missing is an input state. A resident fallback must notice the database
  // being created, and a session using build/compile_commands.json must notice
  // a newly created root database taking precedence on the next refresh.
  return [...COMPILATION_DATABASE_INPUTS];
}
