export type Direction = "in" | "out" | "both";

export type Primitive = string | number | boolean | null;

export type ValueExpression =
  | PrimitiveExpression
  | ParameterExpression
  | PropertyExpression;

export type PrimitiveExpression = {
  kind: "primitive";
  value: Primitive;
};

export type ParameterExpression = {
  kind: "parameter";
  name: string;
};

export type PropertyExpression = {
  kind: "property";
  alias: string;
  key: string;
};

export type PredicateExpression =
  | BinaryPredicateExpression
  | LogicalPredicateExpression
  | NotPredicateExpression;

export type BinaryOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";

export type BinaryPredicateExpression = {
  kind: "binary";
  operator: BinaryOperator;
  left: ValueExpression;
  right: ValueExpression;
};

export type LogicalOperator = "and" | "or";

export type LogicalPredicateExpression = {
  kind: "logical";
  operator: LogicalOperator;
  predicates: PredicateExpression[];
};

export type NotPredicateExpression = {
  kind: "not";
  predicate: PredicateExpression;
};

export type NodePattern = {
  kind: "node";
  alias: string;
  labels: string[];
  properties: Record<string, ValueExpression>;
};

export type EdgePattern = {
  kind: "edge";
  alias?: string;
  label: string;
  direction: Direction;
  from: string;
  to: string;
  properties: Record<string, ValueExpression>;
};

export type Pattern = NodePattern | EdgePattern;

export type MatchClause = {
  kind: "match";
  patterns: Pattern[];
};

export type CreateClause = {
  kind: "create";
  patterns: Pattern[];
};

export type WhereClause = {
  kind: "where";
  predicate: PredicateExpression;
};

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

export type ReturnClause = {
  kind: "return";
  selections: ReturnSelection[];
};

export type SetPropertyClause = {
  kind: "set";
  alias: string;
  key: string;
  value: ValueExpression;
};

export type DeleteClause = {
  kind: "delete";
  aliases: string[];
};

export type Clause =
  | MatchClause
  | CreateClause
  | WhereClause
  | ReturnClause
  | SetPropertyClause
  | DeleteClause;

export type QueryAst = {
  kind: "query";
  clauses: Clause[];
};

export type CompilerOutput = {
  query: string;
  params: Record<string, Primitive>;
};
