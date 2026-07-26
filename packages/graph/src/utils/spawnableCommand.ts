import path from "node:path";

/**
 * Turn a `.cmd`/`.bat` shim into one literal command-processor invocation.
 *
 * `/v:off` keeps `!` literal; quoting keeps `&|<>()^` inside arguments; percent
 * doubling prevents environment expansion during cmd's parse.
 */
export function spawnableCommand(
  executable: string,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): spawnableCommand.IResult {
  /* c8 ignore start -- the Windows-only suffix arm is short-circuited on
   * POSIX coverage hosts. */
  if (
    process.platform !== "win32" ||
    !/\.(?:cmd|bat)$/i.test(executable)
  ) {
    return { command: executable, args: [...args] };
  }
  /* c8 ignore stop */
  /* c8 ignore start -- Windows-only command-processor construction. */
  const doubleEscape =
    /[\\/]node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(executable);
  const shellCommand = [
    escapeCommand(path.normalize(executable)),
    ...args.map((argument) => escapeArgument(argument, doubleEscape)),
  ].join(" ");
  return {
    command: spawnableCommand.windowsSystem("cmd.exe", env),
    args: ["/d", "/s", "/v:off", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
    windowsDoubleEscapeArguments: doubleEscape,
  };
}
/* c8 ignore stop */

export namespace spawnableCommand {
  export interface IResult {
    command: string;
    args: string[];
    windowsVerbatimArguments?: boolean;
    windowsDoubleEscapeArguments?: boolean;
  }

  /** Absolute native Windows executable, immune to project-controlled PATH. */
  export function windowsSystem(
    name: string,
    env: NodeJS.ProcessEnv = process.env,
  ): string {
    return path.join(
      env.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      name,
    );
  }

  /** Append arguments without reopening cmd.exe's injection boundary. */
  export function append(
    command: IResult,
    trailing: readonly string[],
  ): IResult {
    if (trailing.length === 0) return { ...command, args: [...command.args] };
    if (command.windowsVerbatimArguments !== true) {
      return { ...command, args: [...command.args, ...trailing] };
    }
    /* c8 ignore start -- Windows-only command-processor append path. */
    const shell = command.args.at(-1);
    if (
      command.args.length !== 5 ||
      shell === undefined ||
      !shell.startsWith('"') ||
      !shell.endsWith('"')
    ) {
      throw new Error("Malformed cmd.exe provider invocation.");
    }
    const appended = trailing
      .map((argument) =>
        escapeArgument(
          argument,
          command.windowsDoubleEscapeArguments === true,
        ),
      )
      .join(" ");
    return {
      ...command,
      args: [
        ...command.args.slice(0, -1),
        `${shell.slice(0, -1)} ${appended}"`,
      ],
    };
  }
  /* c8 ignore stop */
  /* c8 ignore start -- declaration merging emits an unreachable namespace
   * creation arm after the function object already exists. */
}
/* c8 ignore stop */

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/* c8 ignore start -- Windows-only cmd.exe quoting helpers. */
function escapeCommand(value: string): string {
  return value.replace(CMD_META, "^$1");
}

/**
 * Quote one argument for cmd.exe, then protect every token cmd reparses.
 *
 * The backslash rules are CreateProcess/CommandLineToArgvW's; the caret rules
 * are cmd.exe's. npm shims add a second cmd parse while forwarding `%*`, hence
 * their metacharacters need the second escape pass.
 */
function escapeArgument(value: string, doubleEscape: boolean): string {
  let escaped = value
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META, "^$1");
  return doubleEscape ? escaped.replace(CMD_META, "^$1") : escaped;
}
/* c8 ignore stop */
