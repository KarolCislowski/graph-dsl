import type {
  FunctionArgumentExpression,
  PredicateExpression,
  Primitive,
  ValueExpression,
} from "../ast.js";
import {
  isEdge,
  isNode,
  isPrimitive,
  isRowObject,
  isRowObjectArray,
  parameterValueToMemoryValue,
  primitiveOrNull,
} from "./guards.js";
import type {
  Binding,
  MemoryContext,
  MemoryRowObject,
  MemoryValue,
} from "./types.js";

/**
 * Evaluates a predicate against the current memory binding.
 */
export function evaluatePredicate(
  predicate: PredicateExpression,
  binding: Binding,
  context: MemoryContext,
): boolean {
  switch (predicate.kind) {
    case "binary":
      return evaluateBinary(
        predicate.operator,
        evaluateValue(predicate.left, binding, context),
        evaluateValue(predicate.right, binding, context),
      );
    case "logical":
      return predicate.operator === "and"
        ? predicate.predicates.every((child) => evaluatePredicate(child, binding, context))
        : predicate.predicates.some((child) => evaluatePredicate(child, binding, context));
    case "not":
      return !evaluatePredicate(predicate.predicate, binding, context);
    case "list": {
      const values = evaluateValue(predicate.source, binding, context);

      if (!Array.isArray(values)) {
        return predicate.operator === "all";
      }

      return predicate.operator === "any"
        ? values.some((value) =>
          evaluatePredicate(predicate.predicate, binding, {
            ...context,
            listItems: {
              ...(context.listItems ?? {}),
              [predicate.alias]: value,
            },
          }),
        )
        : values.every((value) =>
          evaluatePredicate(predicate.predicate, binding, {
            ...context,
            listItems: {
              ...(context.listItems ?? {}),
              [predicate.alias]: value,
            },
          }),
        );
    }
  }
}

/**
 * Evaluates a binary predicate operator using memory executor comparison semantics.
 */
export function evaluateBinary(operator: string, left: MemoryValue, right: MemoryValue): boolean {
  switch (operator) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return compare(left, right, (a, b) => a > b);
    case ">=":
      return compare(left, right, (a, b) => a >= b);
    case "<":
      return compare(left, right, (a, b) => a < b);
    case "<=":
      return compare(left, right, (a, b) => a <= b);
    case "contains":
      return typeof left === "string" && typeof right === "string" && left.includes(right);
    case "in":
      return Array.isArray(right) && right.some((value) => isPrimitive(value) && value === left);
    default:
      throw new Error(`Unsupported operator "${operator}".`);
  }
}

/**
 * Evaluates a value expression against the current memory binding.
 */
export function evaluateValue(
  expression: ValueExpression,
  binding: Binding,
  context: MemoryContext,
): MemoryValue {
  switch (expression.kind) {
    case "primitive":
      return expression.value;
    case "parameter":
      return parameterValueToMemoryValue(context.params[expression.name]);
    case "property": {
      const entity = binding[expression.alias];

      if (!entity) {
        return null;
      }

      if (isNode(entity) || isEdge(entity)) {
        return entity.properties[expression.key] ?? null;
      }

      if (isRowObject(entity)) {
        return entity[expression.key] ?? null;
      }

      return null;
    }
    case "rowProperty": {
      const row = binding[expression.alias];

      if (!isRowObject(row)) {
        return null;
      }

      return row[expression.key] ?? null;
    }
    case "listItem":
      return context.listItems?.[expression.alias] ?? null;
    case "variable":
      return primitiveOrNull(binding[expression.name]);
    case "function":
      return evaluateFunction(expression.name, expression.args, binding, context);
    case "arithmetic":
      return evaluateArithmetic(
        expression.operator,
        evaluateValue(expression.left, binding, context),
        evaluateValue(expression.right, binding, context),
      );
    case "case":
      for (const branch of expression.branches) {
        if (evaluatePredicate(branch.when, binding, context)) {
          return evaluateValue(branch.then, binding, context);
        }
      }

      return evaluateValue(expression.else, binding, context);
  }
}

/**
 * Evaluates an expression as an UNWIND source, returning row objects only.
 */
