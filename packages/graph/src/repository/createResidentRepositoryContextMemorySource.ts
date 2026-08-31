import { SamchonRepositoryContextMemory } from "./SamchonRepositoryContextMemory";
import { IResidentRepositoryContextSource } from "./IResidentRepositoryContextSource";

/** Reuse the exact topology memory while its resident dump identity is stable. */
export function createResidentRepositoryContextMemorySource(
  resident: IResidentRepositoryContextSource,
): () => Promise<SamchonRepositoryContextMemory> {
  let currentDump:
    | Awaited<ReturnType<IResidentRepositoryContextSource["load"]>>
    | undefined;
  let currentMemory: SamchonRepositoryContextMemory | undefined;
  return async () => {
    const dump = await resident.load();
    if (currentMemory === undefined || dump !== currentDump) {
      currentDump = dump;
      currentMemory = new SamchonRepositoryContextMemory(dump);
    }
    return currentMemory;
  };
}
