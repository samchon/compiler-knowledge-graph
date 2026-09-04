import { TestValidator } from "@nestia/e2e";
import { createResidentGraphSource } from "@samchon/graph";
import fs from "node:fs";
import path from "node:path";

import { GraphPaths } from "../internal/GraphPaths";
import { waitForProcessId } from "../internal/waitForProcessId";

/** A resident close cancels every phase of an established LSP refresh. */
export const test_resident_close_interrupts_stalled_generic_lsp_refresh =
  async () => {
    await exercise("readiness", ["--hang-refresh-readiness"]);
    await exercise("symbols", [
      "--hang-refresh-method=textDocument/documentSymbol",
    ]);
    await exercise("references", [
      "--hang-refresh-method=textDocument/references",
    ]);
  };

const exercise = async (phase: string, serverArgs: string[]): Promise<void> => {
  const root = GraphPaths.createTempDirectory(
    `samchon-graph-stalled-lsp-refresh-${phase}-`,
  );
  const source = path.join(root, "main.py");
  fs.writeFileSync(source, "answer = 1\n");
  const pidFile = path.join(root, "lsp.pid");
  const hangFile = path.join(root, "refresh.stalled");
  const previousPidFile = process.env.SAMCHON_GRAPH_FAKE_LSP_PID_FILE;
  const previousHangFile = process.env.SAMCHON_GRAPH_FAKE_LSP_HANG_FILE;
  process.env.SAMCHON_GRAPH_FAKE_LSP_PID_FILE = pidFile;
  process.env.SAMCHON_GRAPH_FAKE_LSP_HANG_FILE = hangFile;

  let pid: number | undefined;
  const resident = createResidentGraphSource({
    cwd: root,
    languages: ["python"],
    server: process.execPath,
    serverArgs: [GraphPaths.fakeLspServer, ...serverArgs],
    lspReadyQuietMs: 10,
  });
  try {
    await resident.load();
    pid = await waitForProcessId(pidFile);
    fs.writeFileSync(source, "answer = 2\n");

    const refreshing = resident.load();
    await waitForFile(hangFile);
    const settled = await settleWithin(
      Promise.allSettled([refreshing, resident.close()]),
      5_000,
      () => terminate(pid!),
    );
    TestValidator.equals(
      `${phase} refresh rejects after shutdown`,
      settled[0].status,
      "rejected",
    );
    TestValidator.equals(
      `${phase} shutdown settles`,
      settled[1].status,
      "fulfilled",
    );
    await waitForExit(pid);
    TestValidator.equals(
      `${phase} child exits after refresh shutdown`,
      isProcessAlive(pid),
      false,
    );
  } finally {
    await Promise.allSettled([resident.close()]);
    if (pid !== undefined) terminate(pid);
    restoreEnv("SAMCHON_GRAPH_FAKE_LSP_PID_FILE", previousPidFile);
    restoreEnv("SAMCHON_GRAPH_FAKE_LSP_HANG_FILE", previousHangFile);
  }
};

const waitForFile = async (file: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`fake LSP did not announce ${file}`);
    }
    await delay(10);
  }
};

const settleWithin = async <T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(
        new Error(`resident LSP refresh shutdown exceeded ${String(timeoutMs)} ms`),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const waitForExit = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (isProcessAlive(pid) && Date.now() < deadline) await delay(10);
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const terminate = (pid: number): void => {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
};

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
