import { ISamchonRepositoryContextDump } from "../structures";

/** Resident sibling source for repository topology. */
export interface IResidentRepositoryContextSource {
  load(options?: {
    signal?: AbortSignal;
  }): Promise<ISamchonRepositoryContextDump>;
  close(): Promise<void>;
}
