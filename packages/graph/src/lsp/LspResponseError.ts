export class LspResponseError extends Error {
  public readonly name = "LspResponseError";

  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}
