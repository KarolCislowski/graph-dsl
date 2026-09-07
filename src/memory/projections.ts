import type {
  AggregateFunction,
  AggregateTargetExpression,
  AggregateValueExpression,
  PredicateExpression,
  Primitive,
  ReturnSelection,
  ValueExpression,
} from "../ast.js";
import {
  compareOptionalPrimitives,
  evaluateValue,
} from "./evaluate.js";
import {
  isEdge,
  isNode,
  primitiveOrNull,
  stableGroupKey,
  stableValueKey,
} from "./guards.js";
import type {
  Binding,
  MemoryContext,
  MemoryRow,
  MemoryValue,
} from "./types.js";

/**
 * Converts a projected memory row back into an execution binding.
 */
export function rowToBinding(row: MemoryRow): Binding {
  return { ...row };
}

/**
 * Sorts bindings using ORDER BY expressions and directions.
 */
export function orderBindings(
  bindings: Binding[],
  expressions: Array<{ expression: ValueExpression; direction: "asc" | "desc" }>,
  context: MemoryContext,
): Binding[] {
  return [...bindings].sort((left, right) => {
    for (const expression of expressions) {
      const result = compareOptionalPrimitives(
        evaluateValue(expression.expression, left, context),
        evaluateValue(expression.expression, right, context),
      );

      if (result !== 0) {
        return expression.direction === "asc" ? result : -result;
      }
    }

    return 0;
  });
}

/**
 * Applies a WITH projection and returns the next pipeline-stage bindings.
 */
export function projectWithBindings(
  bindings: Binding[],
  selections: ReturnSelection[],
  context: MemoryContext,
): Binding[] {
  const rows = selections.some(selectionContainsAggregate)
    ? projectAggregatedRows(bindings, selections, context)
    : bindings.map((binding) => projectRow(binding, selections, context));

  return rows.map((row) => ({ ...row }));
}

/**
 * Projects a single binding into a returned memory row.
 */
export function projectRow(binding: Binding, selections: ReturnSelection[], context: MemoryContext): MemoryRow {
  return Object.fromEntries(
    selections.map((selection) => {
      if (selection.kind === "alias") {
        return [selection.alias, binding[selection.alias] ?? null];
      }

      if (selection.kind === "aggregate") {
        return [aggregateSelectionKey(selection), null];
      }

      if (selection.kind === "expression") {
        return [selection.as, evaluateValue(selection.expression, binding, context)];
      }

      if (selection.kind === "map") {
        return [
          selection.as,
          Object.fromEntries(
            Object.entries(selection.fields).map(([key, expression]) => [
              key,
              evaluateValue(expression, binding, context),
            ]),
          ),
        ];
      }

      const entity = binding[selection.alias];
      const key = selection.as ?? `${selection.alias}.${selection.key}`;
      const value = entity && (isNode(entity) || isEdge(entity)) ? entity.properties[selection.key] ?? null : null;

      return [key, value];
    }),
  );
}

/**
 * Projects grouped aggregate rows using Cypher-like grouping semantics.
 */
export function projectAggregatedRows(
  bindings: Binding[],
  selections: ReturnSelection[],
  context: MemoryContext,
): MemoryRow[] {
  const groupSelections = selections.filter((selection) => !selectionContainsAggregate(selection));
  const aggregateSelections = selections.filter(selectionContainsAggregate);
  const groups = new Map<string, { values: MemoryRow; bindings: Binding[] }>();

  for (const binding of bindings) {
    const values = projectRow(binding, groupSelections, context);
    const key = stableGroupKey(values);
    const group = groups.get(key);

    if (group) {
      group.bindings.push(binding);
    } else {
      groups.set(key, { values, bindings: [binding] });
    }
  }

  if (groups.size === 0 && groupSelections.length === 0) {
    groups.set("__all__", { values: {}, bindings: [] });
  }

  return [...groups.values()].map((group) => ({
    ...group.values,
    ...Object.fromEntries(
      aggregateSelections.map((selection) =>
        projectAggregateSelection(selection, group.bindings, context),
      ),
    ),
  }));
}

/**
 * Checks whether projected selections require aggregate grouping.
 */
