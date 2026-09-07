import type {
  Clause,
  QueryAst,
} from "../../ast.js";
import {
  compilePredicate,
  compileReturnSelection,
  compileValue,
} from "./expressions.js";
import { escapeIdentifier } from "./identifiers.js";
import {
  compileBoundEdgePath,
  compileMatchClause,
  compilePatterns,
} from "./patterns.js";
import type { CypherContext } from "./types.js";

/**
 * Compiles a single query clause to Cypher text.
 */
export function compileClause(clause: Clause, context: CypherContext): string {
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
    case "setMap":
      return `SET ${escapeIdentifier(clause.alias)} += ${compileValue(clause.value, context)}`;
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

function compileResultCount(count: number | { kind: "parameter"; name: string }): string {
  return typeof count === "number" ? String(count) : `$${count.name}`;
}
