import { providerInputFiles } from "../provider/providerInputFiles";
import { GraphLanguage } from "../typings";
import { normalizePath } from "../utils/normalizePath";
import path from "node:path";
import { dartPackageConfigInputs } from "./dartPackageConfigInputs";

/**
 * Build-universe inputs that apply even when a language uses generic LSP or
 * static fallback. Provider entries may add narrower generated inputs.
 */
export function languageBuildInputs(
  root: string,
  languages: readonly GraphLanguage[],
): string[] {
  const names = new Set<string>();
  const extensions = new Set<string>();
  for (const language of languages) {
    for (const name of BUILD_INPUTS[language]) names.add(name);
    for (const extension of BUILD_INPUT_EXTENSIONS[language]) {
      extensions.add(extension);
    }
  }
  const fileNames = [...names].filter((name) => !/[\\/]/.test(name));
  const relativePaths = [...names]
    .filter((name) => /[\\/]/.test(name))
    .map((name) => normalizePath(name));
  const existing = providerInputFiles(root, [], [...names], [...extensions]);
  const candidates = new Set([...existing, ...relativePaths]);
  if (languages.includes("dart")) {
    for (const file of dartPackageConfigInputs(root)) candidates.add(file);
  }
  const resolved = path.resolve(root);
  const sourceFiles = providerInputFiles(root, languages, []);
  const directories = new Set<string>([resolved]);
  for (const source of sourceFiles) {
    let directory = path.dirname(path.resolve(resolved, source));
    for (;;) {
      directories.add(directory);
      if (directory === resolved) break;
      const parent = path.dirname(directory);
      /* c8 ignore start -- providerInputFiles returns confined paths beneath
       * resolved, so neither a parent fixed point nor a lexical escape can
       * precede the resolved-root equality above. */
      if (parent === directory || !directory.startsWith(`${resolved}${path.sep}`)) {
        break;
      }
      /* c8 ignore stop */
      directory = parent;
    }
  }
  for (const directory of directories) {
    for (const name of fileNames) {
      candidates.add(
        normalizePath(path.relative(resolved, path.join(directory, name))),
      );
    }
  }
  return [...candidates].sort(compareOrdinal);
}

const COMMON_NODE_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
] as const;

const JVM_BUILD_INPUTS = [
  ".mvn/extensions.xml",
  ".mvn/jvm.config",
  ".mvn/maven.config",
  ".mvn/wrapper/maven-wrapper.jar",
  ".mvn/wrapper/maven-wrapper.properties",
  "pom.xml",
  "mvnw",
  "mvnw.cmd",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "gradle.lockfile",
  "gradle-wrapper.properties",
  "gradle/verification-metadata.xml",
  "gradle/wrapper/gradle-wrapper.jar",
  "gradlew",
  "gradlew.bat",
  "libs.versions.toml",
] as const;

const BUILD_INPUTS: Record<GraphLanguage, readonly string[]> = {
  typescript: [
    ...COMMON_NODE_INPUTS,
    "tsconfig.json",
    "jsconfig.json",
  ],
  cpp: [
    "compile_commands.json",
    "CMakeLists.txt",
    "CMakePresets.json",
    "Makefile",
    "meson.build",
  ],
  c: [
    "compile_commands.json",
    "CMakeLists.txt",
    "CMakePresets.json",
    "Makefile",
    "meson.build",
  ],
  java: JVM_BUILD_INPUTS,
  csharp: [
    "global.json",
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "packages.lock.json",
    "nuget.config",
  ],
  go: ["go.mod", "go.sum", "go.work", "go.work.sum"],
  rust: [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain",
    "rust-toolchain.toml",
    "config",
    "config.toml",
  ],
  python: [
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
  ruby: [
    "Gemfile",
    "Gemfile.lock",
    ".ruby-version",
    "sorbet/config",
  ],
  php: [
    "composer.json",
    "composer.lock",
    "phpstan.neon",
    "phpstan.neon.dist",
  ],
  swift: ["Package.swift", "Package.resolved", "project.pbxproj"],
  kotlin: JVM_BUILD_INPUTS,
  scala: [
    "build.sbt",
    "build.sc",
    ...JVM_BUILD_INPUTS,
  ],
  zig: ["build.zig", "build.zig.zon"],
  lua: [".luarc.json", ".luarc.jsonc"],
  dart: [
    "pubspec.yaml",
    "pubspec.lock",
    "analysis_options.yaml",
  ],
  unknown: [],
};

const BUILD_INPUT_EXTENSIONS: Record<GraphLanguage, readonly string[]> = {
  typescript: [],
  cpp: [".cmake"],
  c: [".cmake"],
  java: [".gradle", ".kts"],
  csharp: [".sln", ".csproj", ".fsproj", ".props", ".targets"],
  go: [],
  rust: [],
  python: [],
  ruby: [".gemspec"],
  php: [],
  swift: [".xcodeproj"],
  kotlin: [".gradle", ".kts"],
  scala: [".gradle", ".kts"],
  zig: [],
  lua: [".rockspec"],
  dart: [],
  unknown: [],
};

function compareOrdinal(left: string, right: string): number {
  /* c8 ignore next 2 -- input identities are distinct set members. */
  return left < right ? -1 : left > right ? 1 : 0;
}