export function evaluateList(
  expression: ValueExpression,
  binding: Binding,
  context: MemoryContext,
): MemoryRowObject[] {
  if (expression.kind === "parameter") {
    const value = context.params[expression.name];
    return isRowObjectArray(value) ? value : [];
  }

  const value = evaluateValue(expression, binding, context);
  return isRowObjectArray(value) ? value : [];
}

/**
 * Evaluates pattern property expressions into primitive property values.
 */
export function evaluateProperties(
  properties: Record<string, ValueExpression>,
  binding: Binding,
  context: MemoryContext,
): Record<string, Primitive> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, expression]) => [key, primitiveOrNull(evaluateValue(expression, binding, context))]),
  );
}

/**
 * Evaluates SKIP/LIMIT counts, accepting either a literal integer or an integer parameter.
 */
export function evaluateResultCount(
  count: number | { kind: "parameter"; name: string },
  context: MemoryContext,
): number {
  if (typeof count === "number") {
    return count;
  }

  const value = context.params[count.name];

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Expected parameter "${count.name}" to be a non-negative integer.`);
  }

  return value;
}

/**
 * Compares nullable primitive-ish values for ORDER BY in the memory executor.
 */
export function compareOptionalPrimitives(left: MemoryValue, right: MemoryValue): number {
  if (left === right) {
    return 0;
  }

  if (!isPrimitive(left)) {
    return 1;
  }

  if (!isPrimitive(right)) {
    return -1;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return String(left).localeCompare(String(right));
}

function compare(left: MemoryValue, right: MemoryValue, compareValues: (left: number, right: number) => boolean): boolean {
  return typeof left === "number" && typeof right === "number" && compareValues(left, right);
}

function evaluateArithmetic(operator: string, left: MemoryValue, right: MemoryValue): Primitive {
  if (typeof left !== "number" || typeof right !== "number") {
    return null;
  }

  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return right === 0 ? null : left / right;
    default:
      throw new Error(`Unsupported arithmetic operator "${operator}".`);
  }
}

function evaluateFunction(
  name:
    | "elementId"
    | "type"
    | "labels"
    | "coalesce"
    | "toFloat"
    | "toString"
    | "toInteger"
    | "floor"
    | "round"
    | "properties",
  args: FunctionArgumentExpression[],
  binding: Binding,
  context: MemoryContext,
): MemoryValue {
  switch (name) {
    case "elementId": {
      const target = evaluateFunctionArgument(args[0], binding, context);
      return isNode(target) || isEdge(target) ? target.id : null;
    }
    case "type": {
      const target = evaluateFunctionArgument(args[0], binding, context);
      return isEdge(target) ? target.label : null;
    }
    case "labels": {
      const target = evaluateFunctionArgument(args[0], binding, context);
      return isNode(target) ? target.labels : [];
    }
    case "coalesce":
      for (const argument of args) {
        const value = evaluateFunctionArgument(argument, binding, context);

        if (value !== null) {
          return value;
        }
      }

      return null;
    case "toFloat":
      return toFiniteNumber(evaluateFunctionArgument(args[0], binding, context));
    case "toString": {
      const value = evaluateFunctionArgument(args[0], binding, context);
      return isPrimitive(value) && value !== null ? String(value) : null;
    }
    case "toInteger": {
      const value = toFiniteNumber(evaluateFunctionArgument(args[0], binding, context));
      return value === null ? null : Math.trunc(value);
    }
    case "floor": {
      const value = toFiniteNumber(evaluateFunctionArgument(args[0], binding, context));
      return value === null ? null : Math.floor(value);
    }
    case "round": {
      const value = toFiniteNumber(evaluateFunctionArgument(args[0], binding, context));
      return value === null ? null : Math.round(value);
    }
    case "properties": {
      const target = evaluateFunctionArgument(args[0], binding, context);
      return isNode(target) || isEdge(target) ? { ...target.properties } : {};
    }
  }
}

function toFiniteNumber(value: MemoryValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return null;
}

function evaluateFunctionArgument(
  argument: FunctionArgumentExpression | undefined,
  binding: Binding,
  context: MemoryContext,
): MemoryValue {
  if (!argument) {
    return null;
  }

  if (argument.kind === "aliasRef") {
    return binding[argument.alias] ?? null;
  }

  return evaluateValue(argument, binding, context);
}
