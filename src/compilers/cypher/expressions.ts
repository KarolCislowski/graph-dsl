import type {
  AggregateTargetExpression,
  FunctionArgumentExpression,
  PredicateExpression,
  ReturnSelection,
  ValueExpression,
} from "../../ast.js";
import { escapeIdentifier } from "./identifiers.js";
import type { CypherContext } from "./types.js";

export function compilePredicate(predicate: PredicateExpression, context: CypherContext): string {
  switch (predicate.kind) {
    case "binary": {
      const operator =
        predicate.operator === "contains"
          ? "CONTAINS"
          : predicate.operator === "!="
            ? "<>"
            : predicate.operator === "in"
              ? "IN"
              : predicate.operator;
      return `${compileValue(predicate.left, context)} ${operator} ${compileValue(predicate.right, context)}`;
    }
    case "logical":
      return predicate.predicates
        .map((child) => `(${compilePredicate(child, context)})`)
        .join(` ${predicate.operator.toUpperCase()} `);
    case "not":
      return `NOT (${compilePredicate(predicate.predicate, context)})`;
    case "list":
      return `${predicate.operator}(${escapeIdentifier(predicate.alias)} IN ${compileValue(
        predicate.source,
        context,
      )} WHERE ${compilePredicate(predicate.predicate, context)})`;
  }
}

export function compileReturnSelection(selection: ReturnSelection, context: CypherContext): string {
  switch (selection.kind) {
    case "alias":
      return escapeIdentifier(selection.alias);
    case "property": {
      const expression = `${escapeIdentifier(selection.alias)}.${escapeIdentifier(selection.key)}`;
      return selection.as ? `${expression} AS ${escapeIdentifier(selection.as)}` : expression;
    }
    case "aggregate": {
      const target = `${selection.distinct ? "DISTINCT " : ""}${compileAggregateTarget(selection.target, context)}`;
      const args = (selection.args ?? []).map((arg) => compileValue(arg, context));
      const expression = `${selection.fn}(${[target, ...args].join(", ")})`;
      return selection.as ? `${expression} AS ${escapeIdentifier(selection.as)}` : expression;
    }
    case "expression":
      return `${compileValue(selection.expression, context)} AS ${escapeIdentifier(selection.as)}`;
    case "map":
      return `${compileMapFields(selection.fields, context)} AS ${escapeIdentifier(selection.as)}`;
  }
}

export function compileValue(expression: ValueExpression, context: CypherContext): string {
  switch (expression.kind) {
    case "primitive": {
      const name = `p${context.literalIndex++}`;
      context.params[name] = expression.value;
      return `$${name}`;
    }
    case "parameter":
      return `$${expression.name}`;
    case "property":
      return `${escapeIdentifier(expression.alias)}.${escapeIdentifier(expression.key)}`;
    case "rowProperty":
      return `${escapeIdentifier(expression.alias)}.${escapeIdentifier(expression.key)}`;
    case "listItem":
      return escapeIdentifier(expression.alias);
    case "variable":
      return escapeIdentifier(expression.name);
    case "function":
      return `${expression.name}(${expression.args.map((arg) => compileFunctionArgument(arg, context)).join(", ")})`;
    case "arithmetic":
      return `(${compileValue(expression.left, context)} ${expression.operator} ${compileValue(expression.right, context)})`;
    case "case":
      return compileCaseExpression(expression, context);
  }
}

function compileMapFields(fields: Record<string, ValueExpression>, context: CypherContext): string {
  const body = Object.entries(fields)
    .map(([key, expression]) => `${escapeIdentifier(key)}: ${compileValue(expression, context)}`)
    .join(", ");

  return `{ ${body} }`;
}

function compileAggregateTarget(target: AggregateTargetExpression, context: CypherContext): string {
  switch (target.kind) {
    case "all":
      return "*";
    case "aliasRef":
      return escapeIdentifier(target.alias);
    default:
      return compileValue(target, context);
  }
}

function compileCaseExpression(
  expression: Extract<ValueExpression, { kind: "case" }>,
  context: CypherContext,
): string {
  const branches = expression.branches
    .map((branch) => `WHEN ${compilePredicate(branch.when, context)} THEN ${compileValue(branch.then, context)}`)
    .join(" ");

  return `CASE ${branches} ELSE ${compileValue(expression.else, context)} END`;
}

function compileFunctionArgument(argument: FunctionArgumentExpression, context: CypherContext): string {
  if (argument.kind === "aliasRef") {
    return escapeIdentifier(argument.alias);
  }

  return compileValue(argument, context);
}
