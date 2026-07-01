import type {
  Clause,
  CompilerOutput,
  EdgePattern,
  NodePattern,
  ParameterValue,
  Pattern,
  PredicateExpression,
  QueryAst,
  ReturnSelection,
  ValueExpression,
} from "../ast.js";

/**
 * Options accepted by the Cypher compiler.
 */
export type CypherCompileOptions = {
  /**
   * Runtime parameters to carry into the compiled result.
   *
   * Named `param(...)` expressions reference values from this object. Bulk
   * operations can pass arrays of row objects for `unwind(param("items"), ...)`.
   */
  params?: Record<string, ParameterValue>;
};

/**
 * Compiles a graph query AST to a Cypher query string and parameter bag.
 *
 * Named parameters created with `param("name")` are emitted as `$name`.
 * Primitive literals are converted to generated parameters such as `$p0`.
 * Row property expressions created with `row("item", "field")` are emitted as
 * property lookups on the current unwound row, such as `item.field`.
 *
 * @param ast - Query AST produced by the DSL.
 * @param options - Optional compiler settings and initial parameters.
 * @returns A Cypher query string together with its parameters.
 */
export function compileCypher(ast: QueryAst, options: CypherCompileOptions = {}): CompilerOutput {
  const context: CypherContext = {
    params: { ...(options.params ?? {}) },
    literalIndex: 0,
  };

  return {
    query: ast.clauses.map((clause) => compileClause(clause, context)).join("\n"),
    params: context.params,
  };
}

type CypherContext = {
  params: Record<string, ParameterValue>;
  literalIndex: number;
};

function compileClause(clause: Clause, context: CypherContext): string {
  switch (clause.kind) {
    case "unwind":
      return `UNWIND ${compileValue(clause.source, context)} AS ${escapeIdentifier(clause.as)}`;
    case "match":
      return `MATCH ${compilePatterns(clause.patterns, context)}`;
    case "create":
      return `CREATE ${compilePatterns(clause.patterns, context)}`;
    case "merge":
      return `MERGE ${compilePatterns(clause.patterns, context)}`;
    case "createEdge":
      return `CREATE ${clause.edges.map((edge) => compileBoundEdgePath(edge, context)).join(", ")}`;
    case "mergeEdge":
      return `MERGE ${clause.edges.map((edge) => compileBoundEdgePath(edge, context)).join(", ")}`;
    case "where":
      return `WHERE ${compilePredicate(clause.predicate, context)}`;
    case "return":
      return `RETURN ${clause.selections.map(compileReturnSelection).join(", ")}`;
    case "set":
      return `SET ${escapeIdentifier(clause.alias)}.${escapeIdentifier(clause.key)} = ${compileValue(
        clause.value,
        context,
      )}`;
    case "delete":
      return `DELETE ${clause.aliases.map(escapeIdentifier).join(", ")}`;
  }
}

function compileBoundEdgePath(edge: EdgePattern, context: CypherContext): string {
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

function compilePatterns(patterns: Pattern[], context: CypherContext): string {
  return groupPatterns(patterns).map((group) => compilePatternGroup(group, context)).join(", ");
}

function groupPatterns(patterns: Pattern[]): Pattern[][] {
  const groups: Pattern[][] = [];
  const consumedNodeAliases = new Set<string>();

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
  if (group.length === 1 && group[0]?.kind === "node") {
    return compileNode(group[0], context);
  }

  const [from, edge, to] = group;

  if (from?.kind !== "node" || edge?.kind !== "edge" || to?.kind !== "node") {
    throw new Error("Only node-edge-node pattern groups are supported.");
  }

  return compileEdgePath(from, edge, to, context);
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
  const label = edge.label ? `:${escapeIdentifier(edge.label)}` : "";
  const properties = compileProperties(edge.properties, context);

  return `[${alias}${label}${properties}]`;
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

function compilePredicate(predicate: PredicateExpression, context: CypherContext): string {
  switch (predicate.kind) {
    case "binary": {
      const operator = predicate.operator === "contains" ? "CONTAINS" : predicate.operator;
      return `${compileValue(predicate.left, context)} ${operator} ${compileValue(predicate.right, context)}`;
    }
    case "logical":
      return predicate.predicates
        .map((child) => `(${compilePredicate(child, context)})`)
        .join(` ${predicate.operator.toUpperCase()} `);
    case "not":
      return `NOT (${compilePredicate(predicate.predicate, context)})`;
  }
}

function compileReturnSelection(selection: ReturnSelection): string {
  switch (selection.kind) {
    case "alias":
      return escapeIdentifier(selection.alias);
    case "property": {
      const expression = `${escapeIdentifier(selection.alias)}.${escapeIdentifier(selection.key)}`;
      return selection.as ? `${expression} AS ${escapeIdentifier(selection.as)}` : expression;
    }
  }
}

function compileValue(expression: ValueExpression, context: CypherContext): string {
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
  }
}

function escapeIdentifier(identifier: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return identifier;
  }

  return `\`${identifier.replaceAll("`", "``")}\``;
}
