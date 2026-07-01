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

/**
 * One property assignment accepted by `setProps(...)`.
 */
export type PropertySet = {
  /**
   * Property expression to update.
   */
  property: ValueExpression;
  /**
   * New value expression or primitive literal.
   */
  value: ValueExpression | Primitive;
};

/**
 * Collection of property assignments, usually produced by runtime schema mappers.
 */
export type PropertySetCollection = {
  /**
   * Property assignments to append as `set(...)` clauses.
   */
  sets: PropertySet[];
};

/**
 * Immutable reference to a node pattern being built by the DSL.
 */
export class NodeRef {
  readonly kind = "nodeRef";

  /**
   * Creates a node reference.
   *
   * @param alias - Alias used to refer to this node in the query.
   * @param labels - Labels attached to the node pattern.
   * @param properties - Property constraints or values attached to the node pattern.
   */
  constructor(
    readonly alias: string,
    readonly labels: string[] = [],
    readonly properties: Record<string, ValueExpression> = {},
  ) {}

  /**
   * Returns a new node reference with an additional label.
   *
   * @param label - Label to append to the node pattern.
   * @returns A new node reference with the label added.
   */
  label(label: string): NodeRef {
    return new NodeRef(this.alias, [...this.labels, label], this.properties);
  }

  /**
   * Returns a new node reference with the provided properties.
   *
   * @param properties - Property map using value expressions or primitive literals.
   * @returns A new node reference with normalized property expressions.
   */
  props(properties: Record<string, ValueExpression | Primitive>): NodeRef {
    return new NodeRef(this.alias, this.labels, normalizeProperties(properties));
  }

  /**
   * Creates a property expression for this node alias.
   *
   * @param key - Property key to reference.
   * @returns A property expression such as `u.email`.
   */
  prop(key: string): ValueExpression {
    return prop(this, key);
  }

  /**
   * Converts this reference to a backend-neutral node pattern.
   *
   * @returns The node pattern represented by this reference.
   */
  toPattern(): NodePattern {
    return {
      kind: "node",
      alias: this.alias,
      labels: this.labels,
      properties: this.properties,
    };
  }
}

/**
 * Immutable reference to an edge pattern being built by the DSL.
 */
export class EdgeRef {
  readonly kind = "edgeRef";

  /**
   * Creates an edge reference.
   *
   * @param from - Source-side node reference.
   * @param label - Relationship/edge label.
   * @param to - Target-side node reference.
   * @param direction - Direction relative to `from` and `to`.
   * @param alias - Optional edge alias.
   * @param properties - Property constraints or values attached to the edge pattern.
   */
  constructor(
    readonly from: NodeRef,
    readonly label: string,
    readonly to: NodeRef,
    readonly direction: Direction = "out",
    readonly alias?: string,
    readonly properties: Record<string, ValueExpression> = {},
  ) {}

  /**
   * Returns a new edge reference with an alias.
   *
   * @param alias - Alias used to refer to the edge in later clauses.
   * @returns A new edge reference with the alias set.
   */
  as(alias: string): EdgeRef {
    return new EdgeRef(this.from, this.label, this.to, this.direction, alias, this.properties);
  }

  /**
   * Returns a new edge reference with the provided properties.
   *
   * @param properties - Property map using value expressions or primitive literals.
   * @returns A new edge reference with normalized property expressions.
   */
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

  /**
   * Converts this reference to a backend-neutral edge pattern.
   *
   * @returns The edge pattern represented by this reference.
   */
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

/**
 * Immutable fluent builder for constructing a graph query AST.
 */
export class QueryBuilder {
  /**
   * Creates a query builder.
   *
   * @param ast - Existing AST state. Used internally for immutable chaining.
   * @param scopeProperties - Properties automatically applied to later node patterns.
   */
  constructor(
    private readonly ast: QueryAst = { kind: "query", clauses: [] },
    private readonly scopeProperties: ScopeProperties = {},
  ) {}

  /**
   * Applies properties to every node in later `match(...)` and `create(...)` clauses.
   *
   * Scoped properties are not applied to edge patterns. If a node explicitly
   * defines the same property as the scope, the builder throws to avoid
   * accidental tenant/workspace override.
   *
   * @param properties - Scope properties, typically tenant/workspace/org identifiers.
   * @returns A new query builder with the scope configured.
   */
  scope(properties: Record<string, ValueExpression | Primitive>): QueryBuilder {
    return new QueryBuilder(this.ast, normalizeProperties(properties));
  }

  /**
   * Expands a list expression into one query binding per item.
   *
   * This is the DSL representation of Cypher `UNWIND`. Use `row(as, key)` to
   * read fields from the current item.
   *
   * @param source - List-producing expression, usually `param("items")`.
   * @param as - Alias used to reference each item with `row(as, key)`.
   * @returns A new query builder with the unwind clause appended.
   */
  unwind(source: ValueExpression, as: string): QueryBuilder {
    return this.addClause({
      kind: "unwind",
      source,
      as,
    });
  }

