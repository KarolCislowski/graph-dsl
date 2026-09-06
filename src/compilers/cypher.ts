import type {
  AggregateTargetExpression,
  Clause,
  CompilerOutput,
  EdgePattern,
  FunctionArgumentExpression,
  NodePattern,
  ParameterValue,
  PathPattern,
  Pattern,
  PredicateExpression,
  QueryAst,
  RelationshipLabel,
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
      return compileMatchClause(clause.patterns, context);
    case "optionalMatch":
      return compileMatchClause(clause.patterns, context, { optional: true });
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
    case "with":
      return `WITH ${clause.selections.map((selection) => compileReturnSelection(selection, context)).join(", ")}`;
    case "return":
      return `RETURN ${clause.selections.map((selection) => compileReturnSelection(selection, context)).join(", ")}`;
    case "orderBy":
      return `ORDER BY ${clause.expressions
        .map((expression) => `${compileValue(expression.expression, context)} ${expression.direction.toUpperCase()}`)
        .join(", ")}`;
    case "skip":
      return `SKIP ${compileResultCount(clause.count)}`;
    case "limit":
      return `LIMIT ${compileResultCount(clause.count)}`;
    case "call":
      return compileCallClause(clause.query, clause.importAliases, context);
    case "set":
      return `SET ${escapeIdentifier(clause.alias)}.${escapeIdentifier(clause.key)} = ${compileValue(
        clause.value,
        context,
      )}`;
    case "onCreateSet":
      return `ON CREATE SET ${escapeIdentifier(clause.alias)}.${escapeIdentifier(clause.key)} = ${compileValue(
        clause.value,
        context,
      )}`;
    case "onMatchSet":
      return `ON MATCH SET ${escapeIdentifier(clause.alias)}.${escapeIdentifier(clause.key)} = ${compileValue(
        clause.value,
        context,
      )}`;
    case "delete":
      return `DELETE ${clause.aliases.map(escapeIdentifier).join(", ")}`;
    case "detachDelete":
      return `DETACH DELETE ${clause.aliases.map(escapeIdentifier).join(", ")}`;
  }
}

function compileCallClause(query: QueryAst, importAliases: string[], context: CypherContext): string {
  const hasExplicitImportWith = query.clauses[0]?.kind === "with";
  const importLines =
    importAliases.length === 0 || hasExplicitImportWith
      ? []
      : [`WITH ${importAliases.map(escapeIdentifier).join(", ")}`];
  const body = [...importLines, ...query.clauses.map((clause) => compileClause(clause, context))]
    .flatMap((line) => line.split("\n"))
    .map((line) => `  ${line}`)
    .join("\n");

  return `CALL {\n${body}\n}`;
}

function compileMatchClause(
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

function compileResultCount(count: number | { kind: "parameter"; name: string }): string {
  return typeof count === "number" ? String(count) : `$${count.name}`;
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

function compilePredicate(predicate: PredicateExpression, context: CypherContext): string {
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

function compileReturnSelection(selection: ReturnSelection, context: CypherContext): string {
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

function escapeIdentifier(identifier: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return identifier;
  }

  return `\`${identifier.replaceAll("`", "``")}\``;
}
