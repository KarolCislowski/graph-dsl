import type {
  AggregateFunction,
  AggregateTargetExpression,
  EdgePattern,
  NodePattern,
  ParameterValue,
  PathPattern,
  Pattern,
  PredicateExpression,
  Primitive,
  QueryAst,
  ReturnSelection,
  ValueExpression,
} from "./ast.js";

/**
 * Node stored by the in-memory graph executor.
 */
export type MemoryNode = {
  /**
   * Stable node identifier.
   */
  id: string;
  /**
   * Node labels.
   */
  labels: string[];
  /**
   * Primitive node properties.
   */
  properties: Record<string, Primitive>;
};

/**
 * Edge stored by the in-memory graph executor.
 */
export type MemoryEdge = {
  /**
   * Stable edge identifier.
   */
  id: string;
  /**
   * Edge label.
   */
  label: string;
  /**
   * Source node id.
   */
  from: string;
  /**
   * Target node id.
   */
  to: string;
  /**
   * Primitive edge properties.
   */
  properties: Record<string, Primitive>;
};

/**
 * Path produced by the in-memory graph executor.
 */
export type MemoryPath = {
  /**
   * Nodes in path order.
   */
  nodes: MemoryNode[];
  /**
   * Edges in traversal order.
   */
  edges: MemoryEdge[];
};

/**
 * Mutable graph consumed by `executeMemory(...)`.
 */
export type MemoryGraph = {
  /**
   * Nodes available in the graph.
   */
  nodes: MemoryNode[];
  /**
   * Edges available in the graph.
   */
  edges: MemoryEdge[];
};

/**
 * Options accepted by the in-memory executor.
 */
export type MemoryExecuteOptions = {
  /**
   * Runtime parameters available to `param(...)` expressions.
   */
  params?: Record<string, ParameterValue>;
};

/**
 * Row projected by the in-memory executor.
 */
export type MemoryValue =
  | MemoryNode
  | MemoryEdge
  | MemoryEdge[]
  | MemoryPath
  | MemoryRowObject
  | Primitive
  | MemoryValue[];

export type MemoryRow = Record<string, MemoryValue>;

/**
 * Object produced by an `unwind(...)` row binding.
 */
export type MemoryRowObject = Record<string, Primitive>;
type BindingValue = MemoryNode | MemoryEdge | MemoryRowObject;
type PathBindingValue = BindingValue | MemoryPath | MemoryEdge[];
const mergeCreatedState = Symbol("mergeCreatedState");
type Binding = Record<string, PathBindingValue> & {
  [mergeCreatedState]?: boolean;
};
type MemoryContext = {
  params: Record<string, ParameterValue>;
};

/**
 * Executes a query AST against a mutable in-memory graph.
 *
 * `match`, `where`, and `return` read from the graph. `create`, `set`, and
 * `delete` mutate the provided graph object.
 *
 * @param ast - Query AST produced by the DSL.
 * @param graph - Mutable in-memory graph to execute against.
 * @param options - Optional runtime parameters.
 * @returns Projected rows when the query has a return clause, otherwise the current bindings.
 */
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
      case "unwind":
        bindings = unwindBindings(bindings, clause.source, clause.as, context);
        break;
      case "match":
        bindings = matchPatterns(bindings, clause.patterns, graph, context);
        break;
      case "create":
        bindings = createPatterns(bindings, clause.patterns, graph, context);
        break;
      case "merge":
        bindings = mergePatterns(bindings, clause.patterns, graph, context);
        break;
      case "createEdge":
        bindings = createEdges(bindings, clause.edges, graph, context);
        break;
      case "mergeEdge":
        bindings = mergeEdges(bindings, clause.edges, graph, context);
        break;
      case "where":
        bindings = bindings.filter((binding) => evaluatePredicate(clause.predicate, binding, context));
        break;
      case "set":
        bindings = bindings.map((binding) => setProperty(binding, clause.alias, clause.key, clause.value, context));
        break;
      case "onCreateSet":
        bindings = bindings.map((binding) =>
          binding[mergeCreatedState] === true
            ? setProperty(binding, clause.alias, clause.key, clause.value, context)
            : binding,
        );
        break;
      case "onMatchSet":
        bindings = bindings.map((binding) =>
          binding[mergeCreatedState] === false
            ? setProperty(binding, clause.alias, clause.key, clause.value, context)
            : binding,
        );
        break;
      case "delete":
        deleteAliases(bindings, clause.aliases, graph, { detach: false });
        break;
      case "detachDelete":
        deleteAliases(bindings, clause.aliases, graph, { detach: true });
        break;
      case "return":
        selections = clause.selections;
        break;
    }
  }

  if (!selections) {
    return bindings;
  }

  if (selections.some((selection) => selection.kind === "aggregate")) {
    return projectAggregatedRows(bindings, selections);
  }

  return bindings.map((binding) => projectRow(binding, selections));
}