export function selectionsContainAggregate(selections: ReturnSelection[]): boolean {
  return selections.some(selectionContainsAggregate);
}

function projectAggregateSelection(
  selection: ReturnSelection,
  bindings: Binding[],
  context: MemoryContext,
): [string, MemoryValue] {
  if (selection.kind === "aggregate") {
    return [
      aggregateSelectionKey(selection),
      evaluateAggregate(
        selection.fn,
        selection.target,
        selection.args ?? [],
        selection.distinct,
        bindings,
        context,
      ),
    ];
  }

  const aggregateContext: MemoryContext = {
    ...context,
    aggregate: (expression) =>
      evaluateAggregate(
        expression.fn,
        expression.target,
        expression.args ?? [],
        expression.distinct,
        bindings,
        context,
      ),
  };
  const binding = bindings[0] ?? {};

  if (selection.kind === "expression") {
    return [selection.as, evaluateValue(selection.expression, binding, aggregateContext)];
  }

  if (selection.kind === "map") {
    return [
      selection.as,
      Object.fromEntries(
        Object.entries(selection.fields).map(([key, expression]) => [
          key,
          evaluateValue(expression, binding, aggregateContext),
        ]),
      ),
    ];
  }

  throw new Error(`Unsupported aggregate selection kind "${selection.kind}".`);
}

function evaluateAggregate(
  fn: AggregateFunction,
  target: AggregateTargetExpression,
  args: ValueExpression[],
  distinct: boolean,
  bindings: Binding[],
  context: MemoryContext,
): MemoryValue {
  const values = aggregateValues(target, bindings, fn === "count" && target.kind === "all", context);
  const aggregateInput = distinct ? distinctValues(values) : values;

  switch (fn) {
    case "count":
      return target.kind === "all" && !distinct ? bindings.length : aggregateInput.length;
    case "sum":
      return numericValues(aggregateInput).reduce((total, value) => total + value, 0);
    case "avg": {
      const numbers = numericValues(aggregateInput);
      return numbers.length === 0 ? null : numbers.reduce((total, value) => total + value, 0) / numbers.length;
    }
    case "min":
      return comparableValues(aggregateInput).sort(comparePrimitiveValues)[0] ?? null;
    case "max":
      return comparableValues(aggregateInput).sort(comparePrimitiveValues).at(-1) ?? null;
    case "collect":
      return aggregateInput.filter((value) => value !== null);
    case "stDev":
      return sampleStandardDeviation(numericValues(aggregateInput));
    case "percentileCont":
      return continuousPercentile(
        numericValues(aggregateInput),
        primitiveOrNull(args[0] ? evaluateValue(args[0], bindings[0] ?? {}, context) : null),
      );
  }
}

function sampleStandardDeviation(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  if (values.length === 1) {
    return 0;
  }

  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);

  return Math.sqrt(variance);
}

function continuousPercentile(values: number[], percentile: Primitive): number | null {
  if (values.length === 0 || typeof percentile !== "number" || percentile < 0 || percentile > 1) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = percentile * (sorted.length - 1);
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];

  if (lower === undefined || upper === undefined) {
    return null;
  }

  if (lowerIndex === upperIndex) {
    return lower;
  }

  return lower + (upper - lower) * (index - lowerIndex);
}

function aggregateValues(
  target: AggregateTargetExpression,
  bindings: Binding[],
  keepNulls: boolean,
  context: MemoryContext,
): MemoryValue[] {
  if (target.kind === "all") {
    return bindings.map((_, index) => index);
  }

  const values = bindings.map((binding) => evaluateAggregateTarget(target, binding, context));
  return keepNulls ? values : values.filter((value) => value !== null);
}

function evaluateAggregateTarget(
  target: AggregateTargetExpression,
  binding: Binding,
  context: MemoryContext,
): MemoryValue {
  switch (target.kind) {
    case "all":
      return null;
    case "aliasRef":
      return binding[target.alias] ?? null;
    default:
      return evaluateValue(target, binding, context);
  }
}

function aggregateSelectionKey(selection: Extract<ReturnSelection, { kind: "aggregate" }>): string {
  if (selection.as) {
    return selection.as;
  }

  const target = aggregateTargetName(selection.target);
  const args = (selection.args ?? []).map(aggregateTargetName);
  return `${selection.fn}(${[`${selection.distinct ? "distinct " : ""}${target}`, ...args].join(", ")})`;
}

