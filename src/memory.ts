import type {
  EdgePattern,
  NodePattern,
  Pattern,
  PredicateExpression,
  Primitive,
  QueryAst,
  ReturnSelection,
  ValueExpression,
} from "./ast.js";

export type MemoryNode = {
  id: string;
  labels: string[];
  properties: Record<string, Primitive>;
};

export type MemoryEdge = {
  id: string;
  label: string;
  from: string;
  to: string;
  properties: Record<string, Primitive>;
};

export type MemoryGraph = {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
};

export type MemoryExecuteOptions = {
  params?: Record<string, Primitive>;
};

export type MemoryRow = Record<string, MemoryNode | MemoryEdge | Primitive>;

type Binding = Record<string, MemoryNode | MemoryEdge>;
type MemoryContext = {
  params: Record<string, Primitive>;
};

export function executeMemory(
  ast: QueryAst,
  graph: MemoryGraph,
  options: MemoryExecuteOptions = {},
): MemoryRow[] {
  const context: MemoryContext = {
    params: options.params ?? {},
  };

  let bindings: Binding[] = [{}];
  let selections: ReturnSelection[] | undefined;

  for (const clause of ast.clauses) {
    switch (clause.kind) {
      case "match":
        bindings = matchPatterns(bindings, clause.patterns, graph, context);
        break;
      case "create":
        bindings = createPatterns(bindings, clause.patterns, graph, context);
        break;
      case "where":
        bindings = bindings.filter((binding) => evaluatePredicate(clause.predicate, binding, context));
        break;
      case "set":
        bindings = bindings.map((binding) => setProperty(binding, clause.alias, clause.key, clause.value, context));
        break;
      case "delete":
        deleteAliases(bindings, clause.aliases, graph);
        break;
      case "return":
        selections = clause.selections;
        break;
    }
  }

  if (!selections) {
    return bindings;
  }

  return bindings.map((binding) => projectRow(binding, selections));
}

function matchPatterns(
  bindings: Binding[],
  patterns: Pattern[],
  graph: MemoryGraph,
  context: MemoryContext,
): Binding[] {
  return patterns.reduce(
    (currentBindings, pattern) =>
      currentBindings.flatMap((binding) => matchPattern(binding, pattern, graph, context)),
    bindings,
  );
}

function matchPattern(
  binding: Binding,
  pattern: Pattern,
  graph: MemoryGraph,
  context: MemoryContext,
): Binding[] {
  if (pattern.kind === "node") {
    return graph.nodes
      .filter((node) => matchesNode(pattern, node, binding, context))
      .flatMap((node) => bindEntity(binding, pattern.alias, node));
  }

  return graph.edges
    .filter((edge) => matchesEdge(pattern, edge, binding, context))
    .flatMap((edge) => {
      const nextBinding = pattern.alias ? bindEntity(binding, pattern.alias, edge) : [binding];
      return nextBinding;
    });
}

function createPatterns(
  bindings: Binding[],
  patterns: Pattern[],
  graph: MemoryGraph,
  context: MemoryContext,
): Binding[] {
  return patterns.reduce(
    (currentBindings, pattern) =>
      currentBindings.map((binding) => createPattern(binding, pattern, graph, context)),
    bindings,
  );
}

function createPattern(
  binding: Binding,
  pattern: Pattern,
  graph: MemoryGraph,
  context: MemoryContext,
): Binding {
  if (pattern.kind === "node") {
    const existing = binding[pattern.alias];

    if (existing) {
      return binding;
    }

    const node: MemoryNode = {
      id: nextId("node", graph.nodes),
      labels: pattern.labels,
      properties: evaluateProperties(pattern.properties, binding, context),
    };

    graph.nodes.push(node);
    return { ...binding, [pattern.alias]: node };
  }

  const from = binding[pattern.from];
  const to = binding[pattern.to];

  if (!from || !to || !isNode(from) || !isNode(to)) {
    throw new Error(`Cannot create edge "${pattern.label}" without bound from/to nodes.`);
  }

  const edge: MemoryEdge = {
    id: nextId("edge", graph.edges),
    label: pattern.label,
    from: pattern.direction === "in" ? to.id : from.id,
    to: pattern.direction === "in" ? from.id : to.id,
    properties: evaluateProperties(pattern.properties, binding, context),
  };

  graph.edges.push(edge);

  if (!pattern.alias) {
    return binding;
  }

  return { ...binding, [pattern.alias]: edge };
}

