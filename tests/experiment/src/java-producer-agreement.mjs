import fs from "node:fs";
import path from "node:path";

import {
  buildGraphDump,
  javaDeclarationSymbol,
  semanticGraphNodeId,
} from "@samchon/graph";

const JAVAC_OVERRIDE = "SAMCHON_GRAPH_JAVAC_GRAPH";
const JDT_OVERRIDE = "SAMCHON_GRAPH_JDT_WORKSPACE";
const JAVAC_PROVIDER = "javac-graph";
const JDT_PROVIDER = "jdt-workspace";
const TARGET = "maven:.";

/** Prove that the two compiler-owned Java lanes agree on persistent IDs. */
export const runJavaProducerAgreement = async (experiment, root) => {
  const javacLauncher = process.env[JAVAC_OVERRIDE];
  const jdtLauncher = process.env[JDT_OVERRIDE];
  if (typeof javacLauncher !== "string" || !path.isAbsolute(javacLauncher)) {
    throw new Error("java agreement: the pinned javac producer is not configured");
  }
  if (typeof jdtLauncher !== "string" || !path.isAbsolute(jdtLauncher)) {
    throw new Error("java agreement: the pinned JDT producer is not configured");
  }

  const source = path.join(
    root,
    "src",
    "main",
    "java",
    "com",
    "ProducerAgreement.java",
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(
    source,
    [
      "package com;",
      "",
      "public final class ProducerAgreement {",
      "    public final int value;",
      "",
      "    public ProducerAgreement(int value) {",
      "        this.value = value;",
      "    }",
      "",
      "    public int twice(int factor) {",
      "        return value * factor;",
      "    }",
      "}",
      "",
    ].join("\n"),
  );

  const options = {
    cwd: root,
    mode: "lsp",
    languages: ["java"],
    lspTimeoutMs: experiment.timeoutMs ?? 60_000,
    lspReadyTimeoutMs: experiment.readyTimeoutMs ?? 180_000,
    lspWarmupTimeoutMs: experiment.warmupTimeoutMs ?? 180_000,
  };
  const javac = await buildGraphDump(options);
  const previousPath = process.env.PATH ?? "";
  const javacBin = path.dirname(path.resolve(javacLauncher));
  try {
    delete process.env[JAVAC_OVERRIDE];
    process.env.PATH = previousPath
      .split(path.delimiter)
      .filter(
        (candidate) =>
          candidate !== "" && path.resolve(candidate) !== javacBin,
      )
      .join(path.delimiter);
    const jdt = await buildGraphDump(options);
    return assertAgreement(javac, jdt);
  } finally {
    process.env[JAVAC_OVERRIDE] = javacLauncher;
    process.env.PATH = previousPath;
  }
};

function assertAgreement(javac, jdt) {
  const javacProvenance = strictProvenance(javac, JAVAC_PROVIDER);
  const jdtProvenance = strictProvenance(jdt, JDT_PROVIDER);
  if (
    javacProvenance.provider === jdtProvenance.provider ||
    javacProvenance.producer.tool === jdtProvenance.producer.tool ||
    javacProvenance.universe === jdtProvenance.universe
  ) {
    throw new Error(
      `java agreement: distinct producers published indistinguishable provenance: ${JSON.stringify({ javac: javacProvenance, jdt: jdtProvenance })}`,
    );
  }
  if (
    jdtProvenance.facts.length !== 1 ||
    jdtProvenance.facts[0] !== "contains"
  ) {
    throw new Error(
      `java agreement: JDT published facts beyond containment: ${jdtProvenance.facts.join(", ")}`,
    );
  }

  const declarations = [
    declaration("class", "ProducerAgreement", "com.ProducerAgreement"),
    declaration("field", "value", "com.ProducerAgreement.value"),
    declaration(
      "constructor",
      "ProducerAgreement",
      "com.ProducerAgreement.ProducerAgreement",
      "int",
    ),
    declaration("method", "twice", "com.ProducerAgreement.twice", "int"),
  ];
  for (const expected of declarations) {
    const javacNode = javac.nodes.find((node) => node.id === expected.id);
    const jdtNode = jdt.nodes.find((node) => node.id === expected.id);
    if (javacNode === undefined || jdtNode === undefined) {
      throw new Error(
        `java agreement: ${expected.kind} ${expected.qualifiedName} did not share ${expected.id}`,
      );
    }
    for (const node of [javacNode, jdtNode]) {
      if (
        node.kind !== expected.kind ||
        node.name !== expected.name ||
        node.qualifiedName !== expected.qualifiedName
      ) {
        throw new Error(
          `java agreement: ${expected.id} carried incompatible declaration metadata: ${JSON.stringify(node)}`,
        );
      }
    }
  }

  return {
    target: TARGET,
    declarations: declarations.map(({ id, kind, qualifiedName }) => ({
      id,
      kind,
      qualifiedName,
    })),
    javac: provenanceSummary(javacProvenance),
    jdt: provenanceSummary(jdtProvenance),
  };
}

function declaration(kind, name, qualifiedName, parameters = "") {
  const symbol = javaDeclarationSymbol({
    kind,
    name,
    qualifiedName,
    ...(parameters === "" ? {} : { signature: `(${parameters})` }),
  });
  return {
    id: semanticGraphNodeId(
      {
        version: 2,
        language: "java",
        symbol,
        role: kind,
        native: { key: symbol, stability: "semantic" },
        scope: { target: TARGET },
        stability: "persistent",
      },
      qualifiedName,
    ),
    kind,
    name,
    qualifiedName,
  };
}

function strictProvenance(dump, provider) {
  const provenance = dump.provenance?.find(
    (candidate) => candidate.provider === provider,
  );
  if (provenance === undefined) {
    throw new Error(
      `java agreement: ${provider} did not publish strict provenance: ${(dump.warnings ?? []).join("; ")}`,
    );
  }
  return provenance;
}

function provenanceSummary(provenance) {
  return {
    provider: provenance.provider,
    producer: provenance.producer,
    universe: provenance.universe,
    manifest: provenance.manifest,
    content: provenance.content,
    facts: provenance.facts,
  };
}
