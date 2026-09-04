import { ResidentGraphProducerClient } from "../compiler/ResidentGraphProducerClient";

/** Kotlin specialization of the restartable compiler-producer transport. */
export class KotlinGraphProducerClient extends ResidentGraphProducerClient {
  public constructor(options: KotlinGraphProducerClient.IOptions) {
    super({
      ...options,
      serverCommand: "kotlin-graph-server",
      label: "Kotlin graph",
    });
  }
}

export namespace KotlinGraphProducerClient {
  export type IOptions = Omit<
    ResidentGraphProducerClient.IOptions,
    "serverCommand" | "label"
  >;
}