function unwindBindings(
  bindings: Binding[],
  source: ValueExpression,
  alias: string,
  context: MemoryContext,
): Binding[] {
  return bindings.flatMap((binding) =>
    evaluateList(source, binding, context).map((item) => ({
      ...binding,
      [alias]: item,
    })),
  );
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

  if (pattern.kind === "path") {
    return matchPath(pattern, binding, graph, context);
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

function mergePatterns(
  bindings: Binding[],
  patterns: Pattern[],
  graph: MemoryGraph,
  context: MemoryContext,
): Binding[] {
  return patterns.reduce(
    (currentBindings, pattern) =>
      currentBindings.map((binding) => mergePattern(binding, pattern, graph, context)),
    bindings,
  );
}

function mergePattern(
  binding: Binding,
  pattern: Pattern,
  graph: MemoryGraph,
  context: MemoryContext,
): Binding {
  const matches = matchPattern(binding, pattern, graph, context);

  if (matches.length > 0) {
    return withMergeCreatedState(matches[0] ?? binding, false);
  }

  return withMergeCreatedState(createPattern(binding, pattern, graph, context), true);
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

  if (pattern.kind === "path") {
    throw new Error("Cannot create a path/traversal pattern. Use match(...) for traversals.");
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

function createEdges(
  bindings: Binding[],
  edges: EdgePattern[],
  graph: MemoryGraph,
  context: MemoryContext,
): Binding[] {
  return edges.reduce(
    (currentBindings, edge) =>
      currentBindings.map((binding) => createEdge(binding, edge, graph, context)),
    bindings,
  );
}

function mergeEdges(
  bindings: Binding[],
  edges: EdgePattern[],
  graph: MemoryGraph,
  context: MemoryContext,
): Binding[] {
  return edges.reduce(
    (currentBindings, edge) =>
      currentBindings.map((binding) => mergeEdge(binding, edge, graph, context)),
    bindings,
  );
}

function mergeEdge(
  binding: Binding,
  pattern: EdgePattern,
  graph: MemoryGraph,
  context: MemoryContext,
): Binding {
  const matches = matchPattern(binding, pattern, graph, context);

  if (matches.length > 0) {
    return withMergeCreatedState(matches[0] ?? binding, false);
  }

  return withMergeCreatedState(createEdge(binding, pattern, graph, context), true);
}

function createEdge(
  binding: Binding,
  pattern: EdgePattern,
  graph: MemoryGraph,
  context: MemoryContext,
): Binding {
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

function matchPath(
  pattern: PathPattern,
  binding: Binding,
  graph: MemoryGraph,
  context: MemoryContext,
): Binding[] {
  if (pattern.edge.maxHops === undefined) {
    throw new Error("executeMemory() requires maxHops for traversal patterns.");
  }

  return matchPattern(binding, pattern.from, graph, context).flatMap((startBinding) => {
    const start = startBinding[pattern.from.alias];

    if (!start || !isNode(start)) {
      return [];
    }

    return searchPath({
      pattern,
      binding: startBinding,
      graph,
      context,
      currentNode: start,
      nodes: [start],
      edges: [],
      usedEdgeIds: new Set<string>(),
    });
  });
}

type PathSearchState = {
  pattern: PathPattern;
  binding: Binding;
  graph: MemoryGraph;
  context: MemoryContext;
  currentNode: MemoryNode;
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  usedEdgeIds: Set<string>;
};

function searchPath(state: PathSearchState): Binding[] {
  const results: Binding[] = [];
  const depth = state.edges.length;

  if (depth >= state.pattern.edge.minHops) {
    results.push(...bindPathEnd(state));
  }

  if (depth >= state.pattern.edge.maxHops!) {
    return results;
  }

  for (const next of nextTraversalSteps(state)) {
    results.push(
      ...searchPath({
        ...state,
        currentNode: next.node,
        nodes: [...state.nodes, next.node],
        edges: [...state.edges, next.edge],
        usedEdgeIds: new Set([...state.usedEdgeIds, next.edge.id]),
      }),
    );
  }

  return results;
}

function bindPathEnd(state: PathSearchState): Binding[] {
  if (!matchesNode(state.pattern.to, state.currentNode, state.binding, state.context)) {
    return [];
  }

  if (!matchesPathScope(state.pattern, state.nodes, state.edges, state.binding, state.context)) {
    return [];
  }

  return bindEntity(state.binding, state.pattern.to.alias, state.currentNode).flatMap((binding) => {
    const pathBinding = bindPathAlias(binding, state.pattern.alias, {
      nodes: state.nodes,
      edges: state.edges,
    });

    if (!pathBinding) {
      return [];
    }

    const edgeAliasBinding = bindTraversalEdgeAlias(pathBinding, state.pattern.edge.alias, state.edges);
    return edgeAliasBinding ? [edgeAliasBinding] : [];
  });
}

function matchesPathScope(
  pattern: PathPattern,
  nodes: MemoryNode[],
  edges: MemoryEdge[],
  binding: Binding,
  context: MemoryContext,
): boolean {
  if (!pattern.scopeProperties) {
    return true;
  }

  return (
    nodes.every((node) => matchesScopedProperties(node.properties, pattern.scopeProperties!, binding, context)) &&
    edges.every((edge) => matchesScopedProperties(edge.properties, pattern.scopeProperties!, binding, context))
  );
}

function matchesScopedProperties(
  properties: Record<string, Primitive>,
  scopeProperties: Record<string, ValueExpression>,
  binding: Binding,
  context: MemoryContext,
): boolean {
  return Object.entries(scopeProperties).every(([key, expression]) =>
    properties[key] === evaluateValue(expression, binding, context),
  );
}

function nextTraversalSteps(state: PathSearchState): Array<{ edge: MemoryEdge; node: MemoryNode }> {
  return state.graph.edges.flatMap((edge) => {
    if (state.usedEdgeIds.has(edge.id) || edge.label !== state.pattern.edge.label) {
      return [];
    }

    if (!matchesTraversalEdgeProperties(state.pattern, edge, state.binding, state.context)) {
      return [];
    }

    const nextNodeId = nextNodeIdForTraversal(state.pattern, edge, state.currentNode.id);

    if (!nextNodeId) {
      return [];
    }

    const node = state.graph.nodes.find((candidate) => candidate.id === nextNodeId);
    return node ? [{ edge, node }] : [];
  });
}

function matchesTraversalEdgeProperties(
  pattern: PathPattern,
  edge: MemoryEdge,
  binding: Binding,
  context: MemoryContext,
): boolean {
  return Object.entries(pattern.edge.properties).every(([key, expression]) =>
    edge.properties[key] === evaluateValue(expression, binding, context),
  );
}

function nextNodeIdForTraversal(pattern: PathPattern, edge: MemoryEdge, currentNodeId: string): string | undefined {
  switch (pattern.edge.direction) {
    case "out":
      return edge.from === currentNodeId ? edge.to : undefined;
    case "in":
      return edge.to === currentNodeId ? edge.from : undefined;
    case "both":
      if (edge.from === currentNodeId) {
        return edge.to;
      }

      return edge.to === currentNodeId ? edge.from : undefined;
  }
}

function setProperty(
  binding: Binding,
  alias: string,
  key: string,
  nextValue: ValueExpression,
  context: MemoryContext,
): Binding {
  const entity = binding[alias];

  if (!entity || (!isNode(entity) && !isEdge(entity))) {
    return binding;
  }

  entity.properties[key] = evaluateValue(nextValue, binding, context);
  return binding;
}

function deleteAliases(
  bindings: Binding[],
  aliases: string[],
  graph: MemoryGraph,
  options: { detach: boolean },
): void {
  const ids = new Set(
    bindings.flatMap((binding) =>
      aliases.flatMap((alias) => {
        const entity = binding[alias];
        return entity && (isNode(entity) || isEdge(entity)) ? [entity.id] : [];
      }),
    ),
  );

  const nodeIds = new Set(graph.nodes.filter((node) => ids.has(node.id)).map((node) => node.id));

  if (!options.detach) {
    const connectedEdge = graph.edges.find((edge) => nodeIds.has(edge.from) || nodeIds.has(edge.to));

    if (connectedEdge) {
      throw new Error("Cannot delete a node that still has relationships. Use detachDelete(...) instead.");
    }
  }

  graph.edges = options.detach
    ? graph.edges.filter((edge) => !ids.has(edge.id) && !nodeIds.has(edge.from) && !nodeIds.has(edge.to))
    : graph.edges.filter((edge) => !ids.has(edge.id));
  graph.nodes = graph.nodes.filter((node) => !ids.has(node.id));
}

function bindEntity<T extends MemoryNode | MemoryEdge>(binding: Binding, alias: string, entity: T): Binding[] {
  const existing = binding[alias];

  if (existing && (!isEntity(existing) || existing.id !== entity.id)) {
    return [];
  }

  return [{ ...binding, [alias]: entity }];
}

function bindPathAlias(binding: Binding, alias: string | undefined, path: MemoryPath): Binding | undefined {
  if (!alias) {
    return binding;
  }

  const existing = binding[alias];

  if (existing && !isSamePath(existing, path)) {
    return undefined;
  }

  return { ...binding, [alias]: path };
}

function bindTraversalEdgeAlias(
  binding: Binding,
  alias: string | undefined,
  edges: MemoryEdge[],
): Binding | undefined {
  if (!alias) {
    return binding;
  }

  const existing = binding[alias];

  if (existing && !isSameEdgeList(existing, edges)) {
    return undefined;
  }

  return { ...binding, [alias]: edges };
}

function withMergeCreatedState(binding: Binding, created: boolean): Binding {
  return {
    ...binding,
    [mergeCreatedState]: created,
  };
}

function evaluatePredicate(
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
      return primitiveOrNull(context.params[expression.name]);
    case "property": {
      const entity = binding[expression.alias];

      if (!entity || (!isNode(entity) && !isEdge(entity))) {
        return null;
      }

      return entity.properties[expression.key] ?? null;
    }
    case "rowProperty": {
      const row = binding[expression.alias];

      if (!row || isNode(row) || isEdge(row) || isPath(row) || Array.isArray(row)) {
        return null;
      }

      return row[expression.key] ?? null;
    }
  }
}

function evaluateList(
  expression: ValueExpression,
  binding: Binding,
  context: MemoryContext,
): MemoryRowObject[] {
  if (expression.kind === "parameter") {
    const value = context.params[expression.name];
    return Array.isArray(value) && value.every(isRowObject) ? value : [];
  }

  const value = evaluateValue(expression, binding, context);
  return Array.isArray(value) && value.every(isRowObject) ? value : [];
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

      if (selection.kind === "aggregate") {
        return [aggregateSelectionKey(selection), null];
      }

      const entity = binding[selection.alias];
      const key = selection.as ?? `${selection.alias}.${selection.key}`;
      const value = entity && (isNode(entity) || isEdge(entity)) ? entity.properties[selection.key] ?? null : null;

      return [key, value];
    }),
  );
}

function projectAggregatedRows(bindings: Binding[], selections: ReturnSelection[]): MemoryRow[] {
  const groupSelections = selections.filter((selection) => selection.kind !== "aggregate");
  const aggregateSelections = selections.filter((selection) => selection.kind === "aggregate");
  const groups = new Map<string, { values: MemoryRow; bindings: Binding[] }>();

  for (const binding of bindings) {
    const values = projectRow(binding, groupSelections);
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
      aggregateSelections.map((selection) => [
        aggregateSelectionKey(selection),
        evaluateAggregate(selection.fn, selection.target, selection.distinct, group.bindings),
      ]),
    ),
  }));
}

