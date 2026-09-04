import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Measure native clangd background indexing without requesting a graph. */
export async function measureClangBackgroundIndex({
  command,
  compilationDatabase,
  cwd,
  language,
  sourceFile,
  timeoutMs,
  createClient,
  now = () => performance.now(),
  readSource = (file) => fs.readFileSync(file, "utf8"),
}) {
  const started = now();
  const rootUri = pathToFileURL(cwd).href;
  const sourceUri = pathToFileURL(sourceFile).href;
  const client = createClient(command, [
    "--background-index",
    `--compile-commands-dir=${path.dirname(compilationDatabase)}`,
  ]);
  let began = false;
  let completed = false;
  let timer;
  let rejectProgress;
  const settled = new Promise((resolve, reject) => {
    rejectProgress = reject;
    client.onNotification("$/progress", (params) => {
      if (
        params?.token !== "backgroundIndexProgress" ||
        typeof params.value !== "object" ||
        params.value === null
      ) {
        return;
      }
      if (params.value.kind === "begin") {
        began = true;
        return;
      }
      if (params.value.kind === "end" && began) {
        completed = true;
        resolve();
      }
    });
  });
  let progressError;
  const observed = settled.catch((error) => {
    progressError = error;
  });
  try {
    await client.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        capabilities: { window: { workDoneProgress: true } },
        workspaceFolders: [
          {
            uri: rootUri,
            name: "samchon-graph-clang-native-baseline",
          },
        ],
      },
      timeoutMs,
    );
    if (!completed) {
      timer = setTimeout(
        () =>
          rejectProgress(
            new Error("native clangd background indexing timed out"),
          ),
        timeoutMs,
      );
      timer.unref?.();
    }
    client.notify("initialized", {});
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: sourceUri,
        languageId: language,
        version: 1,
        text: readSource(sourceFile),
      },
    });
    await observed;
    if (progressError !== undefined) throw progressError;
    return Math.round(now() - started);
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}