function matchesNode(
  pattern: NodePattern,
  node: MemoryNode,
  binding: Binding,
  context: MemoryContext,
): boolean {
  return (
    pattern.labels.every((label) => node.labels.includes(label)) &&
    Object.entries(pattern.properties).every(([key, expression]) =>
      node.properties[key] === evaluateValue(expression, binding, context),
    )
  );
}

function matchesEdge(
  pattern: EdgePattern,
  edge: MemoryEdge,
  binding: Binding,
  context: MemoryContext,
): boolean {
  if (edge.label !== pattern.label) {
    return false;
  }

  const from = binding[pattern.from];
  const to = binding[pattern.to];

  if (!from || !to || !isNode(from) || !isNode(to)) {
    return false;
  }

  const directionMatches =
    pattern.direction === "both"
      ? (edge.from === from.id && edge.to === to.id) || (edge.from === to.id && edge.to === from.id)
      : pattern.direction === "out"
        ? edge.from === from.id && edge.to === to.id
        : edge.from === to.id && edge.to === from.id;

  return (
    directionMatches &&
    Object.entries(pattern.properties).every(([key, expression]) =>
      edge.properties[key] === evaluateValue(expression, binding, context),
    )
  );
}

function setProperty(
  binding: Binding,
  alias: string,
  key: string,
  nextValue: ValueExpression,
  context: MemoryContext,
): Binding {
  const entity = binding[alias];

  if (!entity) {
    return binding;
  }

  entity.properties[key] = evaluateValue(nextValue, binding, context);
  return binding;
}

function deleteAliases(bindings: Binding[], aliases: string[], graph: MemoryGraph): void {
  const ids = new Set(
    bindings.flatMap((binding) =>
      aliases.flatMap((alias) => {
        const entity = binding[alias];
        return entity ? [entity.id] : [];
      }),
    ),
  );

  const nodeIds = new Set(graph.nodes.filter((node) => ids.has(node.id)).map((node) => node.id));

  graph.edges = graph.edges.filter(
    (edge) => !ids.has(edge.id) && !nodeIds.has(edge.from) && !nodeIds.has(edge.to),
  );
  graph.nodes = graph.nodes.filter((node) => !ids.has(node.id));
}

function bindEntity<T extends MemoryNode | MemoryEdge>(binding: Binding, alias: string, entity: T): Binding[] {
  const existing = binding[alias];

  if (existing && existing.id !== entity.id) {
    return [];
  }

  return [{ ...binding, [alias]: entity }];
}

function evaluatePredicate(
  predicate: PredicateExpression,
  binding: Binding,
  context: { params: Record<string, Primitive> },
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
  }
}

function evaluateBinary(operator: string, left: Primitive, right: Primitive): boolean {
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
    default:
      throw new Error(`Unsupported operator "${operator}".`);
  }
}

function compare(left: Primitive, right: Primitive, compareValues: (left: number, right: number) => boolean): boolean {
  return typeof left === "number" && typeof right === "number" && compareValues(left, right);
}

function evaluateValue(
  expression: ValueExpression,
  binding: Binding,
  context: MemoryContext,
): Primitive {
  switch (expression.kind) {
    case "primitive":
      return expression.value;
    case "parameter":
      return context.params[expression.name] ?? null;
    case "property": {
      const entity = binding[expression.alias];

      if (!entity) {
        return null;
      }

      return entity.properties[expression.key] ?? null;
    }
  }
}

function evaluateProperties(
  properties: Record<string, ValueExpression>,
  binding: Binding,
  context: MemoryContext,
): Record<string, Primitive> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, expression]) => [key, evaluateValue(expression, binding, context)]),
  );
}

function nextId(prefix: "node" | "edge", entities: Array<MemoryNode | MemoryEdge>): string {
  const usedIds = new Set(entities.map((entity) => entity.id));
  let index = entities.length + 1;

  while (usedIds.has(`${prefix}-${index}`)) {
    index += 1;
  }

  return `${prefix}-${index}`;
}

function projectRow(binding: Binding, selections: ReturnSelection[]): MemoryRow {
  return Object.fromEntries(
    selections.map((selection) => {
      if (selection.kind === "alias") {
        return [selection.alias, binding[selection.alias] ?? null];
      }

      const entity = binding[selection.alias];
      const key = selection.as ?? `${selection.alias}.${selection.key}`;
      const value = entity ? entity.properties[selection.key] ?? null : null;

      return [key, value];
    }),
  );
}

function isNode(entity: MemoryNode | MemoryEdge): entity is MemoryNode {
  return "labels" in entity;
}
