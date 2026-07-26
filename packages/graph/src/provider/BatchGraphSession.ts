import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphLanguage } from "../typings";
import { confinedProjectInput } from "../indexer/confinedProjectInput";
import { freezeDeep } from "../utils/freezeDeep";
import { sealedMap } from "../utils/sealedMap";
import { ownedProcess } from "../utils/ownedProcess";
import { spawnableCommand } from "../utils/spawnableCommand";
import { IBulkGraphSession } from "./IBulkGraphSession";
import { IGraphProvider } from "./IGraphProvider";

/**
 * Atomic lifecycle shared by batch semantic providers.
 *
 * A SCIP indexer, compiler plugin, and analyzer sidecar differ in the artifact
 * they write and how that artifact becomes a normalized snapshot. They do not
 * differ in ownership: each runs into an isolated directory, is bounded and
 * cancellable through its exact child handle, rechecks every declared input,
 * and publishes only after the complete candidate has been loaded. Keeping
 * that transaction here prevents each language wrapper from inventing a
 * subtly different close or stale-generation rule.
 */
export class BatchGraphSession implements IBulkGraphSession {
  public readonly kind = "bulk" as const;
  public readonly languages: readonly GraphLanguage[];
  public readonly root: string;

  private readonly options: BatchGraphSession.IOptions;
  private readonly maxStdoutBytes: number;
  private readonly children = new Set<ISpawned>();
  private snapshot: IBulkGraphSession.ISnapshot | undefined;
  private universe = "";
  private version = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private activeAbort: AbortController | undefined;

