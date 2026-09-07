import type {
  CompilerOutput,
  PredicateExpression,
  QueryAst,
  ValueExpression,
} from "../../ast.js";
import { compileClause } from "./clauses.js";
import {
  compilePredicate as compilePredicateExpression,
  compileValue,
} from "./expressions.js";
import type {
  CypherCompileOptions,
  CypherContext,
} from "./types.js";

export type { CypherCompileOptions } from "./types.js";

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
  const context = createCypherContext(options);

  return {
    query: ast.clauses.map((clause) => compileClause(clause, context)).join("\n"),
    params: context.params,
  };
}

/**
 * Compiles a standalone value expression to Cypher text and parameters.
 *
 * This is useful for application-level query generators that need to migrate
 * small dynamic fragments before the whole query is represented as DSL.
 *
 * @param expression - Value expression to compile.
 * @param options - Optional compiler settings and initial parameters.
 * @returns A Cypher expression string together with its parameters.
 */
export function compileExpression(expression: ValueExpression, options: CypherCompileOptions = {}): CompilerOutput {
  const context = createCypherContext(options);

  return {
    query: compileValue(expression, context),
    params: context.params,
  };
}

/**
 * Compiles a standalone predicate expression to Cypher text and parameters.
 *
 * This is useful for runtime filter builders that still own query assembly but
 * want DSL-backed predicate construction and parameterization.
 *
 * @param predicate - Predicate expression to compile.
 * @param options - Optional compiler settings and initial parameters.
 * @returns A Cypher predicate string together with its parameters.
 */
export function compilePredicate(predicate: PredicateExpression, options: CypherCompileOptions = {}): CompilerOutput {
  const context = createCypherContext(options);

  return {
    query: compilePredicateExpression(predicate, context),
    params: context.params,
  };
}

function createCypherContext(options: CypherCompileOptions): CypherContext {
  const context: CypherContext = {
    params: { ...(options.params ?? {}) },
    literalIndex: 0,
  };

  return context;
}