function evaluateAggregate(
  fn: AggregateFunction,
  target: AggregateTargetExpression,
  distinct: boolean,
  bindings: Binding[],
): MemoryValue {
  const values = aggregateValues(target, bindings, fn === "count");
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
  }
}

function aggregateValues(
  target: AggregateTargetExpression,
  bindings: Binding[],
  keepNulls: boolean,
): MemoryValue[] {
  if (target.kind === "all") {
    return bindings.map((_, index) => index);
  }

  const values = bindings.map((binding) => evaluateAggregateTarget(target, binding));
  return keepNulls ? values : values.filter((value) => value !== null);
}

function evaluateAggregateTarget(target: AggregateTargetExpression, binding: Binding): MemoryValue {
  switch (target.kind) {
    case "all":
      return null;
    case "aliasRef":
      return binding[target.alias] ?? null;
    default:
      return evaluateValue(target, binding, { params: {} });
  }
}

function aggregateSelectionKey(selection: Extract<ReturnSelection, { kind: "aggregate" }>): string {
  if (selection.as) {
    return selection.as;
  }

  const target = aggregateTargetName(selection.target);
  return `${selection.fn}(${selection.distinct ? "distinct " : ""}${target})`;
}

function aggregateTargetName(target: AggregateTargetExpression): string {
  switch (target.kind) {
    case "all":
      return "*";
    case "aliasRef":
      return target.alias;
    case "property":
      return `${target.alias}.${target.key}`;
    case "rowProperty":
      return `${target.alias}.${target.key}`;
    case "parameter":
      return `$${target.name}`;
    case "primitive":
      return String(target.value);
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

function stableGroupKey(values: MemoryRow): string {
  return JSON.stringify(
    Object.entries(values).map(([key, value]) => [key, stableValueKey(value)]),
  );
}

function stableValueKey(value: MemoryValue): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value.map(stableValueKey));
  }

  if (isNode(value)) {
    return `node:${value.id}`;
  }

  if (isEdge(value)) {
    return `edge:${value.id}`;
  }

  if (isPath(value)) {
    return `path:${value.nodes.map((node) => node.id).join(",")}:${value.edges.map((edge) => edge.id).join(",")}`;
  }

  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function primitiveOrNull(value: ParameterValue | undefined): Primitive {
  return isPrimitive(value) ? value : null;
}

function isPrimitive(value: unknown): value is Primitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isRowObject(value: unknown): value is MemoryRowObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isPrimitive)
  );
}

function isNode(entity: PathBindingValue): entity is MemoryNode {
  return "labels" in entity;
}

function isEdge(entity: PathBindingValue): entity is MemoryEdge {
  return "from" in entity && "to" in entity;
}

function isPath(entity: PathBindingValue): entity is MemoryPath {
  return "nodes" in entity && "edges" in entity;
}

function isEntity(entity: PathBindingValue): entity is MemoryNode | MemoryEdge {
  return isNode(entity) || isEdge(entity);
}

function isSamePath(value: PathBindingValue, path: MemoryPath): boolean {
  return (
    isPath(value) &&
    value.nodes.map((node) => node.id).join("\0") === path.nodes.map((node) => node.id).join("\0") &&
    value.edges.map((edge) => edge.id).join("\0") === path.edges.map((edge) => edge.id).join("\0")
  );
}

function isSameEdgeList(value: PathBindingValue, edges: MemoryEdge[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === edges.length &&
    value.every((edge, index) => edge.id === edges[index]?.id)
  );
}