  public constructor(options: BatchGraphSession.IOptions) {
    if (options.languages.length === 0) {
      throw new TypeError(
        `${options.provider}: a batch session must own at least one language`,
      );
    }
    const maxStdoutBytes =
      options.maxStdoutBytes ?? DEFAULT_MAX_PROCESS_STDOUT_BYTES;
    if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1) {
      throw new TypeError(
        `${options.provider}: maxStdoutBytes must be a positive safe integer`,
      );
    }
    this.options = options;
    this.maxStdoutBytes = maxStdoutBytes;
    this.languages = [...options.languages];
    this.root = options.root;
  }

  public get generation(): number {
    return this.version;
  }

  public get current(): IBulkGraphSession.ISnapshot | undefined {
    return this.snapshot;
  }

  public refresh(
    options: { signal?: AbortSignal } = {},
  ): Promise<IBulkGraphSession.IRefresh> {
    if (this.closed) {
      return Promise.reject(
        new Error(`${this.options.provider}: session is closed`),
      );
    }
    return this.enqueue(async () => {
      const activeAbort = new AbortController();
      this.activeAbort = activeAbort;
      const signal = combineSignals(options.signal, activeAbort.signal);
      try {
        this.assertOpen();
        throwIfAborted(signal, this.options.provider);
        // Read once and carried through this refresh. A configuration row is
        // a toolchain version, and deriving one spawns the tool: asking again
        // after the build made the freshness check depend on a second process
        // launch succeeding identically, so a transient spawn failure looked
        // exactly like a project that changed underneath the indexer. What that
        // check exists to catch is a source or build file edited while the
        // producer was running, and re-reading the files still catches it.
        const configuration = [...(this.options.configuration?.() ?? [])];
        const universe = this.fingerprint(configuration);
        if (universe === this.universe && this.snapshot !== undefined) {
          return {
            changed: false,
            generation: this.version,
            mode: "unchanged" as const,
            snapshot: this.snapshot,
          };
        }
        const next = await this.build(universe, configuration, signal);
        this.assertOpen();
        this.snapshot = next;
        this.universe = universe;
        this.version += 1;
        return {
          changed: true,
          generation: this.version,
          mode: this.version === 1 ? ("initial" as const) : ("rebuild" as const),
          snapshot: next,
        };
      } finally {
        if (this.activeAbort === activeAbort) this.activeAbort = undefined;
      }
    }, options.signal);
  }

  /** Close every exact child once and wait until all of them have exited. */
  public close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.activeAbort?.abort(
      new Error(`${this.options.provider}: session is closed`),
    );
    const owned = [...this.children];
    this.children.clear();
    const queue = this.queue;
    this.closing = Promise.all([
      ...owned.map((child) => this.terminate(child)),
      queue.catch(() => undefined),
    ]).then(() => undefined);
    return this.closing;
  }

  private terminate(child: ISpawned): Promise<void> {
    if (child.termination !== undefined) return child.termination;
    const termination = ownedProcess.terminate(
      child.process,
      child.exit,
      this.options.provider,
    );
    child.termination = termination;
    return termination;
  }

  private async build(
    universe: string,
    configuration: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<IBulkGraphSession.ISnapshot> {
    const output = fs.mkdtempSync(
      path.join(os.tmpdir(), `samchon-graph-${this.options.provider}-`),
    );
    try {
      const artifact = path.join(output, this.options.artifactName);
      await this.run(
        this.options.command,
        this.options.indexArgs(artifact),
        signal,
      );
      if (!fs.existsSync(artifact)) {
        throw new Error(
          `${this.options.provider}: the producer exited without writing ${artifact}`,
        );
      }
      const snapshot = await this.options.load({
        artifact,
        universe,
        signal,
        run: (command, args) => this.run(command, args, signal),
      });
      // Sealed before the gate rather than after it. A validator is a gate, not
      // a transform, and one that kept the reference could append an unclaimed
      // edge once `refresh` had published the generation — invalidating
      // `current` behind a contract check that already passed.
      // A fresh envelope rather than an assignment into what `load` returned:
      // a producer is entitled to hand back an already-frozen snapshot, and
      // writing `sources` into it would fail with a message naming neither the
      // provider nor the field. The published object is this one from here on,
      // so a reference the producer kept cannot reach the generation either.
      const subject = `the ${this.options.provider} snapshot`;
      const sources = sealedMap(snapshot.sources, subject);
      const published: IBulkGraphSession.ISnapshot = { ...snapshot, sources };
      freezeDeep(published, subject);
      this.options.validate?.(published);
      const after = this.fingerprint(configuration);
      if (after !== universe) {
        throw new Error(
          `${this.options.provider}: project inputs changed while its artifact ` +
            "was being built, so that artifact cannot be published",
        );
      }
      return published;
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  }

  private fingerprint(configuration: readonly string[]): string {
    const hash = createHash("sha256");
    for (const value of [...configuration].sort(compareOrdinalPath)) {
      frame(hash, "configuration", Buffer.from(value, "utf8"));
    }
    for (const file of [...this.options.inputs()].sort(compareOrdinalPath)) {
      const relative = path
        .relative(this.root, confinedProjectInput(this.root, file))
        .replaceAll("\\", "/");
      frame(hash, "path", Buffer.from(relative, "utf8"));
      try {
        frame(hash, "present", fs.readFileSync(path.resolve(this.root, relative)));
        /* c8 ignore start -- a listed input removed between the walk and this
         * read is itself a difference the next comparison catches. */
      } catch {
        frame(hash, "missing", Buffer.alloc(0));
      }
      /* c8 ignore stop */
    }
    return hash.digest("hex");
  }

  /** Run one exact-owned child to completion and retain bounded stdout. */
  private run(
    command: IGraphProvider.ICommand,
    trailingArgs: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const spawnable = spawnableCommand.append(
      {
        ...command,
        args: [...command.args],
      },
      trailingArgs,
    );
    this.assertOpen();
    if (signal?.aborted === true) {
      return Promise.reject(
        abortedProcessError(this.options.provider, command.command),
      );
    }
    const ownedCommand = ownedProcess.command(
      spawnable.command,
      spawnable.args,
      spawnable.windowsVerbatimArguments,
    );
    const child = spawn(ownedCommand.command, ownedCommand.args, {
      cwd: this.root,
      detached: ownedProcess.group(),
      windowsHide: true,
      windowsVerbatimArguments:
        ownedCommand.windowsVerbatimArguments,
      stdio: ownedProcess.stdio(ownedCommand, [
        "ignore",
        "pipe",
        "pipe",
      ]),
    }) as ReturnType<typeof spawn> & {
      stdout: NonNullable<ReturnType<typeof spawn>["stdout"]>;
      stderr: NonNullable<ReturnType<typeof spawn>["stderr"]>;
    };
    ownedProcess.start(child, ownedCommand);
    const owned: ISpawned = { process: child, exit: ownedProcess.exit(child) };
    this.children.add(owned);

    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let outputFailure: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      /* c8 ignore next -- termination can leave one already-buffered chunk. */
      if (outputFailure !== undefined) return;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > this.maxStdoutBytes) {
        outputFailure = new Error(
          `${this.options.provider}: ${command.command} exceeded the ${String(this.maxStdoutBytes)} byte stdout limit`,
        );
        void this.terminate(owned).catch(() => undefined);
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_PROCESS_STDERR_CHARS);
    });

    const abort = (): void => {
      void this.terminate(owned).catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (isAborted(signal)) abort();

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        signal?.removeEventListener("abort", abort);
        this.children.delete(owned);
      };
      const complete = async (code: number | null, error?: Error): Promise<void> => {
        /* c8 ignore start -- a direct spawn error and its following close event
         * can both attempt to settle the same one-shot producer. */
        if (settled) return;
        /* c8 ignore stop */
        settled = true;
        try {
          // A one-shot producer is still an owned process tree. Its group may
          // contain a background descendant after the exact child has closed.
          await this.terminate(owned);
          /* c8 ignore start -- reaching this branch requires the operating
          system itself to refuse exact-tree termination after the child event;
          lifecycle tests cover cooperative exit, escalation, and abort. */
        } catch (terminationError) {
          finish();
          reject(terminationError);
          return;
        }
        /* c8 ignore stop */
        finish();
        /* c8 ignore start -- direct POSIX spawn failures are exercised on
         * POSIX. Windows starts a stable Job Object supervisor first and
         * reports a nested command launch failure through its exit instead. */
        if (error !== undefined) {
          reject(error);
          return;
        }
        /* c8 ignore stop */
        if (signal?.aborted === true) {
          reject(
            abortedProcessError(this.options.provider, command.command),
          );
          return;
        }
        if (outputFailure !== undefined) {
          reject(outputFailure);
          return;
        }
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(
          new Error(
            `${this.options.provider}: ${command.command} exited with code ${String(code)}${
              stderr === "" ? "" : `: ${stderr.trim()}`
            }`,
          ),
        );
      };
      /* c8 ignore start -- see the platform boundary on the direct spawn
       * error branch above. */
      child.on("error", (error) => {
        void complete(null, error);
      });
      /* c8 ignore stop */
      child.on("close", (code) => {
        void complete(code);
      });
    });
  }

  private enqueue<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let settle!: (value: T) => void;
    let fail!: (error: Error) => void;
    let started = false;
    let settled = false;
    const result = new Promise<T>((resolve, reject) => {
      settle = (value) => {
        /* c8 ignore next -- a cancelled queued refresh never runs its task. */
        if (settled) return;
        settled = true;
        resolve(value);
      };
      fail = (error) => {
        /* c8 ignore next -- a cancelled queued refresh rejects only once. */
        if (settled) return;
        settled = true;
        reject(error);
      };
    });
    const cancelQueued = (): void => {
      if (!started) fail(abortedProcessError(this.options.provider, "refresh"));
    };
    if (isAborted(signal)) {
      cancelQueued();
      return result;
    }
    signal?.addEventListener("abort", cancelQueued, { once: true });
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        started = true;
        signal?.removeEventListener("abort", cancelQueued);
        if (settled) return;
        try {
          settle(await task());
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    return result;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`${this.options.provider}: session is closed`);
    }
  }
}

