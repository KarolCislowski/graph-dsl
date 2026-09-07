import type {
  AggregateFunction,
  AggregateTargetExpression,
  AliasExpression,
  ArithmeticOperator,
  BinaryOperator,
  CaseBranch,
  AggregateValueExpression,
  Direction,
  EdgePattern,
  FunctionName,
  NodePattern,
  OrderExpression,
  ParameterExpression,
  PathPattern,
  Pattern,
  PredicateExpression,
  Primitive,
  PrimitiveList,
  QueryAst,
  RelationshipLabel,
  ReturnSelection,
  ValueExpression,
} from "./ast.js";

type ScopeProperties = Record<string, ValueExpression>;

/**
 * Options accepted by aggregate helper functions.
 */
export type AggregateOptions = {
  /**
   * Whether the aggregate should only consider distinct values.
   */
  distinct?: boolean;
};

type AggregateTargetInput = NodeRef | EdgeRef | PathRef | string | ValueExpression;
type AliasTargetInput = NodeRef | EdgeRef | string;
type AnyAliasTargetInput = NodeRef | EdgeRef | PathRef | string;
type NodeAliasTargetInput = NodeRef | string;
type ValueInput = ValueExpression | Primitive;
type ResultCountInput = number | ParameterExpression;

/**
 * Options accepted by `call(...)`.
 */
