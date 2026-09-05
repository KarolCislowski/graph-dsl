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
 *
 * Primitive values are used by normal named parameters. Arrays of objects are
 * used by `unwind(...)` for bulk operations.
 */
export type ParameterValue =
  | Primitive
  | Record<string, Primitive>
  | Array<Primitive | Record<string, Primitive>>;

/**
 * Literal list values accepted by expression helpers.
 */
export type PrimitiveList = Primitive[];

/**
 * A value-producing expression used in predicates, properties, and updates.
 */
export type ValueExpression =
  | PrimitiveExpression
  | ParameterExpression
  | PropertyExpression
  | RowPropertyExpression
  | VariableExpression
  | FunctionExpression;

/**
 * Literal value expression. Compilers may parameterize it for the target backend.
 */
export type PrimitiveExpression = {
  kind: "primitive";
  value: Primitive | PrimitiveList;
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
 *
 * Row aliases are introduced by an `UnwindClause`.
 */
export type RowPropertyExpression = {
  kind: "rowProperty";
  alias: string;
  key: string;
};

/**
 * Reference to a scalar value bound by `WITH`, such as `postCount`.
 */
export type VariableExpression = {
  kind: "variable";
  name: string;
};

/**
 * Reference to a bound node, edge, path, or traversal alias.
 */
export type AliasExpression = {
  kind: "aliasRef";
  alias: string;
};

/**
 * Arguments accepted by built-in function expressions.
 */
export type FunctionArgumentExpression = AliasExpression | ValueExpression;

/**
 * Built-in scalar function expression.
 */
export type FunctionExpression = {
  kind: "function";
  name: FunctionName;
  args: FunctionArgumentExpression[];
};

/**
 * Supported built-in function expressions.
 */
export type FunctionName = "elementId" | "type" | "labels" | "coalesce";

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
export type BinaryOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "in";

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
 * Variable-length edge pattern used inside path/traversal matches.
 */
export type TraversalEdgePattern = {
  kind: "traversalEdge";
  alias?: string;
  label: string;
  direction: Direction;
  properties: Record<string, ValueExpression>;
  minHops: number;
  maxHops?: number;
};

/**
 * Aliasable path pattern for traversal queries.
 *
 * Path patterns are intended for `match(...)`; write clauses cannot create or
 * merge variable-length paths.
 */
export type PathPattern = {
  kind: "path";
  alias?: string;
  from: NodePattern;
  edge: TraversalEdgePattern;
  to: NodePattern;
  scopeProperties?: Record<string, ValueExpression>;
};

/**
 * A graph pattern element.
 */
export type Pattern = NodePattern | EdgePattern | PathPattern;

/**
 * Clause describing graph patterns to match.
 */
export type MatchClause = {
  kind: "match";
  patterns: Pattern[];
};

/**
 * Clause describing graph patterns to optionally match.
 *
 * If no pattern matches, the current binding is preserved and newly referenced
 * aliases remain unbound.
 */
export type OptionalMatchClause = {
  kind: "optionalMatch";
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
 * Clause describing graph patterns to merge.
 *
 * Properties in merge patterns are identity properties for the merge.
 */
export type MergeClause = {
  kind: "merge";
  patterns: Pattern[];
};

/**
 * Clause describing edges to create between already-bound node aliases.
 *
 * Unlike `CreateClause`, this clause does not create the endpoint nodes.
 */
export type CreateEdgeClause = {
  kind: "createEdge";
  edges: EdgePattern[];
};

/**
 * Clause describing edges to merge between already-bound node aliases.
 *
 * Unlike `MergeClause`, this clause does not merge the endpoint nodes.
 */
export type MergeEdgeClause = {
  kind: "mergeEdge";
  edges: EdgePattern[];
};

/**
 * Clause expanding a list expression into one binding per item.
 *
 * Cypher compilers emit this as `UNWIND`.
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
    }
  | {
      kind: "aggregate";
      fn: AggregateFunction;
      target: AggregateTargetExpression;
      distinct: boolean;
      as?: string;
    }
  | {
      kind: "expression";
      expression: ValueExpression;
      as: string;
    }
  | {
      kind: "map";
      fields: Record<string, ValueExpression>;
      as: string;
    };

/**
 * Supported aggregate functions.
 */
export type AggregateFunction = "count" | "sum" | "avg" | "min" | "max" | "collect";

/**
 * Value accepted as an aggregate input.
 */
export type AggregateTargetExpression =
  | {
      kind: "all";
    }
  | AliasExpression
  | ValueExpression;

/**
 * Clause projecting values from the current binding set.
 */
export type ReturnClause = {
  kind: "return";
  selections: ReturnSelection[];
};

/**
 * Clause projecting values into the next query pipeline stage.
 */
export type WithClause = {
  kind: "with";
  selections: ReturnSelection[];
};

/**
 * Direction used by `ORDER BY`.
 */
export type SortDirection = "asc" | "desc";

/**
 * One expression used by an `ORDER BY` clause.
 */
export type OrderExpression = {
  expression: ValueExpression;
  direction: SortDirection;
};

/**
 * Clause sorting the current binding set or projected rows.
 */
export type OrderByClause = {
  kind: "orderBy";
  expressions: OrderExpression[];
};

/**
 * Clause skipping rows from the current binding set or projected rows.
 */
export type SkipClause = {
  kind: "skip";
  count: number | ParameterExpression;
};

/**
 * Clause limiting rows from the current binding set or projected rows.
 */
export type LimitClause = {
  kind: "limit";
  count: number | ParameterExpression;
};

/**
 * Clause executing a nested query for each current binding.
 */
export type CallClause = {
  kind: "call";
  query: QueryAst;
  importAliases: string[];
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
 * Clause setting one property only when the preceding merge created data.
 */
export type OnCreateSetClause = {
  kind: "onCreateSet";
  alias: string;
  key: string;
  value: ValueExpression;
};

/**
 * Clause setting one property only when the preceding merge matched data.
 */
export type OnMatchSetClause = {
  kind: "onMatchSet";
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
 * Clause deleting one or more bound aliases together with their relationships.
 */
export type DetachDeleteClause = {
  kind: "detachDelete";
  aliases: string[];
};

/**
 * All supported query clauses in execution order.
 */
export type Clause =
  | UnwindClause
  | MatchClause
  | OptionalMatchClause
  | CreateClause
  | MergeClause
  | CreateEdgeClause
  | MergeEdgeClause
  | WhereClause
  | WithClause
  | ReturnClause
  | OrderByClause
  | SkipClause
  | LimitClause
  | CallClause
  | SetPropertyClause
  | OnCreateSetClause
  | OnMatchSetClause
  | DeleteClause
  | DetachDeleteClause;

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
