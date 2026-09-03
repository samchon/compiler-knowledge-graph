import fs from "node:fs";

/** Wait until a fixture has published one complete, positive process id. */
export const waitForProcessId = async (
  file: string,
  timeoutMs = 5_000,
): Promise<number> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidate = readProcessId(file);
    if (candidate !== undefined) return candidate;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for a complete process id in ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const readProcessId = (file: string): number | undefined => {
  let value: string;
  try {
    value = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const match = /^([1-9]\d*)\r?\n$/.exec(value);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : undefined;
};