export type CallOptions = {
  /**
   * Aliases to import into the subquery with an initial `WITH` clause.
   */
  import?: Array<NodeRef | EdgeRef | PathRef | string>;
};

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
   * @param label - Relationship/edge label or list of labels.
   * @param to - Target-side node reference.
   * @param direction - Direction relative to `from` and `to`.
   * @param alias - Optional edge alias.
   * @param properties - Property constraints or values attached to the edge pattern.
   */
  constructor(
    readonly from: NodeRef,
    readonly label: RelationshipLabel,
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
 * Immutable reference to a variable-length path/traversal pattern.
 */
export class PathRef {
  readonly kind = "pathRef";

  /**
   * Creates a path reference.
   *
   * @param from - Start node reference.
   * @param label - Relationship/edge label or list of labels to traverse.
   * @param to - End node reference.
   * @param direction - Direction relative to `from` and `to`.
   * @param minHops - Minimum number of relationships in the path.
   * @param maxHops - Optional maximum number of relationships in the path.
   * @param alias - Optional path alias.
   * @param edgeAlias - Optional relationship-list alias for the traversal.
   * @param properties - Property constraints applied to every traversed relationship.
   */
  constructor(
    readonly from: NodeRef,
    readonly label: RelationshipLabel,
    readonly to: NodeRef,
    readonly direction: Direction = "out",
    readonly minHops: number = 1,
    readonly maxHops?: number,
    readonly alias?: string,
    readonly edgeAlias?: string,
    readonly properties: Record<string, ValueExpression> = {},
  ) {
    validateHops(minHops, maxHops);
  }

  /**
   * Returns a new path reference with a path alias.
   *
   * @param alias - Alias used to return or inspect the whole path.
   * @returns A new path reference with the alias set.
   */
  as(alias: string): PathRef {
    return new PathRef(
      this.from,
      this.label,
      this.to,
      this.direction,
      this.minHops,
      this.maxHops,
      alias,
      this.edgeAlias,
      this.properties,
    );
  }

  /**
   * Returns a new path reference with a relationship-list alias.
   *
   * In Cypher this compiles to a relationship variable inside the variable-length
   * relationship pattern.
   *
   * @param alias - Alias for the traversed relationships.
   * @returns A new path reference with the relationship alias set.
   */
  via(alias: string): PathRef {
    return new PathRef(
      this.from,
      this.label,
      this.to,
      this.direction,
      this.minHops,
      this.maxHops,
      this.alias,
      alias,
      this.properties,
    );
  }

  /**
   * Returns a new path reference with a hop range.
   *
   * @param minHops - Minimum number of relationships to traverse.
   * @param maxHops - Optional maximum number of relationships to traverse.
   * @returns A new path reference with the hop range set.
   */
  hops(minHops: number, maxHops?: number): PathRef {
    return new PathRef(
      this.from,
      this.label,
      this.to,
      this.direction,
      minHops,
      maxHops,
      this.alias,
      this.edgeAlias,
      this.properties,
    );
  }

  /**
   * Returns a new path reference with relationship property constraints.
   *
   * @param properties - Property map using value expressions or primitive literals.
   * @returns A new path reference with normalized relationship properties.
   */
  props(properties: Record<string, ValueExpression | Primitive>): PathRef {
    return new PathRef(
      this.from,
      this.label,
      this.to,
      this.direction,
      this.minHops,
      this.maxHops,
      this.alias,
      this.edgeAlias,
      normalizeProperties(properties),
    );
  }

  /**
   * Converts this reference to a backend-neutral path pattern.
   *
   * @returns The path pattern represented by this reference.
   */
  toPattern(): PathPattern {
    return {
      kind: "path",
      from: this.from.toPattern(),
      to: this.to.toPattern(),
      edge: {
        kind: "traversalEdge",
        label: this.label,
        direction: this.direction,
        minHops: this.minHops,
        properties: this.properties,
        ...(this.maxHops === undefined ? {} : { maxHops: this.maxHops }),
        ...(this.edgeAlias ? { alias: this.edgeAlias } : {}),
      },
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
   * @param scopeProperties - Properties automatically applied to later node and edge patterns.
   */
  constructor(
    private readonly ast: QueryAst = { kind: "query", clauses: [] },
    private readonly scopeProperties: ScopeProperties = {},
  ) {}

  /**
   * Applies properties to every node and edge in later query clauses.
   *
   * If a pattern explicitly defines the same property as the scope, the builder
   * throws to avoid accidental tenant/workspace override.
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
   * @param patterns - Node, edge, path, or raw AST patterns to match.
   * @returns A new query builder with the match clause appended.
   */
  match(...patterns: Array<NodeRef | EdgeRef | PathRef | Pattern>): QueryBuilder {
    return this.addClause({
      kind: "match",
      patterns: patterns.flatMap(patternToAst).map((pattern) => applyScope(pattern, this.scopeProperties)),
    });
  }

  /**
   * Adds an optional match clause.
   *
   * If the optional patterns do not match, the current row remains in the
   * result set and projected values from the optional aliases evaluate to null.
   *
   * @param patterns - Node, edge, path, or raw AST patterns to optionally match.
   * @returns A new query builder with the optional match clause appended.
   */
  optionalMatch(...patterns: Array<NodeRef | EdgeRef | PathRef | Pattern>): QueryBuilder {
    this.assertHasRequiredMatch();

    return this.addClause({
      kind: "optionalMatch",
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
    const astPatterns = patterns.flatMap(patternToAst);
    assertWritePatterns("create", astPatterns);

    return this.addClause({
      kind: "create",
      patterns: astPatterns.map((pattern) => applyScope(pattern, this.scopeProperties)),
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
    const astPatterns = patterns.flatMap(patternToAst);
    assertWritePatterns("merge", astPatterns);

    return this.addClause({
      kind: "merge",
      patterns: astPatterns.map((pattern) => applyScope(pattern, this.scopeProperties)),
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
      edges: edges.map((edge) => applyScopeToEdge(edge instanceof EdgeRef ? edge.toPattern() : edge, this.scopeProperties)),
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
      edges: edges.map((edge) => applyScopeToEdge(edge instanceof EdgeRef ? edge.toPattern() : edge, this.scopeProperties)),
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
  return(...selections: Array<NodeRef | PathRef | string | ReturnSelection | ValueExpression>): QueryBuilder {
    return this.addClause({
      kind: "return",
      selections: selections.map(selectionToAst),
    });
  }

  /**
   * Adds a with clause, projecting values into the next pipeline stage.
   *
   * @param selections - Aliases, properties, aggregates, maps, or expressions to keep.
   * @returns A new query builder with the with clause appended.
   */
  with(...selections: Array<NodeRef | PathRef | string | ReturnSelection | ValueExpression>): QueryBuilder {
    return this.addClause({
      kind: "with",
      selections: selections.map(selectionToAst),
    });
  }

  /**
   * Adds an order-by clause.
   *
   * @param expressions - Value expressions or explicit order expressions.
   * @returns A new query builder with the order-by clause appended.
   */
  orderBy(...expressions: Array<ValueExpression | OrderExpression>): QueryBuilder {
    return this.addClause({
      kind: "orderBy",
      expressions: expressions.map(orderExpressionToAst),
    });
  }

  /**
   * Adds a skip clause.
   *
   * @param count - Non-negative integer or parameter expression.
   * @returns A new query builder with the skip clause appended.
   */
  skip(count: ResultCountInput): QueryBuilder {
    return this.addClause({
      kind: "skip",
      count: normalizeResultCount("skip", count),
    });
  }

  /**
   * Adds a limit clause.
   *
   * @param count - Non-negative integer or parameter expression.
   * @returns A new query builder with the limit clause appended.
   */
  limit(count: ResultCountInput): QueryBuilder {
    return this.addClause({
      kind: "limit",
      count: normalizeResultCount("limit", count),
    });
  }

  /**
   * Adds a subquery clause.
   *
   * Imported aliases are emitted as the first `WITH` inside the subquery and
   * are available to the in-memory executor while evaluating the nested query.
   *
   * @param subquery - Nested query builder or AST to execute.
   * @param options - Optional imported aliases.
   * @returns A new query builder with the call clause appended.
   */
  call(subquery: QueryBuilder | QueryAst, options: CallOptions = {}): QueryBuilder {
    return this.addClause({
      kind: "call",
      query: subquery instanceof QueryBuilder ? subquery.toAst() : structuredClone(subquery),
      importAliases: (options.import ?? []).map(normalizeAlias),
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
   * Adds a map merge update clause.
   *
   * @param alias - Bound node/edge alias or reference to update.
   * @param mapExpression - Map-producing expression to merge into the entity.
   * @returns A new query builder with the set-map clause appended.
   */
  setMap(alias: NodeRef | EdgeRef | string, mapExpression: ValueExpression): QueryBuilder {
    return this.addClause({
      kind: "setMap",
      alias: normalizeDeleteAlias(alias),
      value: mapExpression,
    });
  }

  /**
   * Adds a property update that runs only when the preceding merge creates data.
   *
   * @param property - Property expression to update.
   * @param nextValue - New value expression or primitive literal.
   * @returns A new query builder with the on-create set clause appended.
   */
  onCreateSet(property: ValueExpression, nextValue: ValueExpression | Primitive): QueryBuilder {
    this.assertCanAddMergeSet("onCreateSet");

    if (property.kind !== "property") {
      throw new Error("onCreateSet() expects a property expression.");
    }

    return this.addClause({
      kind: "onCreateSet",
      alias: property.alias,
      key: property.key,
      value: isValueExpression(nextValue) ? nextValue : value(nextValue),
    });
  }

  /**
   * Adds a property update that runs only when the preceding merge matches data.
   *
   * @param property - Property expression to update.
   * @param nextValue - New value expression or primitive literal.
   * @returns A new query builder with the on-match set clause appended.
   */
  onMatchSet(property: ValueExpression, nextValue: ValueExpression | Primitive): QueryBuilder {
    this.assertCanAddMergeSet("onMatchSet");

    if (property.kind !== "property") {
      throw new Error("onMatchSet() expects a property expression.");
    }

    return this.addClause({
      kind: "onMatchSet",
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
   * Adds multiple on-create property update clauses.
   *
   * @param patch - Collection of property assignments to apply.
   * @returns A new query builder with all on-create set clauses appended.
   */
  onCreateSetProps(patch: PropertySetCollection): QueryBuilder {
    return patch.sets.reduce(
      (builder, assignment) => builder.onCreateSet(assignment.property, assignment.value),
      this as QueryBuilder,
    );
  }

  /**
   * Adds multiple on-match property update clauses.
   *
   * @param patch - Collection of property assignments to apply.
   * @returns A new query builder with all on-match set clauses appended.
   */
  onMatchSetProps(patch: PropertySetCollection): QueryBuilder {
    return patch.sets.reduce(
      (builder, assignment) => builder.onMatchSet(assignment.property, assignment.value),
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
      aliases: aliases.map((alias) => normalizeDeleteAlias(alias)),
    });
  }

  /**
   * Adds a detach-delete clause for bound aliases.
   *
   * Use this when deleting nodes that may still have relationships.
   *
   * @param aliases - Node references, aliased edge references, or alias strings to delete.
   * @returns A new query builder with the detach-delete clause appended.
   */
  detachDelete(...aliases: Array<NodeRef | EdgeRef | string>): QueryBuilder {
    return this.addClause({
      kind: "detachDelete",
      aliases: aliases.map((alias) => normalizeDeleteAlias(alias)),
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

  private assertCanAddMergeSet(method: "onCreateSet" | "onMatchSet"): void {
    const lastClause = this.ast.clauses.at(-1);

    if (
      !lastClause ||
      !["merge", "mergeEdge", "onCreateSet", "onMatchSet"].includes(lastClause.kind)
    ) {
      throw new Error(`${method}() must be called immediately after merge(), mergeEdge(), or another merge set clause.`);
    }
  }

  private assertHasRequiredMatch(): void {
    if (!this.ast.clauses.some((clause) => clause.kind === "match" || clause.kind === "with")) {
      throw new Error("optionalMatch() requires a preceding match() or with() clause to anchor the query.");
    }
  }
}

function normalizeDeleteAlias(alias: NodeRef | EdgeRef | string): string {
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
}

function normalizeAlias(alias: NodeRef | EdgeRef | PathRef | string): string {
  if (typeof alias === "string") {
    return alias;
  }

  if (alias instanceof EdgeRef) {
    if (!alias.alias) {
      throw new Error("call() import expects an aliased edge, for example edge(a, \"KNOWS\", b).as(\"r\").");
    }

    return alias.alias;
  }

  if (alias instanceof PathRef) {
    if (!alias.alias) {
      throw new Error("call() import expects an aliased path, for example path(\"p\", a, \"KNOWS\", b).");
    }

    return alias.alias;
  }

  return alias.alias;
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
 * Creates a label-less node reference for scoped/admin queries.
 *
 * This is an explicit alias for `node(alias)` when the query intentionally matches any node label.
 *
 * @param alias - Alias used to refer to this node in the query.
 * @returns A label-less node reference.
 */
export function anyNode(alias: string): NodeRef {
  return node(alias);
}

/**
 * Creates an edge reference between two node references.
 *
 * @param from - Source-side node reference.
 * @param label - Relationship/edge label or list of labels.
 * @param to - Target-side node reference.
 * @param direction - Direction relative to `from` and `to`. Defaults to `out`.
 * @returns An edge reference.
 */
export function edge(from: NodeRef, label: RelationshipLabel, to: NodeRef, direction: Direction = "out"): EdgeRef {
  return new EdgeRef(from, label, to, direction);
}

/**
 * Creates an unlabeled edge reference between two node references.
 *
 * This is useful for scoped/admin queries that intentionally match any relationship type.
 *
 * @param from - Source-side node reference.
 * @param to - Target-side node reference.
 * @param direction - Direction relative to `from` and `to`. Defaults to `out`.
 * @returns An unlabeled edge reference.
 */
export function anyEdge(from: NodeRef, to: NodeRef, direction: Direction = "out"): EdgeRef {
  return edge(from, "", to, direction);
}

/**
 * Creates a variable-length traversal/path reference between two nodes.
 *
 * By default the path traverses one or more relationships. Use `.hops(min, max)`
 * to set a bounded or unbounded range.
 *
 * @param from - Start node reference.
 * @param label - Relationship/edge label or list of labels to traverse.
 * @param to - End node reference.
 * @param direction - Direction relative to `from` and `to`. Defaults to `out`.
 * @returns A path reference.
 */
export function traverse(from: NodeRef, label: RelationshipLabel, to: NodeRef, direction: Direction = "out"): PathRef {
  return new PathRef(from, label, to, direction);
}

/**
 * Creates an aliased variable-length path reference between two nodes.
 *
 * This is a convenience wrapper around `traverse(...).as(alias)`.
 *
 * @param alias - Alias used to return or inspect the whole path.
 * @param from - Start node reference.
 * @param label - Relationship/edge label or list of labels to traverse.
 * @param to - End node reference.
 * @param direction - Direction relative to `from` and `to`. Defaults to `out`.
 * @returns An aliased path reference.
 */
export function path(alias: string, from: NodeRef, label: RelationshipLabel, to: NodeRef, direction: Direction = "out"): PathRef {
  return traverse(from, label, to, direction).as(alias);
}

/**
 * Creates a named runtime parameter expression.
 *
 * @param name - Parameter name without backend-specific prefixing.
 * @returns A parameter value expression.
 */
export function param(name: string): ParameterExpression {
  return { kind: "parameter", name };
}

/**
 * Creates an explicit primitive literal expression.
 *
 * @param value - Primitive literal value.
 * @returns A primitive value expression.
 */
export function value(value: Primitive | PrimitiveList): ValueExpression {
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
 * Creates a reference to an item introduced by `anyInList(...)` or `allInList(...)`.
 *
 * @param alias - Item alias used inside a list predicate.
 * @returns A list item value expression.
 */
export function listItem(alias: string): ValueExpression {
  return { kind: "listItem", alias };
}

/**
 * Creates a scalar variable expression for values projected by `with(...)`.
 *
 * @param name - Variable name available in the current query pipeline stage.
 * @returns A variable value expression.
 */
export function variable(name: string): ValueExpression {
  return { kind: "variable", name };
}

/**
 * Creates a reference to a bound graph alias, such as a node or relationship alias.
 *
 * @param name - Alias available in the current query pipeline stage.
 * @returns An alias value expression.
 */
export function aliasRef(name: string): ValueExpression {
  return { kind: "aliasRef", alias: name };
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
 * Creates a property lookup on a map-like value expression.
 *
 * @param source - Map-like value expression.
 * @param key - Property key to read.
 * @returns A map property value expression.
 */
export function mapProp(source: ValueExpression, key: string): ValueExpression {
  return {
    kind: "mapProperty",
    source,
    key,
  };
}

/**
 * Creates a dynamic property lookup, such as `node[field]`.
 *
 * @param source - Node, edge, alias, or map-like value expression.
 * @param key - Property key expression.
 * @returns A dynamic property value expression.
 */
export function dynamicProp(
  source: AnyAliasTargetInput | ValueExpression,
  key: ValueExpression | Primitive,
): ValueExpression {
  return {
    kind: "dynamicProperty",
    source: isValueExpression(source) ? source : anyAliasTargetToExpression(source),
    key: normalizeValueInput(key),
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
 * Creates a return selection for an arbitrary value expression.
 *
 * @param expression - Expression to project.
 * @param as - Projected field alias.
 * @returns A return selection.
 */
export function expr(expression: ValueExpression, as: string): ReturnSelection {
  return {
    kind: "expression",
    expression,
    as,
  };
}

/**
 * Creates a return selection for a Cypher map/object projection.
 *
 * @param as - Projected field alias.
 * @param fields - Map fields keyed by output property name.
 * @returns A return selection.
 */
export function map(as: string, fields: Record<string, ValueExpression | Primitive>): ReturnSelection {
  return {
    kind: "map",
    fields: normalizeProperties(fields),
    as,
  };
}

/**
 * Creates an inline map value expression usable inside projections and aggregates.
 *
 * @param fields - Map fields keyed by output property name.
 * @returns A map value expression.
 */
export function mapValue(fields: Record<string, ValueExpression | Primitive>): ValueExpression {
  return {
    kind: "mapValue",
    fields: normalizeProperties(fields),
  };
}

/**
 * Creates an explicit order expression for `orderBy(...)`.
 *
 * @param expression - Value expression to sort by.
 * @param direction - Sort direction. Defaults to ascending.
 * @returns An order expression.
 */
export function order(expression: ValueExpression, direction: "asc" | "desc" = "asc"): OrderExpression {
  return {
    expression,
    direction,
  };
}

/**
 * Creates an `elementId(...)` expression for a bound node or edge.
 *
 * @param target - Alias or reference to pass to `elementId(...)`.
 * @returns A scalar function expression.
 */
export function elementId(target: AliasTargetInput): ValueExpression {
  return functionExpression("elementId", aliasTargetToExpression(target));
}

/**
 * Creates a `type(...)` expression for a bound relationship.
 *
 * @param target - Aliased edge reference or edge alias.
 * @returns A scalar function expression.
 */
export function type(target: EdgeRef | string | ValueExpression): ValueExpression {
  return functionExpression("type", isValueExpression(target) ? target : aliasTargetToExpression(target));
}

/**
 * Creates a `labels(...)` expression for a bound node.
 *
 * @param target - Node reference or node alias.
 * @returns A list-valued function expression.
 */
export function labels(target: NodeAliasTargetInput): ValueExpression {
  return functionExpression("labels", aliasTargetToExpression(target));
}

/**
 * Creates a `coalesce(...)` expression from ordered fallback values.
 *
 * @param expressions - Expressions or primitive literals to evaluate in order.
 * @returns A scalar function expression.
 */
export function coalesce(...expressions: Array<ValueExpression | Primitive>): ValueExpression {
  return functionExpression(
    "coalesce",
    ...expressions.map((expression) => isValueExpression(expression) ? expression : value(expression)),
  );
}

/**
 * Creates a `toFloat(...)` expression.
 *
 * @param expression - Expression or primitive literal to convert.
 * @returns A scalar function expression.
 */
export function toFloat(expression: ValueExpression | Primitive): ValueExpression {
  return functionExpression("toFloat", isValueExpression(expression) ? expression : value(expression));
}

/**
 * Creates a `toString(...)` expression.
 *
 * @param expression - Expression or primitive literal to convert.
 * @returns A scalar function expression.
 */
export function toString(expression: ValueExpression | Primitive): ValueExpression {
  return functionExpression("toString", isValueExpression(expression) ? expression : value(expression));
}

/**
 * Creates a `toInteger(...)` expression.
 *
 * @param expression - Expression or primitive literal to convert.
 * @returns A scalar function expression.
 */
export function toInteger(expression: ValueExpression | Primitive): ValueExpression {
  return functionExpression("toInteger", isValueExpression(expression) ? expression : value(expression));
}

/**
 * Creates a `toLower(...)` expression.
 *
 * @param expression - String expression or primitive literal to lowercase.
 * @returns A scalar function expression.
 */
export function toLower(expression: ValueExpression | Primitive): ValueExpression {
  return functionExpression("toLower", isValueExpression(expression) ? expression : value(expression));
}

/**
 * Creates a `floor(...)` expression.
 *
 * @param expression - Numeric expression or primitive literal.
 * @returns A scalar function expression.
 */
export function floor(expression: ValueExpression | Primitive): ValueExpression {
  return functionExpression("floor", isValueExpression(expression) ? expression : value(expression));
}

/**
 * Creates a `round(...)` expression.
 *
 * @param expression - Numeric expression or primitive literal.
 * @returns A scalar function expression.
 */
export function round(expression: ValueExpression | Primitive): ValueExpression {
  return functionExpression("round", isValueExpression(expression) ? expression : value(expression));
}

/**
 * Creates a `properties(...)` expression for a bound node or relationship.
 *
 * @param target - Node, aliased edge, or alias string to inspect.
 * @returns A map-valued function expression.
 */
export function properties(target: AliasTargetInput): ValueExpression {
  return functionExpression("properties", aliasTargetToExpression(target));
}

/**
 * Creates a `size(...)` expression for lists or strings.
 *
 * @param expression - List or string expression to measure.
 * @returns A numeric function expression.
 */
export function size(expression: ValueExpression | Primitive): ValueExpression {
  return functionExpression("size", isValueExpression(expression) ? expression : value(expression));
}

/**
 * Creates a `length(...)` expression for paths.
 *
 * @param target - Path alias/reference or expression to measure.
 * @returns A numeric function expression.
 */
export function length(target: AnyAliasTargetInput | ValueExpression): ValueExpression {
  return functionExpression("length", isValueExpression(target) ? target : anyAliasTargetToExpression(target));
}

/**
 * Creates a list indexing expression, such as `labels(n)[0]`.
 *
 * @param source - List-producing expression.
 * @param index - Zero-based index expression or literal.
 * @returns A list index value expression.
 */
export function listAt(source: ValueExpression, index: ValueExpression | number): ValueExpression {
  return {
    kind: "listIndex",
    source,
    index: normalizeValueInput(index),
  };
}

/**
 * Creates a `last(...)` expression for lists.
 *
 * @param source - List-producing expression.
 * @returns A value expression for the last list item.
 */
export function last(source: ValueExpression): ValueExpression {
  return functionExpression("last", source);
}

/**
 * Creates a filtered list comprehension expression.
 *
 * @param alias - Item alias used by the predicate.
 * @param source - List-producing expression to filter.
 * @param predicate - Predicate evaluated for each list item.
 * @returns A list comprehension value expression.
 */
export function filterList(
  alias: string,
  source: ValueExpression,
  predicate: PredicateExpression,
): ValueExpression {
  return {
    kind: "listComprehension",
    alias,
    source,
    predicate,
  };
}

/**
 * Creates a list mapping expression.
 *
 * @param alias - Item alias used by the mapped expression.
 * @param source - List-producing expression to map.
 * @param expression - Expression evaluated for each list item.
 * @returns A list mapping value expression.
 */
export function mapList(
  alias: string,
  source: ValueExpression,
  expression: ValueExpression,
): ValueExpression {
  return {
    kind: "listMap",
    alias,
    source,
    expression,
  };
}

/**
 * Creates an addition expression.
 */
export function add(left: ValueInput, right: ValueInput): ValueExpression {
  return arithmetic("+", left, right);
}

/**
 * Creates a subtraction expression.
 */
export function sub(left: ValueInput, right: ValueInput): ValueExpression {
  return arithmetic("-", left, right);
}

/**
 * Creates a multiplication expression.
 */
export function mul(left: ValueInput, right: ValueInput): ValueExpression {
  return arithmetic("*", left, right);
}

/**
 * Creates a division expression.
 */
export function div(left: ValueInput, right: ValueInput): ValueExpression {
  return arithmetic("/", left, right);
}

/**
 * Creates a searched `CASE WHEN ... THEN ... ELSE ... END` expression.
 *
 * @param branches - Ordered CASE branches.
 * @param otherwise - Fallback value when no branch matches.
 * @returns A value expression.
 */
export function caseWhen(
  branches: Array<{ when: PredicateExpression; then: ValueInput }>,
  otherwise?: ValueInput,
): ValueExpression {
  return {
    kind: "case",
    branches: branches.map((branch): CaseBranch => ({
      when: branch.when,
      then: normalizeValueInput(branch.then),
    })),
    ...(otherwise === undefined ? {} : { else: normalizeValueInput(otherwise) }),
  };
}

/**
 * Creates a `count(...)` aggregate return selection.
 *
 * Without a target this compiles to `count(*)`.
 *
 * @param target - Alias, node/path/edge reference, or value expression to count.
 * @param as - Optional projected field alias.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate return selection.
 */
export function count(target?: AggregateTargetInput, as?: string, options: AggregateOptions = {}): ReturnSelection {
  return aggregateSelection(countValue(target, options), as);
}

/**
 * Creates a `count(*)` aggregate return selection.
 *
 * @param as - Optional projected field alias.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate return selection.
 */
export function countAll(as?: string, options: AggregateOptions = {}): ReturnSelection {
  return aggregateSelection(countValue(undefined, options), as);
}

/**
 * Creates a `sum(...)` aggregate return selection.
 *
 * @param target - Numeric value expression to sum.
 * @param as - Optional projected field alias.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate return selection.
 */
export function sum(target: ValueExpression, as?: string, options: AggregateOptions = {}): ReturnSelection {
  return aggregateSelection(sumValue(target, options), as);
}

/**
 * Creates an `avg(...)` aggregate return selection.
 *
 * @param target - Numeric value expression to average.
 * @param as - Optional projected field alias.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate return selection.
 */
export function avg(target: ValueExpression, as?: string, options: AggregateOptions = {}): ReturnSelection {
  return aggregateSelection(avgValue(target, options), as);
}

/**
 * Creates a `min(...)` aggregate return selection.
 *
 * @param target - Value expression to aggregate.
 * @param as - Optional projected field alias.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate return selection.
 */
export function min(target: ValueExpression, as?: string, options: AggregateOptions = {}): ReturnSelection {
  return aggregateSelection(minValue(target, options), as);
}

/**
 * Creates a `max(...)` aggregate return selection.
 *
 * @param target - Value expression to aggregate.
 * @param as - Optional projected field alias.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate return selection.
 */
export function max(target: ValueExpression, as?: string, options: AggregateOptions = {}): ReturnSelection {
  return aggregateSelection(maxValue(target, options), as);
}

/**
 * Creates a `collect(...)` aggregate return selection.
 *
 * @param target - Alias, node/path/edge reference, or value expression to collect.
 * @param as - Optional projected field alias.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate return selection.
 */
export function collect(target: AggregateTargetInput, as?: string, options: AggregateOptions = {}): ReturnSelection {
  return aggregateSelection(collectValue(target, options), as);
}

/**
 * Creates a `stDev(...)` aggregate return selection.
 *
 * @param target - Numeric value expression.
 * @param as - Optional projected field alias.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate return selection.
 */
export function stDev(target: ValueExpression, as?: string, options: AggregateOptions = {}): ReturnSelection {
  return aggregateSelection(stDevValue(target, options), as);
}

/**
 * Creates a `percentileCont(...)` aggregate return selection.
 *
 * @param target - Numeric value expression.
 * @param percentile - Percentile between 0 and 1, or a parameter/expression.
 * @param as - Optional projected field alias.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate return selection.
 */
export function percentileCont(
  target: ValueExpression,
  percentile: ValueExpression | number,
  as?: string,
  options: AggregateOptions = {},
): ReturnSelection {
  if (typeof percentile === "number" && (percentile < 0 || percentile > 1)) {
    throw new Error("percentileCont() expects percentile to be between 0 and 1.");
  }

  return aggregateSelection(percentileContValue(target, percentile, options), as);
}

/**
 * Creates a conditional `count(CASE WHEN ... THEN 1 END)` aggregate return selection.
 *
 * @param predicate - Predicate deciding which rows should be counted.
 * @param as - Optional projected field alias.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate return selection.
 */
export function countWhen(predicate: PredicateExpression, as?: string, options: AggregateOptions = {}): ReturnSelection {
  return aggregateSelection(countWhenValue(predicate, options), as);
}

/**
 * Creates a `count(...)` aggregate value expression.
 *
 * @param target - Alias, node/path/edge reference, or value expression to count.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate value expression.
 */
export function countValue(target?: AggregateTargetInput, options: AggregateOptions = {}): ValueExpression {
  return aggregateValue("count", target, options);
}

/**
 * Creates a `sum(...)` aggregate value expression.
 *
 * @param target - Numeric value expression to sum.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate value expression.
 */
export function sumValue(target: ValueExpression, options: AggregateOptions = {}): ValueExpression {
  return aggregateValue("sum", target, options);
}

/**
 * Creates an `avg(...)` aggregate value expression.
 *
 * @param target - Numeric value expression to average.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate value expression.
 */
export function avgValue(target: ValueExpression, options: AggregateOptions = {}): ValueExpression {
  return aggregateValue("avg", target, options);
}

/**
 * Creates a `min(...)` aggregate value expression.
 *
 * @param target - Value expression to aggregate.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate value expression.
 */
export function minValue(target: ValueExpression, options: AggregateOptions = {}): ValueExpression {
  return aggregateValue("min", target, options);
}

/**
 * Creates a `max(...)` aggregate value expression.
 *
 * @param target - Value expression to aggregate.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate value expression.
 */
export function maxValue(target: ValueExpression, options: AggregateOptions = {}): ValueExpression {
  return aggregateValue("max", target, options);
}

/**
 * Creates a `collect(...)` aggregate value expression.
 *
 * @param target - Alias, node/path/edge reference, or value expression to collect.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate value expression.
 */
export function collectValue(target: AggregateTargetInput, options: AggregateOptions = {}): ValueExpression {
  return aggregateValue("collect", target, options);
}

/**
 * Creates a `stDev(...)` aggregate value expression.
 *
 * @param target - Numeric value expression.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate value expression.
 */
export function stDevValue(target: ValueExpression, options: AggregateOptions = {}): ValueExpression {
  return aggregateValue("stDev", target, options);
}

/**
 * Creates a `percentileCont(...)` aggregate value expression.
 *
 * @param target - Numeric value expression.
 * @param percentile - Percentile between 0 and 1, or a parameter/expression.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate value expression.
 */
export function percentileContValue(
  target: ValueExpression,
  percentile: ValueExpression | number,
  options: AggregateOptions = {},
): ValueExpression {
  if (typeof percentile === "number" && (percentile < 0 || percentile > 1)) {
    throw new Error("percentileContValue() expects percentile to be between 0 and 1.");
  }

  return aggregateValue("percentileCont", target, options, [normalizeValueInput(percentile)]);
}

/**
 * Creates a conditional `count(CASE WHEN ... THEN 1 END)` aggregate value expression.
 *
 * @param predicate - Predicate deciding which rows should be counted.
 * @param options - Optional aggregate behavior.
 * @returns An aggregate value expression.
 */
export function countWhenValue(predicate: PredicateExpression, options: AggregateOptions = {}): ValueExpression {
  return countValue(caseWhen([{ when: predicate, then: 1 }]), options);
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
 * Creates a Cypher `IN` predicate.
 *
 * @param left - Value to look up.
 * @param right - List-producing expression, usually a parameter or `labels(...)`.
 * @returns A predicate expression.
 */
export function inList(left: ValueExpression, right: ValueExpression | PrimitiveList): PredicateExpression {
  return binary("in", left, isValueExpression(right) ? right : value(right));
}

/**
 * Creates an `IS NULL` predicate.
 *
 * @param expression - Expression or alias to check.
 * @returns A null-check predicate expression.
 */
export function isNull(expression: ValueExpression | AnyAliasTargetInput): PredicateExpression {
  return nullPredicate("isNull", normalizeNullableExpression(expression));
}

/**
 * Creates an `IS NOT NULL` predicate.
 *
 * @param expression - Expression or alias to check.
 * @returns A null-check predicate expression.
 */
export function isNotNull(expression: ValueExpression | AnyAliasTargetInput): PredicateExpression {
  return nullPredicate("isNotNull", normalizeNullableExpression(expression));
}

/**
 * Creates a Cypher `any(item IN source WHERE predicate)` list predicate.
 *
 * @param alias - Item alias used by the inner predicate.
 * @param source - List-producing expression.
 * @param predicate - Predicate evaluated for each list item.
 * @returns A list predicate expression.
 */
export function anyInList(
  alias: string,
  source: ValueExpression,
  predicate: PredicateExpression,
): PredicateExpression {
  return listPredicate("any", alias, source, predicate);
}

/**
 * Creates a Cypher `all(item IN source WHERE predicate)` list predicate.
 *
 * @param alias - Item alias used by the inner predicate.
 * @param source - List-producing expression.
 * @param predicate - Predicate evaluated for each list item.
 * @returns A list predicate expression.
 */
export function allInList(
  alias: string,
  source: ValueExpression,
  predicate: PredicateExpression,
): PredicateExpression {
  return listPredicate("all", alias, source, predicate);
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

function listPredicate(
  operator: "any" | "all",
  alias: string,
  source: ValueExpression,
  predicate: PredicateExpression,
): PredicateExpression {
  return {
    kind: "list",
    operator,
    alias,
    source,
    predicate,
  };
}

function nullPredicate(
  operator: "isNull" | "isNotNull",
  expression: ValueExpression,
): PredicateExpression {
  return {
    kind: "null",
    operator,
    expression,
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

function patternToAst(pattern: NodeRef | EdgeRef | PathRef | Pattern): Pattern[] {
  if (pattern instanceof NodeRef) {
    return [pattern.toPattern()];
  }

  if (pattern instanceof EdgeRef) {
    return [pattern.from.toPattern(), pattern.to.toPattern(), pattern.toPattern()];
  }

  if (pattern instanceof PathRef) {
    return [pattern.toPattern()];
  }

  return [pattern];
}

function applyScope(pattern: Pattern, scopeProperties: ScopeProperties): Pattern {
  if (pattern.kind === "path") {
    return {
      ...pattern,
      from: applyScope(pattern.from, scopeProperties) as NodePattern,
      to: applyScope(pattern.to, scopeProperties) as NodePattern,
      ...(Object.keys(scopeProperties).length === 0 ? {} : { scopeProperties }),
      edge: {
        ...pattern.edge,
        properties: applyScopeToProperties(
          "traversal edge",
          pattern.edge.alias ?? relationshipLabelName(pattern.edge.label),
          pattern.edge.properties,
          scopeProperties,
        ),
      },
    };
  }

  if (pattern.kind === "edge") {
    return applyScopeToEdge(pattern, scopeProperties);
  }

  if (pattern.kind !== "node" || Object.keys(scopeProperties).length === 0) {
    return pattern;
  }

  return {
    ...pattern,
    properties: applyScopeToProperties("Node", pattern.alias, pattern.properties, scopeProperties),
  };
}

function applyScopeToEdge(edge: EdgePattern, scopeProperties: ScopeProperties): EdgePattern {
  if (Object.keys(scopeProperties).length === 0) {
    return edge;
  }

  return {
    ...edge,
    properties: applyScopeToProperties("Edge", edge.alias ?? relationshipLabelName(edge.label), edge.properties, scopeProperties),
  };
}

function relationshipLabelName(label: RelationshipLabel): string {
  return Array.isArray(label) ? label.join("|") : label;
}

function applyScopeToProperties(
  kind: "Node" | "Edge" | "traversal edge",
  name: string,
  properties: Record<string, ValueExpression>,
  scopeProperties: ScopeProperties,
): Record<string, ValueExpression> {
  if (Object.keys(scopeProperties).length === 0) {
    return properties;
  }

  const duplicateKeys = Object.keys(scopeProperties).filter((key) => key in properties);

  if (duplicateKeys.length > 0) {
    throw new Error(`${kind} "${name}" already defines scoped properties: ${duplicateKeys.join(", ")}.`);
  }

  return {
    ...properties,
    ...scopeProperties,
  };
}

function assertWritePatterns(method: "create" | "merge", patterns: Pattern[]): void {
  const hasPathPattern = patterns.some((pattern) => pattern.kind === "path");

  if (hasPathPattern) {
    throw new Error(`${method}() does not support path/traversal patterns. Use match(...) for traversals.`);
  }
}

function orderExpressionToAst(expression: ValueExpression | OrderExpression): OrderExpression {
  if ("direction" in expression) {
    return expression;
  }

  return {
    expression,
    direction: "asc",
  };
}

function normalizeResultCount(method: "skip" | "limit", count: ResultCountInput): ResultCountInput {
  if (typeof count !== "number") {
    return count;
  }

  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`${method}() expects a non-negative integer or parameter expression.`);
  }

  return count;
}

function functionExpression(
  name: FunctionName,
  ...args: Array<AliasExpression | ValueExpression>
): ValueExpression {
  return {
    kind: "function",
    name,
    args,
  };
}

function arithmetic(operator: ArithmeticOperator, left: ValueInput, right: ValueInput): ValueExpression {
  return {
    kind: "arithmetic",
    operator,
    left: normalizeValueInput(left),
    right: normalizeValueInput(right),
  };
}

function normalizeValueInput(input: ValueInput): ValueExpression {
  return isValueExpression(input) ? input : value(input);
}

function aggregateValue(
  fn: AggregateFunction,
  target: AggregateTargetInput | undefined,
  options: AggregateOptions,
  args: ValueExpression[] = [],
): AggregateValueExpression {
  return {
    kind: "aggregateValue",
    fn,
    target: targetToAggregateExpression(target),
    ...(args.length === 0 ? {} : { args }),
    distinct: options.distinct === true,
  };
}

function aggregateSelection(expression: ValueExpression, as: string | undefined): ReturnSelection {
  if (expression.kind !== "aggregateValue") {
    throw new Error("aggregateSelection() expects an aggregate value expression.");
  }

  return {
    kind: "aggregate",
    fn: expression.fn,
    target: expression.target,
    ...(expression.args ? { args: expression.args } : {}),
    distinct: expression.distinct,
    ...(as ? { as } : {}),
  };
}

function targetToAggregateExpression(target: AggregateTargetInput | undefined): AggregateTargetExpression {
  if (target === undefined) {
    return { kind: "all" };
  }

  if (typeof target === "string") {
    return { kind: "aliasRef", alias: target };
  }

  if (target instanceof NodeRef) {
    return { kind: "aliasRef", alias: target.alias };
  }

  if (target instanceof EdgeRef) {
    if (!target.alias) {
      throw new Error("Aggregate edge targets must be aliased, for example count(edge(a, \"KNOWS\", b).as(\"r\")).");
    }

    return { kind: "aliasRef", alias: target.alias };
  }

  if (target instanceof PathRef) {
    if (!target.alias) {
      throw new Error("Aggregate path targets must be aliased, for example count(path(\"p\", a, \"KNOWS\", b)).");
    }

    return { kind: "aliasRef", alias: target.alias };
  }

  return target;
}

function aliasTargetToExpression(target: AliasTargetInput): AliasExpression {
  if (typeof target === "string") {
    return { kind: "aliasRef", alias: target };
  }

  if (target instanceof NodeRef) {
    return { kind: "aliasRef", alias: target.alias };
  }

  if (target instanceof EdgeRef) {
    if (!target.alias) {
      throw new Error("Edge function targets must be aliased, for example elementId(edge(a, \"KNOWS\", b).as(\"r\")).");
    }

    return { kind: "aliasRef", alias: target.alias };
  }

  throw new Error("Unsupported alias target.");
}

function anyAliasTargetToExpression(target: AnyAliasTargetInput): AliasExpression {
  if (typeof target === "string") {
    return { kind: "aliasRef", alias: target };
  }

  if (target instanceof NodeRef) {
    return { kind: "aliasRef", alias: target.alias };
  }

  if (target instanceof EdgeRef) {
    if (!target.alias) {
      throw new Error("Alias expression targets require an aliased edge, for example edge(a, \"KNOWS\", b).as(\"r\").");
    }

    return { kind: "aliasRef", alias: target.alias };
  }

  if (target instanceof PathRef) {
    if (!target.alias) {
      throw new Error("Alias expression targets require an aliased path, for example path(\"p\", a, \"KNOWS\", b).");
    }

    return { kind: "aliasRef", alias: target.alias };
  }

  throw new Error("Unsupported alias target.");
}

function normalizeNullableExpression(input: ValueExpression | AnyAliasTargetInput): ValueExpression {
  return isValueExpression(input) ? input : anyAliasTargetToExpression(input);
}

function validateHops(minHops: number, maxHops: number | undefined): void {
  if (!Number.isInteger(minHops) || minHops < 0) {
    throw new Error("Traversal minHops must be a non-negative integer.");
  }

  if (maxHops !== undefined && (!Number.isInteger(maxHops) || maxHops < minHops)) {
    throw new Error("Traversal maxHops must be an integer greater than or equal to minHops.");
  }
}

function selectionToAst(selection: NodeRef | PathRef | string | ReturnSelection | ValueExpression): ReturnSelection {
  if (typeof selection === "string") {
    return { kind: "alias", alias: selection };
  }

  if (selection instanceof NodeRef) {
    return { kind: "alias", alias: selection.alias };
  }

  if (selection instanceof PathRef) {
    if (!selection.alias) {
      throw new Error("return() expects an aliased path, for example return(path(\"p\", a, \"KNOWS\", b)).");
    }

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

  if (selection.kind === "aggregate") {
    return selection;
  }

  if (selection.kind === "expression") {
    return selection;
  }

  if (selection.kind === "map") {
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
      value.kind === "rowProperty" ||
      value.kind === "listItem" ||
      value.kind === "variable" ||
      value.kind === "aliasRef" ||
      value.kind === "mapProperty" ||
      value.kind === "dynamicProperty" ||
      value.kind === "mapValue" ||
      value.kind === "listIndex" ||
      value.kind === "listComprehension" ||
      value.kind === "listMap" ||
      value.kind === "aggregateValue" ||
      value.kind === "function" ||
      value.kind === "arithmetic" ||
      value.kind === "case")
  );
}
