/**
 * Direction of an edge pattern relative to its `from` and `to` node aliases.
 */
export type Direction = "in" | "out" | "both";

/**
 * Primitive values that can be embedded in the AST or supplied as parameters.
 */
export type Primitive = string | number | boolean | null;

/**
 * Runtime parameter value accepted by compilers and executors.
 */
export type ParameterValue =
  | Primitive
  | Primitive[]
  | Record<string, Primitive>
  | Array<Record<string, Primitive>>;

/**
 * A value-producing expression used in predicates, properties, and updates.
 */
export type ValueExpression =
  | PrimitiveExpression
  | ParameterExpression
  | PropertyExpression
  | RowPropertyExpression;

/**
 * Literal value expression. Compilers may parameterize it for the target backend.
 */
export type PrimitiveExpression = {
  kind: "primitive";
  value: Primitive;
};

/**
 * Named runtime parameter expression, such as `$email` in Cypher.
 */
export type ParameterExpression = {
  kind: "parameter";
  name: string;
};

/**
 * Property lookup expression on a bound alias, such as `u.email`.
 */
export type PropertyExpression = {
  kind: "property";
  alias: string;
  key: string;
};

/**
 * Property lookup expression on an unwound row, such as `row.email`.
 */
export type RowPropertyExpression = {
  kind: "rowProperty";
  alias: string;
  key: string;
};

/**
 * Boolean expression used by `where(...)`.
 */
export type PredicateExpression =
  | BinaryPredicateExpression
  | LogicalPredicateExpression
  | NotPredicateExpression;

/**
 * Supported binary predicate operators.
 */
export type BinaryOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";

/**
 * Predicate comparing two value expressions.
 */
export type BinaryPredicateExpression = {
  kind: "binary";
  operator: BinaryOperator;
  left: ValueExpression;
  right: ValueExpression;
};

/**
 * Supported logical predicate combinators.
 */
export type LogicalOperator = "and" | "or";

/**
 * Predicate combining multiple child predicates.
 */
export type LogicalPredicateExpression = {
  kind: "logical";
  operator: LogicalOperator;
  predicates: PredicateExpression[];
};

/**
 * Predicate negating another predicate.
 */
export type NotPredicateExpression = {
  kind: "not";
  predicate: PredicateExpression;
};

/**
 * Backend-neutral node pattern used by match and create clauses.
 */
export type NodePattern = {
  kind: "node";
  alias: string;
  labels: string[];
  properties: Record<string, ValueExpression>;
};

/**
 * Backend-neutral edge pattern connecting two node aliases.
 */
export type EdgePattern = {
  kind: "edge";
  alias?: string;
  label: string;
  direction: Direction;
  from: string;
  to: string;
  properties: Record<string, ValueExpression>;
};

/**
 * A graph pattern element.
 */
export type Pattern = NodePattern | EdgePattern;

/**
 * Clause describing graph patterns to match.
 */
export type MatchClause = {
  kind: "match";
  patterns: Pattern[];
};

/**
 * Clause describing graph patterns to create.
 */
export type CreateClause = {
  kind: "create";
  patterns: Pattern[];
};

/**
 * Clause describing edges to create between already-bound node aliases.
 */
export type CreateEdgeClause = {
  kind: "createEdge";
  edges: EdgePattern[];
};

/**
 * Clause expanding a list expression into one binding per item.
 */
export type UnwindClause = {
  kind: "unwind";
  source: ValueExpression;
  as: string;
};

/**
 * Clause filtering the current binding set.
 */
export type WhereClause = {
  kind: "where";
  predicate: PredicateExpression;
};

/**
 * Selection projected by a return clause.
 */
export type ReturnSelection =
  | {
      kind: "alias";
      alias: string;
    }
  | {
      kind: "property";
      alias: string;
      key: string;
      as?: string;
    };

/**
 * Clause projecting values from the current binding set.
 */
export type ReturnClause = {
  kind: "return";
  selections: ReturnSelection[];
};

/**
 * Clause setting one property on a bound graph entity.
 */
export type SetPropertyClause = {
  kind: "set";
  alias: string;
  key: string;
  value: ValueExpression;
};

/**
 * Clause deleting one or more bound aliases.
 */
export type DeleteClause = {
  kind: "delete";
  aliases: string[];
};

/**
 * All supported query clauses in execution order.
 */
export type Clause =
  | UnwindClause
  | MatchClause
  | CreateClause
  | CreateEdgeClause
  | WhereClause
  | ReturnClause
  | SetPropertyClause
  | DeleteClause;

/**
 * Root AST emitted by the DSL and consumed by compilers/executors.
 */
export type QueryAst = {
  kind: "query";
  clauses: Clause[];
};

/**
 * Text query and parameter bag produced by a compiler.
 */
export type CompilerOutput = {
  query: string;
  params: Record<string, ParameterValue>;
};
