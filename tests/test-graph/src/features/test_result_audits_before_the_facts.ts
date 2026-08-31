import { TestValidator } from "@nestia/e2e";
import {
  RESULT_AUDIT,
  RESULT_AUDIT_DETAILS,
  RESULT_AUDIT_ESCAPE,
  RESULT_AUDIT_SELECTION,
} from "@samchon/graph";

import { ContractGraph } from "../internal/ContractGraph";

/**
 * A result reports what was audited first and preserves the reference contract:
 * evidence, the instruction to trust that evidence, and the `next` stop rule.
 */
export const test_result_audits_before_the_facts = async () => {
  const app = ContractGraph.createApplication();

  const overview = await ContractGraph.call(app, { type: "overview", aspect: "all" });
  TestValidator.equals(
    "audit leads, then where it leaves the question, then the facts",
    Object.keys(overview),
    ["audit", "coverage", "unresolved", "next", "result"],
  );
  TestValidator.equals("the overview is the whole answer", overview.next.action, "answer");

  // The contract fixture is a static parse, and the audit says so. It does not
  // claim a language server resolved anything, because none did.
  TestValidator.equals(
    "a result audits against the index that actually built it",
    overview.audit,
    RESULT_AUDIT("static"),
  );
  TestValidator.predicate(
    "and a parsed index never claims a compiler resolved it",
    !/compiler|type-checked|checker/i.test(RESULT_AUDIT("static")),
  );
  TestValidator.predicate(
    "a language-server index says so, because there really was one",
    RESULT_AUDIT("lsp").includes(
      "the language server's own index of this project",
    ),
  );
  TestValidator.predicate(
    "and a hybrid index claims neither of the two for all of it",
    RESULT_AUDIT("hybrid").includes("the languages one is installed for"),
  );

  const lookup = await ContractGraph.call(app, {
    type: "lookup",
    query: "Service helper",
  });
  const entrypoints = await ContractGraph.call(app, {
    type: "entrypoints",
    query: "Root.Service.run",
  });
  const tour = await ContractGraph.call(app, {
    type: "tour",
    reinterpretations: ["Root.Service.run", "helper"],
  });
  for (const output of [lookup, entrypoints, tour]) {
    TestValidator.equals(
      `${output.result.type} admits that its shortlist selection is heuristic`,
      output.audit,
      RESULT_AUDIT_SELECTION("static"),
    );
  }

  const trace = await ContractGraph.call(app, {
    type: "trace",
    from: "Root.Service.run",
    direction: "forward",
    focus: "all",
  });
  const details = await ContractGraph.call(app, {
    type: "details",
    handles: ["Root.Service.run"],
  });
  for (const output of [trace, overview]) {
    TestValidator.equals(
      `${output.result.type} reports exact graph structure for named handles`,
      output.audit,
      RESULT_AUDIT("static"),
    );
  }
  TestValidator.equals(
    "details reports its identity and fan-out completeness separately",
    details.audit,
    RESULT_AUDIT_DETAILS("static"),
  );
  const cappedDetails = await ContractGraph.call(app, {
    type: "details",
    handles: ["Root.Service"],
    memberLimit: 1,
  });
  TestValidator.predicate(
    "an explicit member cap makes the audit deny whole-member coverage",
    cappedDetails.audit === RESULT_AUDIT_DETAILS("static", 1) &&
      cappedDetails.audit.includes("explicit cap") &&
      !cappedDetails.audit.includes("members, values, and signature — is returned whole"),
  );

  // The audit states its evidence before it instructs, and the instruction it
  // does give hands the stop rule to `next` rather than claiming it.
  for (const lane of ["lsp", "static", "hybrid"] as const) {
    const audit = RESULT_AUDIT(lane);
    const selectionAudit = RESULT_AUDIT_SELECTION(lane);
    TestValidator.predicate(
      `the ${lane} audit says what was checked before it says what to do`,
      audit.indexOf("AUDITED BEFORE RETURNING") <
        audit.indexOf("Trust every fact it gives"),
    );
    TestValidator.predicate(
      `the ${lane} audit defers the stop rule to next`,
      audit.includes("re-call the graph only when it says inspect"),
    );
    TestValidator.predicate(
      `the ${lane} audit does not borrow compiler certainty`,
      !audit.includes("100%, NOT ONE ERROR") &&
        !audit.includes("cannot be wrong"),
    );
    TestValidator.predicate(
      `the ${lane} shortlist audit distinguishes facts from coverage`,
      selectionAudit.includes("heuristic, not exhaustive") &&
        selectionAudit.includes("the shortlist covers what you asked"),
    );
    TestValidator.notEquals(
      `the ${lane} exact and shortlist audits remain distinct`,
      audit,
      selectionAudit,
    );
  }

  // An escape runs no graph operation and returns no node, span, edge, or step.
  // It has nothing to have audited, and a payload that swears it holds no ranked
  // or guessed-at fact must not itself be one.
  const escape = await ContractGraph.call(app, {
    type: "escape",
    reason: "The next evidence is a function's body, which the graph does not carry.",
    nextStep: "Read the returned sourceSpan.",
  });
  TestValidator.equals(
    "an escape claims no graph facts",
    escape.audit,
    RESULT_AUDIT_ESCAPE,
  );
  TestValidator.equals("an escape leaves the graph", escape.next.action, "outside");
  TestValidator.equals("an escape marks itself skipped", (escape.result as { skipped?: boolean }).skipped, true);
  TestValidator.equals(
    "an escape carries the caller's next step",
    (escape.result as { nextStep?: string }).nextStep,
    "Read the returned sourceSpan.",
  );

  // `next` may carry only a fact about the request that was just answered. A
  // handle the graph holds no node for is one such fact; so is a lookup that
  // matched nothing, and a first-pass handle list that is partial by design.
  const unknown = await ContractGraph.call(app, {
    type: "details",
    handles: ["NoSuchSymbolAnywhere"],
  });
  TestValidator.equals(
    "a handle that resolves to nothing sends the caller outside",
    unknown.next.action,
    "outside",
  );

  const empty = await ContractGraph.call(app, { type: "lookup", query: "!!!" });
  TestValidator.equals(
    "a query with no searchable terms asks the caller to restate it",
    empty.next.action,
    "clarify",
  );

  TestValidator.equals(
    "a first-pass handle list is partial by design",
    entrypoints.next.action,
    "inspect",
  );
  TestValidator.equals(
    "and it names the one request that completes the answer",
    entrypoints.next.request,
    "trace",
  );
};
