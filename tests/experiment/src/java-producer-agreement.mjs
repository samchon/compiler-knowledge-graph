import fs from "node:fs";
import path from "node:path";

import {
  buildGraphDump,
  javaDeclarationSymbol,
  semanticGraphNodeId,
} from "@samchon/graph";

import { run } from "./process.mjs";

const JAVAC_OVERRIDE = "SAMCHON_GRAPH_JAVAC_GRAPH";
const JDT_OVERRIDE = "SAMCHON_GRAPH_JDT_WORKSPACE";
const JAVAC_PROVIDER = "javac-graph";
const JDT_PROVIDER = "jdt-workspace";

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

  writeAgreementClass(
    path.join(root, "src", "main", "java", "com"),
    "ProducerAgreement",
  );
  const maven = await compareProducers({
    experiment,
    root,
    javacLauncher,
    label: "Maven root",
    declarations: declarationsFor("ProducerAgreement", "maven:."),
  });

  const gradleRoot = path.join(root, ".samchon-graph-gradle-agreement");
  prepareGradleAgreement(gradleRoot);
  const gradle = await compareProducers({
    experiment,
    root: gradleRoot,
    javacLauncher,
    label: "Gradle main/test/module",
    declarations: [
      ...declarationsFor("GradleMainAgreement", ":compileJava"),
      ...declarationsFor("GradleTestAgreement", ":compileTestJava"),
      ...declarationsFor(
        "GradleModuleAgreement",
        ":module:compileJava",
      ),
    ],
  });
  return { maven, gradle };
};

async function compareProducers({
  experiment,
  root,
  javacLauncher,
  label,
  declarations,
}) {
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
    return assertAgreement(javac, jdt, label, declarations);
  } finally {
    process.env[JAVAC_OVERRIDE] = javacLauncher;
    process.env.PATH = previousPath;
  }
}

function assertAgreement(javac, jdt, label, declarations) {
  const javacProvenance = strictProvenance(javac, JAVAC_PROVIDER);
  const jdtProvenance = strictProvenance(jdt, JDT_PROVIDER);
  if (
    javacProvenance.provider === jdtProvenance.provider ||
    javacProvenance.producer.tool === jdtProvenance.producer.tool ||
    javacProvenance.universe === jdtProvenance.universe
  ) {
    throw new Error(
      `java agreement (${label}): distinct producers published indistinguishable provenance: ${JSON.stringify({ javac: javacProvenance, jdt: jdtProvenance })}`,
    );
  }
  if (
    jdtProvenance.facts.length !== 1 ||
    jdtProvenance.facts[0] !== "contains"
  ) {
    throw new Error(
      `java agreement (${label}): JDT published facts beyond containment: ${jdtProvenance.facts.join(", ")}`,
    );
  }

  for (const expected of declarations) {
    const javacNode = javac.nodes.find((node) => node.id === expected.id);
    const jdtNode = jdt.nodes.find((node) => node.id === expected.id);
    if (javacNode === undefined || jdtNode === undefined) {
      throw new Error(
        `java agreement (${label}): ${expected.kind} ${expected.qualifiedName} did not share ${expected.id}`,
      );
    }
    for (const node of [javacNode, jdtNode]) {
      if (
        node.kind !== expected.kind ||
        node.name !== expected.name ||
        node.qualifiedName !== expected.qualifiedName
      ) {
        throw new Error(
          `java agreement (${label}): ${expected.id} carried incompatible declaration metadata: ${JSON.stringify(node)}`,
        );
      }
    }
  }

  return {
    targets: [...new Set(declarations.map((row) => row.target))],
    declarations: declarations.map(({ id, kind, qualifiedName }) => ({
      id,
      kind,
      qualifiedName,
    })),
    javac: provenanceSummary(javacProvenance),
    jdt: provenanceSummary(jdtProvenance),
  };
}

function declarationsFor(className, target) {
  const qualified = `com.${className}`;
  return [
    declaration("class", className, qualified, target),
    declaration("field", "value", `${qualified}.value`, target),
    declaration(
      "constructor",
      className,
      `${qualified}.${className}`,
      target,
      "int",
    ),
    declaration("method", "twice", `${qualified}.twice`, target, "int"),
  ];
}

function declaration(
  kind,
  name,
  qualifiedName,
  target,
  parameters = "",
) {
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
        scope: { target },
        stability: "persistent",
      },
      qualifiedName,
    ),
    kind,
    name,
    qualifiedName,
    target,
  };
}

function prepareGradleAgreement(root) {
  fs.rmSync(root, { force: true, recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "settings.gradle"),
    "rootProject.name = 'producer-agreement'\ninclude 'module'\n",
  );
  fs.writeFileSync(
    path.join(root, "build.gradle"),
    "plugins { id 'java' }\n",
  );
  fs.mkdirSync(path.join(root, "module"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "module", "build.gradle"),
    "plugins { id 'java' }\n",
  );
  writeAgreementClass(
    path.join(root, "src", "main", "java", "com"),
    "GradleMainAgreement",
  );
  writeAgreementClass(
    path.join(root, "src", "test", "java", "com"),
    "GradleTestAgreement",
  );
  writeAgreementClass(
    path.join(root, "module", "src", "main", "java", "com"),
    "GradleModuleAgreement",
  );
  run(
    "gradle",
    ["wrapper", "--gradle-version", "9.4.1", "--no-daemon"],
    { cwd: root },
  );
}

function writeAgreementClass(directory, className) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${className}.java`),
    [
      "package com;",
      "",
      `public final class ${className} {`,
      "    public final int value;",
      "",
      `    public ${className}(int value) {`,
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