  /**
   * Adds a match clause.
   *
   * @param patterns - Node, edge, or raw AST patterns to match.
   * @returns A new query builder with the match clause appended.
   */
  match(...patterns: Array<NodeRef | EdgeRef | Pattern>): QueryBuilder {
    return this.addClause({
      kind: "match",
      patterns: patterns.flatMap(patternToAst).map((pattern) => applyScope(pattern, this.scopeProperties)),
    });
  }

  /**
   * Adds a create clause.
   *
   * @param patterns - Node, edge, or raw AST patterns to create.
   * @returns A new query builder with the create clause appended.
   */
  create(...patterns: Array<NodeRef | EdgeRef | Pattern>): QueryBuilder {
    return this.addClause({
      kind: "create",
      patterns: patterns.flatMap(patternToAst).map((pattern) => applyScope(pattern, this.scopeProperties)),
    });
  }

  /**
   * Adds a merge clause.
   *
   * Properties in merged node or edge patterns are identity properties for the
   * merge. Scoped properties are applied to node patterns.
   *
   * @param patterns - Node, edge, or raw AST patterns to merge.
   * @returns A new query builder with the merge clause appended.
   */
  merge(...patterns: Array<NodeRef | EdgeRef | Pattern>): QueryBuilder {
    return this.addClause({
      kind: "merge",
      patterns: patterns.flatMap(patternToAst).map((pattern) => applyScope(pattern, this.scopeProperties)),
    });
  }

  /**
   * Adds a create-edge clause for relationships between already-bound nodes.
   *
   * Use this after `match(...)` when the endpoint nodes already exist. Use
   * `create(...)` when creating full node/edge patterns together.
   *
   * @param edges - Edge references or raw edge patterns to create.
   * @returns A new query builder with the create-edge clause appended.
   */
  createEdge(...edges: Array<EdgeRef | EdgePattern>): QueryBuilder {
    return this.addClause({
      kind: "createEdge",
      edges: edges.map((edge) => (edge instanceof EdgeRef ? edge.toPattern() : edge)),
    });
  }

  /**
   * Adds a merge-edge clause for relationships between already-bound nodes.
   *
   * Use this after `match(...)` or `merge(...)` when endpoint nodes are already
   * bound. The endpoint nodes are not merged by this clause.
   *
   * @param edges - Edge references or raw edge patterns to merge.
   * @returns A new query builder with the merge-edge clause appended.
   */
  mergeEdge(...edges: Array<EdgeRef | EdgePattern>): QueryBuilder {
    return this.addClause({
      kind: "mergeEdge",
      edges: edges.map((edge) => (edge instanceof EdgeRef ? edge.toPattern() : edge)),
    });
  }

  /**
   * Adds a where clause.
   *
   * @param predicate - Boolean predicate used to filter the current bindings.
   * @returns A new query builder with the where clause appended.
   */
  where(predicate: PredicateExpression): QueryBuilder {
    return this.addClause({ kind: "where", predicate });
  }

  /**
   * Adds a return clause.
   *
   * @param selections - Aliases or properties to project.
   * @returns A new query builder with the return clause appended.
   */
  return(...selections: Array<NodeRef | ReturnSelection | ValueExpression>): QueryBuilder {
    return this.addClause({
      kind: "return",
      selections: selections.map(selectionToAst),
    });
  }

  /**
   * Adds a property update clause.
   *
   * @param property - Property expression to update, for example `prop("u", "name")`.
   * @param nextValue - New value expression or primitive literal.
   * @returns A new query builder with the set clause appended.
   */
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

  /**
   * Adds multiple property update clauses.
   *
   * This is useful with runtime schema patches, where a form object is mapped
   * to a list of property assignments and generated parameters.
   *
   * @param patch - Collection of property assignments to apply.
   * @returns A new query builder with all set clauses appended.
   */
  setProps(patch: PropertySetCollection): QueryBuilder {
    return patch.sets.reduce(
      (builder, assignment) => builder.set(assignment.property, assignment.value),
      this as QueryBuilder,
    );
  }

  /**
   * Adds a delete clause for bound aliases.
   *
   * @param aliases - Node references, aliased edge references, or alias strings to delete.
   * @returns A new query builder with the delete clause appended.
   */
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