function aggregateTargetName(target: AggregateTargetExpression): string {
  switch (target.kind) {
    case "all":
      return "*";
    case "aliasRef":
      return target.alias;
    case "mapProperty":
      return `${aggregateTargetName(target.source)}.${target.key}`;
    case "dynamicProperty":
      return `${aggregateTargetName(target.source)}[${aggregateTargetName(target.key)}]`;
    case "mapValue":
      return "map";
    case "listIndex":
      return `${aggregateTargetName(target.source)}[${aggregateTargetName(target.index)}]`;
    case "listComprehension":
      return "listComprehension";
    case "listMap":
      return "listMap";
    case "property":
      return `${target.alias}.${target.key}`;
    case "rowProperty":
      return `${target.alias}.${target.key}`;
    case "listItem":
      return target.alias;
    case "variable":
      return target.name;
    case "parameter":
      return `$${target.name}`;
    case "primitive":
      return String(target.value);
    case "function":
      return `${target.name}(...)`;
    case "arithmetic":
      return `${aggregateTargetName(target.left)} ${target.operator} ${aggregateTargetName(target.right)}`;
    case "case":
      return "case";
    case "aggregateValue":
      return `${target.fn}(...)`;
  }
}

function selectionContainsAggregate(selection: ReturnSelection): boolean {
  switch (selection.kind) {
    case "aggregate":
      return true;
    case "expression":
      return expressionContainsAggregate(selection.expression);
    case "map":
      return Object.values(selection.fields).some(expressionContainsAggregate);
    case "alias":
    case "property":
      return false;
  }
}

function expressionContainsAggregate(expression: ValueExpression): boolean {
  switch (expression.kind) {
    case "aggregateValue":
      return true;
    case "arithmetic":
      return expressionContainsAggregate(expression.left) || expressionContainsAggregate(expression.right);
    case "case":
      return (
        expression.branches.some((branch) =>
          predicateContainsAggregate(branch.when) || expressionContainsAggregate(branch.then),
        ) ||
        (expression.else ? expressionContainsAggregate(expression.else) : false)
      );
    case "function":
      return expression.args.some(expressionContainsAggregate);
    case "listIndex":
      return expressionContainsAggregate(expression.source) || expressionContainsAggregate(expression.index);
    case "listComprehension":
      return expressionContainsAggregate(expression.source) || predicateContainsAggregate(expression.predicate);
    case "mapProperty":
      return expressionContainsAggregate(expression.source);
    case "dynamicProperty":
      return expressionContainsAggregate(expression.source) || expressionContainsAggregate(expression.key);
    case "mapValue":
      return Object.values(expression.fields).some(expressionContainsAggregate);
    case "listMap":
      return expressionContainsAggregate(expression.source) || expressionContainsAggregate(expression.expression);
    case "primitive":
    case "parameter":
    case "property":
    case "rowProperty":
    case "listItem":
    case "variable":
    case "aliasRef":
      return false;
  }
}

function predicateContainsAggregate(predicate: PredicateExpression): boolean {
  switch (predicate.kind) {
    case "binary":
      return expressionContainsAggregate(predicate.left) || expressionContainsAggregate(predicate.right);
    case "logical":
      return predicate.predicates.some(predicateContainsAggregate);
    case "not":
      return predicateContainsAggregate(predicate.predicate);
    case "null":
      return expressionContainsAggregate(predicate.expression);
    case "list":
      return expressionContainsAggregate(predicate.source) || predicateContainsAggregate(predicate.predicate);
  }
}

function distinctValues(values: MemoryValue[]): MemoryValue[] {
  const seen = new Set<string>();
  const result: MemoryValue[] = [];

  for (const value of values) {
    const key = stableValueKey(value);

    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }

  return result;
}

function numericValues(values: MemoryValue[]): number[] {
  return values.filter((value): value is number => typeof value === "number");
}

function comparableValues(values: MemoryValue[]): Array<string | number> {
  return values.filter((value): value is string | number => typeof value === "string" || typeof value === "number");
}

function comparePrimitiveValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return String(left).localeCompare(String(right));
}
