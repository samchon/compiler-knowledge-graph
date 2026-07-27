import fs from "node:fs";
import path from "node:path";
import { compareOrdinal } from "@samchon/graph-sitter";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { DEFAULT_IGNORES } from "./DEFAULT_IGNORES";
import { IWalkOptions } from "./IWalkOptions";

export function walkSourceFiles(root: string, options: IWalkOptions): string[] {
  if (options.maxFiles !== undefined && options.maxFiles <= 0) return [];
  const out: string[] = [];
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORES;
  const allowNested = options.allowNestedRepositories ?? false;
  const resolvedRoot = path.resolve(root);
  const compilerOutputs = collectCompilerOutputs(
    resolvedRoot,
    ignoreDirs,
    allowNested,
  );
  const visit = (dir: string, insideCompilerOutput: boolean): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareOrdinal(a.name, b.name));
    for (const entry of entries) {
      if (options.maxFiles !== undefined && out.length >= options.maxFiles) break;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        // A subdirectory that is itself a git repository or worktree root —
        // marked by a `.git` directory (a clone) or a `.git` file (a linked
        // worktree or a submodule) — belongs to a different checkout: a nested
        // agent worktree, a vendored clone, a submodule. Merging its files into
        // this graph would describe a foreign branch and lets an unrelated tree
        // win a `maxFiles` cap before any real source is seen. Stop at that
        // boundary unless the caller intentionally opts in.
        if (!allowNested && isRepositoryRoot(abs)) continue;
        visit(
          abs,
          insideCompilerOutput ||
            compilerOutputs.has(platformPathKey(path.resolve(abs))),
        );
        continue;
      }
      /* c8 ignore next */
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name);
      // GCC and Clang assign uppercase `.C` and `.H` to C++, while lowercase
      // `.c` and `.h` are C identities. All other registered suffixes remain
      // case-insensitive for discovery, as they were before.
      const extensionKey =
        extension === ".C" || extension === ".H"
          ? extension
          : extension.toLowerCase();
      if (
        options.extensions.has(extensionKey) &&
        !(insideCompilerOutput && isTypeScriptCompilerOutput(entry.name))
      ) {
        out.push(abs);
      }
    }
  };
  visit(resolvedRoot, compilerOutputs.has(platformPathKey(resolvedRoot)));
  return out;
}

/**
 * A directory is a self-contained checkout when it carries a `.git` marker: a
 * directory in an ordinary clone, or a file in a linked worktree or submodule.
 * The requested root is walked directly and is never subjected to this test, so
 * only nested checkouts below it are excluded.
 */
function isRepositoryRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/** Find every effective TypeScript output directory before source traversal. */
function collectCompilerOutputs(
  root: string,
  ignoreDirs: ReadonlySet<string>,
  allowNested: boolean,
): Set<string> {
  const outputs = new Set<string>();
  const cache = new Map<string, ICompilerOutputs | undefined>();
  const visit = (directory: string): void => {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const config = path.join(directory, name);
      if (!fs.existsSync(config)) continue;
      const configured = compilerOutputsOf(config, cache, new Set());
      for (const output of [
        configured?.outDir,
        configured?.declarationDir,
      ]) {
        if (output !== undefined) outputs.add(platformPathKey(output));
      }
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoreDirs.has(entry.name)) continue;
      const nested = path.join(directory, entry.name);
      if (!allowNested && isRepositoryRoot(nested)) continue;
      visit(nested);
    }
  };
  visit(root);
  return outputs;
}

interface ICompilerOutputs {
  outDir?: string;
  declarationDir?: string;
}

interface ICompilerConfig {
  extends?: unknown;
  compilerOptions?: {
    outDir?: unknown;
    declarationDir?: unknown;
  };
}

