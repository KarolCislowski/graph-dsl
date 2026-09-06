import type {
  Clause,
  CompilerOutput,
  EdgePattern,
  NodePattern,
  ParameterValue,
  PathPattern,
  Pattern,
  QueryAst,
  RelationshipLabel,
  TraversalEdgePattern,
} from "../ast.js";
import { compileCypher } from "./cypher.js";

/**
 * Options accepted by the Ladybug Cypher compiler.
 */
export type LadybugCompileOptions = {
  /**
   * Runtime parameters to carry into the compiled result.
   */
  params?: Record<string, ParameterValue>;
  /**
   * Append a statement terminator to the emitted query.
   *
   * This is useful for Ladybug CLI usage. Driver APIs often accept queries
   * without a trailing semicolon, so the default keeps parity with compileCypher.
   *
   * @default false
   */
  terminateStatement?: boolean;
};

/**
 * Compiles a graph query AST to Ladybug-compatible Cypher.
 *
 * Ladybug's Cypher implementation is close to openCypher, so this compiler
 * reuses the base Cypher emitter after validating the subset that is portable
 * to Ladybug's structured property graph model.
 */
export function compileLadybugCypher(
  ast: QueryAst,
  options: LadybugCompileOptions = {},
): CompilerOutput {
  validateLadybugAst(ast);

  const compiled = compileCypher(
    ast,
    options.params === undefined ? {} : { params: options.params },
  );

  return {
    query: options.terminateStatement ? `${compiled.query};` : compiled.query,
    params: compiled.params,
  };
}

function validateLadybugAst(ast: QueryAst): void {
  for (const clause of ast.clauses) {
    validateClause(clause);
  }
}

function validateClause(clause: Clause): void {
  switch (clause.kind) {
    case "match":
    case "optionalMatch":
      validatePatterns(clause.patterns, { requireNodeLabels: false });
      return;
    case "create":
    case "merge":
      validatePatterns(clause.patterns, { requireNodeLabels: true });
      return;
    case "createEdge":
    case "mergeEdge":
      for (const edge of clause.edges) {
        validateEdge(edge);
      }
      return;
    case "call":
      validateLadybugAst(clause.query);
      return;
    case "unwind":
    case "where":
    case "with":
    case "return":
    case "orderBy":
    case "skip":
    case "limit":
    case "set":
    case "onCreateSet":
    case "onMatchSet":
    case "delete":
    case "detachDelete":
      return;
  }
}

function validatePatterns(
  patterns: Pattern[],
  options: { requireNodeLabels: boolean },
): void {
  for (const pattern of patterns) {
    switch (pattern.kind) {
      case "node":
        validateNode(pattern, options);
        break;
      case "edge":
        validateEdge(pattern);
        break;
      case "path":
        validatePath(pattern, options);
        break;
    }
  }
}

function validatePath(
  path: PathPattern,
  options: { requireNodeLabels: boolean },
): void {
  validateNode(path.from, options);
  validateTraversalEdge(path.edge);
  validateNode(path.to, options);
}

function validateNode(
  node: NodePattern,
  options: { requireNodeLabels: boolean },
): void {
  if (node.labels.length > 1) {
    throw new Error(
      `Ladybug compiler MVP supports one node label per pattern; node "${node.alias}" has ${node.labels.length}.`,
    );
  }

  if (options.requireNodeLabels && node.labels.length === 0) {
    throw new Error(
      `Ladybug compiler MVP requires an explicit node label for ${node.alias} in CREATE and MERGE patterns.`,
    );
  }
}

function validateEdge(edge: EdgePattern): void {
  if (relationshipLabels(edge.label).length === 0) {
    throw new Error("Ladybug compiler MVP requires explicit relationship labels.");
  }
}

function validateTraversalEdge(edge: TraversalEdgePattern): void {
  if (relationshipLabels(edge.label).length === 0) {
    throw new Error("Ladybug compiler MVP requires explicit relationship labels.");
  }

  if (edge.maxHops === undefined) {
    throw new Error(
      `Ladybug compiler MVP requires bounded traversal patterns; "${relationshipLabelName(edge.label)}" is missing maxHops.`,
    );
  }
}

function relationshipLabels(label: RelationshipLabel): string[] {
  return (Array.isArray(label) ? label : [label]).filter(Boolean);
}

function relationshipLabelName(label: RelationshipLabel): string {
  return relationshipLabels(label).join("|");
}
