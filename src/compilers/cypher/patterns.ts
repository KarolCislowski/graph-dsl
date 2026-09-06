import type {
  EdgePattern,
  NodePattern,
  PathPattern,
  Pattern,
  RelationshipLabel,
  ValueExpression,
} from "../../ast.js";
import { compileValue } from "./expressions.js";
import { escapeIdentifier } from "./identifiers.js";
import type { CypherContext } from "./types.js";

export function compileMatchClause(
  patterns: Pattern[],
  context: CypherContext,
  options: { optional?: boolean } = {},
): string {
  const match = `${options.optional ? "OPTIONAL MATCH" : "MATCH"} ${compilePatterns(patterns, context)}`;
  const pathScopePredicates = compilePathScopePredicates(patterns, context);

  if (pathScopePredicates.length === 0) {
    return match;
  }

  return `${match}\nWHERE ${pathScopePredicates.join(" AND ")}\nWITH *`;
}

export function compileBoundEdgePath(edge: EdgePattern, context: CypherContext): string {
  const edgeText = compileEdge(edge, context);

  switch (edge.direction) {
    case "out":
      return `(${escapeIdentifier(edge.from)})-${edgeText}->(${escapeIdentifier(edge.to)})`;
    case "in":
      return `(${escapeIdentifier(edge.from)})<-${edgeText}-(${escapeIdentifier(edge.to)})`;
    case "both":
      return `(${escapeIdentifier(edge.from)})-${edgeText}-(${escapeIdentifier(edge.to)})`;
  }
}

export function compilePatterns(patterns: Pattern[], context: CypherContext): string {
  return groupPatterns(patterns).map((group) => compilePatternGroup(group, context)).join(", ");
}

function groupPatterns(patterns: Pattern[]): Pattern[][] {
  const groups: Pattern[][] = [];
  const consumedNodeAliases = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.kind === "path") {
      groups.push([pattern]);
      consumedNodeAliases.add(pattern.from.alias);
      consumedNodeAliases.add(pattern.to.alias);
    }
  }

  for (const pattern of patterns) {
    if (pattern.kind === "edge") {
      const from = patterns.find((candidate) => candidate.kind === "node" && candidate.alias === pattern.from);
      const to = patterns.find((candidate) => candidate.kind === "node" && candidate.alias === pattern.to);

      if (!from || !to) {
        throw new Error(`Edge "${pattern.label}" references missing node patterns.`);
      }

      groups.push([from, pattern, to]);
      consumedNodeAliases.add(pattern.from);
      consumedNodeAliases.add(pattern.to);
    }
  }

  for (const pattern of patterns) {
    if (pattern.kind === "node" && !consumedNodeAliases.has(pattern.alias)) {
      groups.push([pattern]);
    }
  }

  return groups;
}

function compilePatternGroup(group: Pattern[], context: CypherContext): string {
  if (group.length === 1 && group[0]?.kind === "path") {
    return compilePath(group[0], context);
  }

  if (group.length === 1 && group[0]?.kind === "node") {
    return compileNode(group[0], context);
  }

  const [from, edge, to] = group;

  if (from?.kind !== "node" || edge?.kind !== "edge" || to?.kind !== "node") {
    throw new Error("Only node-edge-node pattern groups are supported.");
  }

  return compileEdgePath(from, edge, to, context);
}

function compilePath(path: PathPattern, context: CypherContext): string {
  const body = compileTraversalPath(path, context);

  return path.alias ? `${escapeIdentifier(path.alias)} = ${body}` : body;
}

function compilePathScopePredicates(patterns: Pattern[], context: CypherContext): string[] {
  return patterns.flatMap((pattern) => {
    if (pattern.kind !== "path" || !pattern.alias || !pattern.scopeProperties) {
      return [];
    }

    const nodePredicate = compilePathEntityScopePredicate("n", pattern.scopeProperties, context);
    const edgePredicate = compilePathEntityScopePredicate("r", pattern.scopeProperties, context);
    const alias = escapeIdentifier(pattern.alias);

    return [
      `all(n IN nodes(${alias}) WHERE ${nodePredicate})`,
      `all(r IN relationships(${alias}) WHERE ${edgePredicate})`,
    ];
  });
}

function compilePathEntityScopePredicate(
  entityAlias: string,
  scopeProperties: Record<string, ValueExpression>,
  context: CypherContext,
): string {
  return Object.entries(scopeProperties)
    .map(([key, expression]) => `${entityAlias}.${escapeIdentifier(key)} = ${compileValue(expression, context)}`)
    .join(" AND ");
}

function compileTraversalPath(path: PathPattern, context: CypherContext): string {
  const edgeText = compileTraversalEdge(path, context);

  switch (path.edge.direction) {
    case "out":
      return `${compileNode(path.from, context)}-${edgeText}->${compileNode(path.to, context)}`;
    case "in":
      return `${compileNode(path.from, context)}<-${edgeText}-${compileNode(path.to, context)}`;
    case "both":
      return `${compileNode(path.from, context)}-${edgeText}-${compileNode(path.to, context)}`;
  }
}

function compileEdgePath(
  from: NodePattern,
  edge: EdgePattern,
  to: NodePattern,
  context: CypherContext,
): string {
  const edgeText = compileEdge(edge, context);

  switch (edge.direction) {
    case "out":
      return `${compileNode(from, context)}-${edgeText}->${compileNode(to, context)}`;
    case "in":
      return `${compileNode(from, context)}<-${edgeText}-${compileNode(to, context)}`;
    case "both":
      return `${compileNode(from, context)}-${edgeText}-${compileNode(to, context)}`;
  }
}

function compileNode(node: NodePattern, context: CypherContext): string {
  const labels = node.labels.map((label) => `:${escapeIdentifier(label)}`).join("");
  const properties = compileProperties(node.properties, context);

  return `(${escapeIdentifier(node.alias)}${labels}${properties})`;
}

function compileEdge(edge: EdgePattern, context: CypherContext): string {
  const alias = edge.alias ? escapeIdentifier(edge.alias) : "";
  const label = compileRelationshipLabel(edge.label);
  const properties = compileProperties(edge.properties, context);

  return `[${alias}${label}${properties}]`;
}

function compileTraversalEdge(path: PathPattern, context: CypherContext): string {
  const alias = path.edge.alias ? escapeIdentifier(path.edge.alias) : "";
  const label = compileRelationshipLabel(path.edge.label);
  const range = compileHopRange(path.edge.minHops, path.edge.maxHops);
  const properties = compileProperties(path.edge.properties, context);

  return `[${alias}${label}${range}${properties}]`;
}

function compileRelationshipLabel(label: RelationshipLabel): string {
  const labels = Array.isArray(label) ? label : [label];
  const body = labels.filter(Boolean).map(escapeIdentifier).join("|");

  return body ? `:${body}` : "";
}

function compileHopRange(minHops: number, maxHops: number | undefined): string {
  if (maxHops === undefined) {
    return `*${minHops}..`;
  }

  if (minHops === maxHops) {
    return `*${minHops}`;
  }

  return `*${minHops}..${maxHops}`;
}

function compileProperties(
  properties: Record<string, ValueExpression>,
  context: CypherContext,
): string {
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    return "";
  }

  const body = entries
    .map(([key, expression]) => `${escapeIdentifier(key)}: ${compileValue(expression, context)}`)
    .join(", ");

  return ` { ${body} }`;
}
