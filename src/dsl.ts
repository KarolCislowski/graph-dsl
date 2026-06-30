import type {
  BinaryOperator,
  Direction,
  EdgePattern,
  NodePattern,
  Pattern,
  PredicateExpression,
  Primitive,
  QueryAst,
  ReturnSelection,
  ValueExpression,
} from "./ast.js";

type ScopeProperties = Record<string, ValueExpression>;

export class NodeRef {
  readonly kind = "nodeRef";

  constructor(
    readonly alias: string,
    readonly labels: string[] = [],
    readonly properties: Record<string, ValueExpression> = {},
  ) {}

  label(label: string): NodeRef {
    return new NodeRef(this.alias, [...this.labels, label], this.properties);
  }

  props(properties: Record<string, ValueExpression | Primitive>): NodeRef {
    return new NodeRef(this.alias, this.labels, normalizeProperties(properties));
  }

  prop(key: string): ValueExpression {
    return prop(this, key);
  }

  toPattern(): NodePattern {
    return {
      kind: "node",
      alias: this.alias,
      labels: this.labels,
      properties: this.properties,
    };
  }
}

export class EdgeRef {
  readonly kind = "edgeRef";

  constructor(
    readonly from: NodeRef,
    readonly label: string,
    readonly to: NodeRef,
    readonly direction: Direction = "out",
    readonly alias?: string,
    readonly properties: Record<string, ValueExpression> = {},
  ) {}

  as(alias: string): EdgeRef {
    return new EdgeRef(this.from, this.label, this.to, this.direction, alias, this.properties);
  }

  props(properties: Record<string, ValueExpression | Primitive>): EdgeRef {
    return new EdgeRef(
      this.from,
      this.label,
      this.to,
      this.direction,
      this.alias,
      normalizeProperties(properties),
    );
  }

  toPattern(): EdgePattern {
    return {
      kind: "edge",
      label: this.label,
      direction: this.direction,
      from: this.from.alias,
      to: this.to.alias,
      properties: this.properties,
      ...(this.alias ? { alias: this.alias } : {}),
    };
  }
}

export class QueryBuilder {
  constructor(
    private readonly ast: QueryAst = { kind: "query", clauses: [] },
    private readonly scopeProperties: ScopeProperties = {},
  ) {}

  scope(properties: Record<string, ValueExpression | Primitive>): QueryBuilder {
    return new QueryBuilder(this.ast, normalizeProperties(properties));
  }

  match(...patterns: Array<NodeRef | EdgeRef | Pattern>): QueryBuilder {
    return this.addClause({
      kind: "match",
      patterns: patterns.flatMap(patternToAst).map((pattern) => applyScope(pattern, this.scopeProperties)),
    });
  }

  create(...patterns: Array<NodeRef | EdgeRef | Pattern>): QueryBuilder {
    return this.addClause({
      kind: "create",
      patterns: patterns.flatMap(patternToAst).map((pattern) => applyScope(pattern, this.scopeProperties)),
    });
  }

  where(predicate: PredicateExpression): QueryBuilder {
    return this.addClause({ kind: "where", predicate });
  }

  return(...selections: Array<NodeRef | ReturnSelection | ValueExpression>): QueryBuilder {
    return this.addClause({
      kind: "return",
      selections: selections.map(selectionToAst),
    });
  }

  set(property: ValueExpression, nextValue: ValueExpression | Primitive): QueryBuilder {
    if (property.kind !== "property") {
      throw new Error("set() expects a property expression, for example set(user.prop(\"name\"), \"Ada\").");
    }

    return this.addClause({
      kind: "set",
      alias: property.alias,
      key: property.key,
      value: isValueExpression(nextValue) ? nextValue : value(nextValue),
    });
  }

  delete(...aliases: Array<NodeRef | EdgeRef | string>): QueryBuilder {
    return this.addClause({
      kind: "delete",
      aliases: aliases.map((alias) => {
        if (typeof alias === "string") {
          return alias;
        }

        if (alias instanceof EdgeRef) {
          const edgeAlias = alias.alias;

          if (!edgeAlias) {
            throw new Error("delete() expects an aliased edge, for example edge(a, \"KNOWS\", b).as(\"r\").");
          }

          return edgeAlias;
        }

        return alias.alias;
      }),
    });
  }