export namespace BatchGraphSession {
  export interface IOptions {
    root: string;
    languages: readonly GraphLanguage[];
    provider: string;
    command: IGraphProvider.ICommand;
    artifactName: string;
    indexArgs: (artifact: string) => string[];
    inputs: () => string[];
    /** Non-file build settings whose change invalidates the complete artifact. */
    configuration?: () => readonly string[];
    load: (props: ILoadProps) => Promise<IBulkGraphSession.ISnapshot>;
    /** Contract gate that must pass before this generation becomes current. */
    validate?: (snapshot: IBulkGraphSession.ISnapshot) => void;
    maxStdoutBytes?: number;
  }

  export interface ILoadProps {
    artifact: string;
    universe: string;
    signal: AbortSignal | undefined;
    run: (
      command: IGraphProvider.ICommand,
      args: readonly string[],
    ) => Promise<string>;
  }
}

interface ISpawned {
  process: ReturnType<typeof spawn>;
  exit: Promise<void>;
  termination?: Promise<void>;
}

const DEFAULT_MAX_PROCESS_STDOUT_BYTES = 256 * 1024 * 1024;
const MAX_PROCESS_STDERR_CHARS = 64 * 1024;

function abortedProcessError(provider: string, command: string): Error {
  const error = new Error(`${provider}: ${command} was aborted`);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined, provider: string): void {
  if (isAborted(signal)) throw abortedProcessError(provider, "refresh");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function compareOrdinalPath(left: string, right: string): number {
  /* c8 ignore next 2 -- input lists hold distinct project-relative paths. */
  return left < right ? -1 : left > right ? 1 : 0;
}

function frame(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: Buffer,
): void {
  const labelBytes = Buffer.from(label, "utf8");
  hash.update(String(labelBytes.length));
  hash.update(":");
  hash.update(labelBytes);
  hash.update(String(value.length));
  hash.update(":");
  hash.update(value);
}

function combineSignals(
  caller: AbortSignal | undefined,
  lifecycle: AbortSignal,
): AbortSignal {
  if (caller === undefined) return lifecycle;
  return {
    get aborted() {
      return caller.aborted || lifecycle.aborted;
    },
    /* c8 ignore start -- these AbortSignal compatibility members are required
     * structurally, while the owned-process consumer uses `aborted` and event
     * registration only. */
    get reason() {
      return caller.aborted ? caller.reason : lifecycle.reason;
    },
    onabort: null,
    addEventListener: (type, listener, options) => {
      caller.addEventListener(type, listener, options);
      lifecycle.addEventListener(type, listener, options);
    },
    removeEventListener: (type, listener, options) => {
      caller.removeEventListener(type, listener, options);
      lifecycle.removeEventListener(type, listener, options);
    },
    dispatchEvent: () => false,
    throwIfAborted() {
      if (!this.aborted) return;
      throw this.reason;
    },
    /* c8 ignore stop */
  } as AbortSignal;
}