function compilerOutputsOf(
  config: string,
  cache: Map<string, ICompilerOutputs | undefined>,
  visiting: Set<string>,
  configDirectory: string = path.dirname(config),
): ICompilerOutputs | undefined {
  const key = `${platformPathKey(path.resolve(config))}\0${platformPathKey(configDirectory)}`;
  if (cache.has(key)) return cache.get(key);
  if (visiting.has(key)) return {};
  visiting.add(key);
  let parsed: ICompilerConfig | undefined;
  try {
    const errors: ParseError[] = [];
    parsed = parseJsonc(fs.readFileSync(config, "utf8"), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    }) as ICompilerConfig | undefined;
    if (
      errors.length > 0 ||
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      parsed = undefined;
    }
    /* c8 ignore start -- a concurrently removed config is not evidence that
     * any directory is generated, so discovery stays open. */
  } catch {
    parsed = undefined;
  }
  /* c8 ignore stop */
  if (parsed === undefined) {
    visiting.delete(key);
    cache.set(key, undefined);
    return undefined;
  }

  const directory = path.dirname(config);
  const inherited: ICompilerOutputs = {};
  const extensions =
    typeof parsed.extends === "string"
      ? [parsed.extends]
      : Array.isArray(parsed.extends)
        ? parsed.extends.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
  for (const specifier of extensions) {
    const base = resolveExtendedConfig(directory, specifier);
    if (base === undefined) continue;
    Object.assign(
      inherited,
      compilerOutputsOf(base, cache, visiting, configDirectory),
    );
  }
  for (const field of ["outDir", "declarationDir"] as const) {
    const value = parsed.compilerOptions?.[field];
    if (typeof value === "string") {
      inherited[field] = path.resolve(
        directory,
        value.replaceAll(CONFIG_DIR_VARIABLE, configDirectory),
      );
    }
  }
  visiting.delete(key);
  cache.set(key, inherited);
  return inherited;
}

const CONFIG_DIR_VARIABLE = "$" + "{configDir}";

function resolveExtendedConfig(
  directory: string,
  specifier: string,
): string | undefined {
  const base =
    path.isAbsolute(specifier) || specifier.startsWith(".")
      ? path.resolve(directory, specifier)
      : resolvePackageConfig(directory, specifier);
  if (base === undefined) return undefined;
  for (const candidate of [
    base,
    base.toLowerCase().endsWith(".json") ? base : `${base}.json`,
    path.join(base, "tsconfig.json"),
  ]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function resolvePackageConfig(
  directory: string,
  specifier: string,
): string | undefined {
  const parts = specifier.split("/");
  const packagePartCount = specifier.startsWith("@") ? 2 : 1;
  const packageParts =
    packagePartCount === 2 ? parts.slice(0, 2) : parts.slice(0, 1);
  if (
    packageParts.length !== packagePartCount ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    return undefined;
  }
  const subpath = parts.slice(packageParts.length).join("/");
  let current = path.resolve(directory);
  while (true) {
    const packageRoot = path.join(
      current,
      "node_modules",
      ...packageParts,
    );
    if (isDirectory(packageRoot)) {
      if (subpath !== "") return path.join(packageRoot, subpath);
      const packageJson = path.join(packageRoot, "package.json");
      const configured = packageConfigEntry(packageJson);
      return path.join(packageRoot, configured ?? "tsconfig.json");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function packageConfigEntry(packageJson: string): string | undefined {
  try {
    const errors: ParseError[] = [];
    const value = parseJsonc(fs.readFileSync(packageJson, "utf8"), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    }) as unknown;
    if (
      errors.length !== 0 ||
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return undefined;
    }
    const configured = (value as { tsconfig?: unknown }).tsconfig;
    return typeof configured === "string" && configured !== ""
      ? configured
      : undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function isTypeScriptCompilerOutput(file: string): boolean {
  const lower = file.toLowerCase();
  return (
    lower.endsWith(".d.ts") ||
    lower.endsWith(".d.mts") ||
    lower.endsWith(".d.cts") ||
    [".js", ".jsx", ".mjs", ".cjs"].includes(path.extname(lower))
  );
}

function platformPathKey(value: string): string {
  const normalized = path.normalize(value);
  /* c8 ignore next 3 -- only one platform arm runs on a given host. */
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
