import { GraphNodeKind } from "../../typings";

/** Canonical Java declaration key shared by javac and JDT producer lanes. */
export function javaDeclarationSymbol(props: {
  kind: GraphNodeKind;
  name: string;
  qualifiedName?: string;
  signature?: string;
  displayName?: string;
}): string {
  const qualified = callableBase(props.qualifiedName ?? props.name);
  const parameters = callableKinds.has(props.kind)
    ? parameterList(props.displayName) ?? parameterList(props.signature) ?? ""
    : "";
  return `java-declaration-v1|${props.kind}|${qualified}|${parameters.replace(/\s+/gu, "")}`;
}

function parameterList(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const open = value.indexOf("(");
  if (open < 0) return undefined;
  const close = value.indexOf(")", open + 1);
  return close < 0 ? undefined : value.slice(open + 1, close);
}

function callableBase(value: string): string {
  const open = value.indexOf("(");
  return open < 0 ? value : value.slice(0, open);
}

const callableKinds = new Set<GraphNodeKind>([
  "function",
  "method",
  "constructor",
]);
