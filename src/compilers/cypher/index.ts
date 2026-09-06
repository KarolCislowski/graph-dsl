import type {
  CompilerOutput,
  QueryAst,
} from "../../ast.js";
import { compileClause } from "./clauses.js";
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
  const context: CypherContext = {
    params: { ...(options.params ?? {}) },
    literalIndex: 0,
  };

  return {
    query: ast.clauses.map((clause) => compileClause(clause, context)).join("\n"),
    params: context.params,
  };
}
