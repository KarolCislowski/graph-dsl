import type {
  EdgePattern,
  NodePattern,
  PathPattern,
  Pattern,
  Primitive,
  RelationshipLabel,
  ValueExpression,
} from "../ast.js";
import {
  evaluateProperties,
  evaluateValue,
} from "./evaluate.js";
import {
  isEdge,
  isEntity,
  isNode,
  isSameEdgeList,
  isSamePath,
  primitiveOrNull,
} from "./guards.js";
import type {
  Binding,
  MemoryContext,
  MemoryEdge,
  MemoryGraph,
  MemoryNode,
  MemoryPath,
} from "./types.js";
import { mergeCreatedState } from "./types.js";

export function matchPatterns(
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

export function optionalMatchPatterns(
  bindings: Binding[],
  patterns: Pattern[],
  graph: MemoryGraph,
  context: MemoryContext,
): Binding[] {
  return bindings.flatMap((binding) => {
    const matches = matchPatterns([binding], patterns, graph, context);
    return matches.length > 0 ? matches : [binding];
  });
}

export function createPatterns(
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

export function mergePatterns(
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

export function createEdges(
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

export function mergeEdges(
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

export function setProperty(
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

  entity.properties[key] = primitiveOrNull(evaluateValue(nextValue, binding, context));
  return binding;
}

export function deleteAliases(
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
  const label = singleRelationshipLabel(pattern.label, "create");

  const edge: MemoryEdge = {
    id: nextId("edge", graph.edges),
    label,
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
  const label = singleRelationshipLabel(pattern.label, "createEdge");

  const edge: MemoryEdge = {
    id: nextId("edge", graph.edges),
    label,
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
  if (!relationshipLabelMatches(pattern.label, edge.label)) {
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

function relationshipLabelMatches(patternLabel: RelationshipLabel, edgeLabel: string): boolean {
  return Array.isArray(patternLabel)
    ? patternLabel.includes(edgeLabel)
    : patternLabel === "" || patternLabel === edgeLabel;
}

function singleRelationshipLabel(label: RelationshipLabel, method: "create" | "createEdge"): string {
  if (!Array.isArray(label)) {
    return label;
  }

  throw new Error(`${method}() cannot create a relationship with multiple possible labels.`);
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
    if (state.usedEdgeIds.has(edge.id) || !relationshipLabelMatches(state.pattern.edge.label, edge.label)) {
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

function nextId(prefix: "node" | "edge", entities: Array<MemoryNode | MemoryEdge>): string {
  const usedIds = new Set(entities.map((entity) => entity.id));
  let index = entities.length + 1;

  while (usedIds.has(`${prefix}-${index}`)) {
    index += 1;
  }

  return `${prefix}-${index}`;
}
