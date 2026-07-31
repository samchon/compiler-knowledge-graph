/** Close every opened resident plane while retaining the first failure. */
export function createCompositeResidentClose(
  residents: readonly (
    | { close(): Promise<void> }
    | undefined
  )[],
): { close(): Promise<void> } {
  return {
    async close(): Promise<void> {
      let failure: unknown;
      for (const resident of residents) {
        if (resident === undefined) continue;
        try {
          await resident.close();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) {
        throw failure instanceof Error ? failure : new Error(String(failure));
      }
    },
  };
}
