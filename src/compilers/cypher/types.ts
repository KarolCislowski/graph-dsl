import type { ParameterValue } from "../../ast.js";

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
 * Mutable state used while compiling one Cypher query.
 */
export type CypherContext = {
  params: Record<string, ParameterValue>;
  literalIndex: number;
};