  toAst(): QueryAst {
    return {
      kind: "query",
      clauses: this.ast.clauses.map((clause) => structuredClone(clause)),
    };
  }

  private addClause(clause: QueryAst["clauses"][number]): QueryBuilder {
    return new QueryBuilder({
      kind: "query",
      clauses: [...this.ast.clauses, clause],
    }, this.scopeProperties);
  }
}

export function query(): QueryBuilder {
  return new QueryBuilder();
}

export function node(alias: string, ...labels: string[]): NodeRef {
  return new NodeRef(alias, labels);
}

export function edge(from: NodeRef, label: string, to: NodeRef, direction: Direction = "out"): EdgeRef {
  return new EdgeRef(from, label, to, direction);
}

export function param(name: string): ValueExpression {
  return { kind: "parameter", name };
}

export function value(value: Primitive): ValueExpression {
  return { kind: "primitive", value };
}

export function prop(ref: NodeRef | string, key: string): ValueExpression {
  return {
    kind: "property",
    alias: typeof ref === "string" ? ref : ref.alias,
    key,
  };
}

export function select(ref: NodeRef | string, key: string, as?: string): ReturnSelection {
  return {
    kind: "property",
    alias: typeof ref === "string" ? ref : ref.alias,
    key,
    ...(as ? { as } : {}),
  };
}

export function eq(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary("=", left, right);
}

export function neq(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary("!=", left, right);
}

export function gt(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary(">", left, right);
}

export function gte(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary(">=", left, right);
}

export function lt(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary("<", left, right);
}

export function lte(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary("<=", left, right);
}

export function contains(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary("contains", left, right);
}

export function and(...predicates: PredicateExpression[]): PredicateExpression {
  return { kind: "logical", operator: "and", predicates };
}

export function or(...predicates: PredicateExpression[]): PredicateExpression {
  return { kind: "logical", operator: "or", predicates };
}

export function not(predicate: PredicateExpression): PredicateExpression {
  return { kind: "not", predicate };
}

function binary(
  operator: BinaryOperator,
  left: ValueExpression,
  right: ValueExpression | Primitive,
): PredicateExpression {
  return {
    kind: "binary",
    operator,
    left,
    right: isValueExpression(right) ? right : value(right),
  };
}

function normalizeProperties(
  properties: Record<string, ValueExpression | Primitive>,
): Record<string, ValueExpression> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, propertyValue]) => [
      key,
      isValueExpression(propertyValue) ? propertyValue : value(propertyValue),
    ]),
  );
}

function patternToAst(pattern: NodeRef | EdgeRef | Pattern): Pattern[] {
  if (pattern instanceof NodeRef) {
    return [pattern.toPattern()];
  }

  if (pattern instanceof EdgeRef) {
    return [pattern.from.toPattern(), pattern.to.toPattern(), pattern.toPattern()];
  }

  return [pattern];
}

function applyScope(pattern: Pattern, scopeProperties: ScopeProperties): Pattern {
  if (pattern.kind !== "node" || Object.keys(scopeProperties).length === 0) {
    return pattern;
  }

  const duplicateKeys = Object.keys(scopeProperties).filter((key) => key in pattern.properties);

  if (duplicateKeys.length > 0) {
    throw new Error(`Node "${pattern.alias}" already defines scoped properties: ${duplicateKeys.join(", ")}.`);
  }

  return {
    ...pattern,
    properties: {
      ...pattern.properties,
      ...scopeProperties,
    },
  };
}

function selectionToAst(selection: NodeRef | ReturnSelection | ValueExpression): ReturnSelection {
  if (selection instanceof NodeRef) {
    return { kind: "alias", alias: selection.alias };
  }

  if (selection.kind === "property") {
    const alias = "as" in selection ? selection.as : undefined;

    return {
      kind: "property",
      alias: selection.alias,
      key: selection.key,
      ...(alias ? { as: alias } : {}),
    };
  }

  if (selection.kind === "alias") {
    return selection;
  }

  throw new Error(`Cannot return expression kind "${selection.kind}" yet.`);
}

function isValueExpression(value: unknown): value is ValueExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value.kind === "primitive" || value.kind === "parameter" || value.kind === "property")
  );
}