  /**
   * Materializes the builder state into a query AST.
   *
   * The returned AST is detached from the builder so callers can inspect or
   * pass it to compilers/executors without mutating builder state.
   *
   * @returns A deep-cloned query AST.
   */
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

/**
 * Creates an empty query builder.
 *
 * @returns A new query builder.
 */
export function query(): QueryBuilder {
  return new QueryBuilder();
}

/**
 * Creates a node reference.
 *
 * @param alias - Alias used to refer to this node in the query.
 * @param labels - Optional labels attached to the node pattern.
 * @returns A node reference.
 */
export function node(alias: string, ...labels: string[]): NodeRef {
  return new NodeRef(alias, labels);
}

/**
 * Creates an edge reference between two node references.
 *
 * @param from - Source-side node reference.
 * @param label - Relationship/edge label.
 * @param to - Target-side node reference.
 * @param direction - Direction relative to `from` and `to`. Defaults to `out`.
 * @returns An edge reference.
 */
export function edge(from: NodeRef, label: string, to: NodeRef, direction: Direction = "out"): EdgeRef {
  return new EdgeRef(from, label, to, direction);
}

/**
 * Creates a named runtime parameter expression.
 *
 * @param name - Parameter name without backend-specific prefixing.
 * @returns A parameter value expression.
 */
export function param(name: string): ValueExpression {
  return { kind: "parameter", name };
}

/**
 * Creates an explicit primitive literal expression.
 *
 * @param value - Primitive literal value.
 * @returns A primitive value expression.
 */
export function value(value: Primitive): ValueExpression {
  return { kind: "primitive", value };
}

/**
 * Creates a property lookup expression on an unwound row alias.
 *
 * For example, `row("item", "email")` compiles to `item.email`.
 *
 * @param alias - Row alias introduced by `unwind(...)`.
 * @param key - Property key to read from the current row.
 * @returns A row property value expression.
 */
export function row(alias: string, key: string): ValueExpression {
  return { kind: "rowProperty", alias, key };
}

/**
 * Creates a property lookup expression.
 *
 * @param ref - Node reference or alias string.
 * @param key - Property key to reference.
 * @returns A property value expression.
 */
export function prop(ref: NodeRef | string, key: string): ValueExpression {
  return {
    kind: "property",
    alias: typeof ref === "string" ? ref : ref.alias,
    key,
  };
}

/**
 * Creates a return selection for a property.
 *
 * @param ref - Node reference or alias string.
 * @param key - Property key to return.
 * @param as - Optional projected field alias.
 * @returns A return selection.
 */
export function select(ref: NodeRef | string, key: string, as?: string): ReturnSelection {
  return {
    kind: "property",
    alias: typeof ref === "string" ? ref : ref.alias,
    key,
    ...(as ? { as } : {}),
  };
}

/**
 * Creates an equality predicate.
 *
 * @param left - Left value expression.
 * @param right - Right value expression or primitive literal.
 * @returns A predicate expression.
 */
export function eq(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary("=", left, right);
}

/**
 * Creates an inequality predicate.
 *
 * @param left - Left value expression.
 * @param right - Right value expression or primitive literal.
 * @returns A predicate expression.
 */
export function neq(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary("!=", left, right);
}

/**
 * Creates a greater-than predicate.
 *
 * @param left - Left value expression.
 * @param right - Right value expression or primitive literal.
 * @returns A predicate expression.
 */
export function gt(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary(">", left, right);
}

/**
 * Creates a greater-than-or-equal predicate.
 *
 * @param left - Left value expression.
 * @param right - Right value expression or primitive literal.
 * @returns A predicate expression.
 */
export function gte(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary(">=", left, right);
}

/**
 * Creates a less-than predicate.
 *
 * @param left - Left value expression.
 * @param right - Right value expression or primitive literal.
 * @returns A predicate expression.
 */
export function lt(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary("<", left, right);
}

/**
 * Creates a less-than-or-equal predicate.
 *
 * @param left - Left value expression.
 * @param right - Right value expression or primitive literal.
 * @returns A predicate expression.
 */
export function lte(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary("<=", left, right);
}

/**
 * Creates a string containment predicate.
 *
 * @param left - Left value expression, usually a string property.
 * @param right - Right value expression or primitive string literal.
 * @returns A predicate expression.
 */
export function contains(left: ValueExpression, right: ValueExpression | Primitive): PredicateExpression {
  return binary("contains", left, right);
}

/**
 * Combines predicates with logical AND.
 *
 * @param predicates - Child predicates. All must evaluate to true.
 * @returns A logical predicate expression.
 */
export function and(...predicates: PredicateExpression[]): PredicateExpression {
  return { kind: "logical", operator: "and", predicates };
}

/**
 * Combines predicates with logical OR.
 *
 * @param predicates - Child predicates. At least one must evaluate to true.
 * @returns A logical predicate expression.
 */
export function or(...predicates: PredicateExpression[]): PredicateExpression {
  return { kind: "logical", operator: "or", predicates };
}

/**
 * Negates a predicate.
 *
 * @param predicate - Predicate to negate.
 * @returns A negated predicate expression.
 */
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
    (value.kind === "primitive" ||
      value.kind === "parameter" ||
      value.kind === "property" ||
      value.kind === "rowProperty")
  );
}
