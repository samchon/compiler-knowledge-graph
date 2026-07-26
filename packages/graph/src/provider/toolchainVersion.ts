import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { spawnableCommand } from "../utils/spawnableCommand";
import { IGraphProvider } from "./IGraphProvider";
import { resolveProviderCommand } from "./resolveProviderCommand";

/**
 * The version of one toolchain, as a single configuration row.
 *
 * Three providers derived this separately and each paid the same two costs. A
 * version probe is a process launch, and the rows are re-derived on every
 * session refresh, so a resident server spent several synchronous launches per
 * request asking about programs that had not moved. The probe also spoke about
 * two different states in one word: a tool that is not installed and a tool
 * whose probe happened not to answer both came back `unavailable`, and a build
 * universe computed from that value rebuilt itself over a spawn failure.
 *
 * Both follow from asking the wrong thing. A program's version is a property of
 * the program, so the answer is cached against the file's identity and the
 * probe runs once per distinct binary. Absence is decided by
 * {@link resolveProviderCommand}, which reads the filesystem and launches
 * nothing, so `unavailable` now means only what it says. A resolved binary
 * whose probe does not answer is `unreported`, which is a third state because
 * it is a third fact.
 */
export function toolchainVersion(props: toolchainVersion.IProps): string {
  const resolved = resolveProviderCommand(props.root, props.env, {
    command: props.command,
    override: props.override,
  });
  if (resolved === undefined) return `${props.command}=unavailable`;
  const observed = probe(resolved, props);
  return observed === undefined
    ? `${props.command}=unreported`
    : `${props.command}=${observed}`;
}

export namespace toolchainVersion {
  export interface IProps {
    root: string;
    env: NodeJS.ProcessEnv;

    /** The executable to probe, resolved through the provider command rules. */
    command: string;

    /** Environment variable naming an absolute development build. */
    override: string;

    /** The probe arguments, such as `--version` or `-vV`. */
    args: readonly string[];
  }
  /* c8 ignore start -- declaration merging emits an unreachable namespace
   * creation arm after the function object already exists. */
}
/* c8 ignore stop */

/**
 * Run the probe unless this exact binary already answered it.
 *
 * Keyed by the executable's path, size, and modification time rather than by
 * its name: a project-local tool and a global one of the same name are
 * different programs, and replacing a binary in place is exactly the event that
 * must invalidate the answer. A failed probe is never cached, so a transient
 * failure is retried rather than frozen, while a version already learned for
 * this binary wins over a later failure — the binary did not change, so neither
 * did its version.
 */
function probe(
  resolved: IGraphProvider.ICommand,
  props: toolchainVersion.IProps,
): string | undefined {
  const key = cacheKey(resolved, props.args);
  if (key !== undefined) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
  }
  const spawnable = spawnableCommand.append(
    { ...resolved, args: [...resolved.args] },
    props.args,
  );
  const result = spawnSync(spawnable.command, spawnable.args, {
    cwd: props.root,
    env: props.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsVerbatimArguments: spawnable.windowsVerbatimArguments,
    windowsHide: true,
  });
  /* c8 ignore next -- an executed spawnSync with UTF-8 encoding returns a
   * string; the null arm exists only for Node's broader result type. */
  const output = oneLine(String(result.stdout ?? ""));
  if (result.status !== 0 || output === "") return undefined;
  if (key !== undefined) cache.set(key, output);
  return output;
}

/**
 * The identity of the program this probe would launch, or `undefined` when it
 * has none to state.
 *
 * Read from `executable` rather than `command`, because a Windows `.cmd`
 * provider is spawned as a `cmd.exe` invocation carrying the real program
 * inside a quoted argument: stat'ing `command` would describe the command
 * processor, which never changes, and every shim on the machine would share one
 * cached answer that no toolchain replacement could invalidate.
 *
 * A path that cannot be stat'd is not cacheable under any key: the answer would
 * have to be filed under the absence of an identity, where the next program
 * that also has none would find it.
 */
function cacheKey(
  resolved: IGraphProvider.ICommand,
  args: readonly string[],
): string | undefined {
  const executable = resolved.executable ?? resolved.command;
  let identity: string;
  try {
    const stat = fs.statSync(executable);
    identity = `${String(stat.size)}:${String(stat.mtimeMs)}`;
    /* c8 ignore next 4 -- a PATH-resolved executable removed between lookup
     * and this stat has no identity to file an answer under; the spawn below
     * then reports the real failure. */
  } catch {
    return undefined;
  }
  return [executable, identity, ...resolved.args, ...args].join(SEPARATOR);
}

/**
 * Every line of the probe's answer, on one line.
 *
 * Joining rather than truncating. `java --version` and `clang --version` answer
 * in three lines and `rustc -vV` in seven, and the lines after the first carry
 * the host triple, the runtime build, and the LLVM version — facts that decide
 * what a compiled artifact means. Keeping only the first would drop them;
 * keeping the newlines puts a multi-line value in a published provenance field
 * that every other producer fills with one line.
 */
function oneLine(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("; ");
}

/** A separator no path, argument, or digest can contain. */
const SEPARATOR = String.fromCharCode(0);

const cache = new Map<string, string>();
