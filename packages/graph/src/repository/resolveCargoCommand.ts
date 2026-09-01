import { resolveProviderCommand } from "../provider/resolveProviderCommand";

/** Resolve rustup's native cargo.exe before optional command shims on Windows. */
export function resolveCargoCommand(
  root: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[] = [],
) {
  return resolveProviderCommand(root, env, {
    command: "cargo",
    override: "SAMCHON_GRAPH_CARGO",
    args,
  });
}
