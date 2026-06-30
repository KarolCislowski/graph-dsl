# graph-dsl

Typed graph query DSL for JavaScript/TypeScript.

`graph-dsl` lets you describe graph operations with a small TypeScript DSL. The DSL emits a portable AST, and that AST can then be compiled or executed by different backends.

```txt
DSL -> AST -> Cypher Compiler -> Neo4j
         |
         +-> Gremlin Compiler -> JanusGraph
         |
         +-> Memory Executor -> Mock database/tests
```

The current package is an MVP. It already supports a neutral AST, a fluent DSL, Cypher compilation, and an in-memory executor useful for tests.

## Installation

```bash
npm install graph-dsl
```

For local development in this repository:

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Quick Start

```ts
import { compileCypher, edge, eq, node, param, prop, query, select } from "graph-dsl";

const user = node("u", "User");
const post = node("p", "Post");

const ast = query()
  .match(edge(user, "WROTE", post))
  .where(eq(prop(user, "email"), param("email")))
  .return(post, select(user, "email", "authorEmail"))
  .toAst();

const cypher = compileCypher(ast, {
  params: { email: "ada@example.com" },
});

console.log(cypher.query);
// MATCH (u:User)-[:WROTE]->(p:Post)
// WHERE u.email = $email
// RETURN p, u.email AS authorEmail
```

## Mental Model

The DSL does not directly generate Cypher strings. Instead, it builds a query AST:

```ts
const ast = query()
  .match(node("u", "User"))
  .where(eq(prop("u", "email"), param("email")))
  .return(select("u", "email", "email"))
  .toAst();
```

That AST is the stable middle layer. Compilers and executors consume the AST:

```ts
const cypher = compileCypher(ast, {
  params: { email: "ada@example.com" },
});
```

This keeps the public DSL independent from one database vendor.

## Core Concepts

### Nodes

```ts
const user = node("u", "User");
const post = node("p", "Post");
```

The first argument is the alias used in the query. Remaining arguments are labels.

```ts
const user = node("u", "User", "Author");
```

Node properties can be literals or parameters:

```ts
const user = node("u", "User").props({
  email: param("email"),
  name: "Ada",
});
```

### Edges

```ts
const wrote = edge(user, "WROTE", post);
```

By default, edges are outgoing:

```txt
(user)-[:WROTE]->(post)
```

You can pass a direction explicitly:

```ts
edge(user, "FOLLOWS", friend, "out");
edge(user, "FOLLOWS", friend, "in");
edge(user, "FOLLOWS", friend, "both");
```

Edges can also be aliased, which is useful for returning or deleting them:

```ts
const relation = edge(user, "FOLLOWS", friend).as("r");
```

### Properties

`prop(ref, key)` creates a property expression. It does not read a value immediately. It points to a property on a matched or created graph entity.

```ts
prop(user, "email");
user.prop("email");
prop("u", "email");
```

All three examples mean the same thing when `user.alias === "u"`:

```cypher
u.email
```

Use property expressions in `where(...)`, `set(...)`, and `return(...)`:

```ts
query()
  .match(node("u", "User"))
  .where(eq(prop("u", "email"), param("email")))
  .set(prop("u", "name"), "Ada Lovelace")
  .return(select("u", "name", "name"));
```

### Parameters

`param(name)` creates a named runtime parameter. Parameters are values supplied when compiling or executing the AST.

```ts
where(eq(user.prop("email"), param("email")));
```

For Cypher, named parameters compile to `$email`:

```ts
compileCypher(ast, {
  params: { email: "ada@example.com" },
});
```

```cypher
WHERE u.email = $email
```

Use parameters for values coming from users, requests, forms, API inputs, or test setup.

### Literal Values

You can pass literal values directly to predicates and `set(...)`:

```ts
where(gte(prop("u", "age"), 18));
set(prop("u", "active"), true);
```

For Cypher, literals are converted to generated parameters:

```cypher
WHERE u.age >= $p0
SET u.active = $p1
```

You can also wrap a literal explicitly with `value(...)`:

```ts
where(eq(prop("u", "role"), value("admin")));
```

Most of the time, direct literals are easier to read.

### Scope

`scope(props)` adds the same properties to every node used by later `match(...)` and `create(...)` clauses.

This is useful for multi-tenant data, workspace isolation, organization boundaries, or any other context that should be present on every node:

```ts
const user = node("u", "User");
const post = node("p", "Post");

const ast = query()
  .scope({
    tenantId: param("tenantId"),
    workspaceId: param("workspaceId"),
    orgId: param("orgId"),
  })
  .match(edge(user, "WROTE", post))
  .where(eq(user.prop("email"), param("email")))
  .return(post)
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User { tenantId: $tenantId, workspaceId: $workspaceId, orgId: $orgId })-[:WROTE]->(p:Post { tenantId: $tenantId, workspaceId: $workspaceId, orgId: $orgId })
WHERE u.email = $email
RETURN p
```

Scope is applied to nodes, not edges:

```ts
query()
  .scope({ tenantId: param("tenantId") })
  .match(edge(node("u", "User"), "WROTE", node("p", "Post")));
```

The generated node patterns get `tenantId`, while the `WROTE` relationship does not.

Scope also applies to created nodes:

```ts
const ast = query()
  .scope({ tenantId: param("tenantId") })
  .create(node("u", "User").props({ email: param("email") }))
  .toAst();
```

Cypher output:

```cypher
CREATE (u:User { email: $email, tenantId: $tenantId })
```

If a node explicitly defines a property that also exists in the scope, the builder throws an error:

```ts
query()
  .scope({ tenantId: param("tenantId") })
  .match(node("u", "User").props({ tenantId: param("otherTenantId") }));
```

This is intentional. Scope is commonly used for data isolation, so accidental overrides should be loud.

## Query Operations

### Read

```ts
const user = node("u", "User");
const post = node("p", "Post");

const ast = query()
  .match(edge(user, "WROTE", post))
  .where(eq(user.prop("email"), param("email")))
  .return(select(post, "title", "title"), select(user, "name", "author"))
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)-[:WROTE]->(p:Post)
WHERE u.email = $email
RETURN p.title AS title, u.name AS author
```

### Create

```ts
const user = node("u", "User").props({
  email: param("email"),
  name: param("name"),
});

const ast = query()
  .create(user)
  .return(select(user, "email", "email"))
  .toAst();
```

Cypher output:

```cypher
CREATE (u:User { email: $email, name: $name })
RETURN u.email AS email
```

### Update

```ts
const ast = query()
  .match(node("u", "User"))
  .where(eq(prop("u", "email"), param("email")))
  .set(prop("u", "name"), "Ada Lovelace")
  .return(select("u", "name", "name"))
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)
WHERE u.email = $email
SET u.name = $p0
RETURN u.name AS name
```

### Delete

```ts
const ast = query()
  .match(node("u", "User"))
  .where(eq(prop("u", "email"), param("email")))
  .delete("u")
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)
WHERE u.email = $email
DELETE u
```

## Bulk Operations

Use `unwind(...)` when you want to create or update many nodes/edges from a JavaScript array.

The DSL compiles this to Cypher `UNWIND`, so one parameterized query can process many rows:

```ts
import { compileCypher, node, param, query, row } from "graph-dsl";

const ast = query()
  .scope({ tenantId: param("tenantId") })
  .unwind(param("users"), "item")
  .create(
    node("u", "User").props({
      id: row("item", "id"),
      email: row("item", "email"),
      name: row("item", "name"),
    }),
  )
  .toAst();

const result = compileCypher(ast, {
  params: {
    tenantId: "tenant-1",
    users: [
      { id: "user-1", email: "ada@example.com", name: "Ada" },
      { id: "user-2", email: "grace@example.com", name: "Grace" },
    ],
  },
});
```

Cypher output:

```cypher
UNWIND $users AS item
CREATE (u:User { id: item.id, email: item.email, name: item.name, tenantId: $tenantId })
```

`row(alias, key)` reads a field from the current unwound item:

```ts
row("item", "email");
```

which compiles to:

```cypher
item.email
```

### Bulk Edge Creation

When creating edges between existing nodes, first match the nodes from row data, then use `createEdge(...)`.

```ts
import { edge, node, param, query, row } from "graph-dsl";

const user = node("u", "User").props({
  id: row("item", "userId"),
});

const post = node("p", "Post").props({
  id: row("item", "postId"),
});

const ast = query()
  .scope({ tenantId: param("tenantId") })
  .unwind(param("writes"), "item")
  .match(user, post)
  .createEdge(
    edge(user, "WROTE", post).props({
      createdAt: row("item", "createdAt"),
    }),
  )
  .toAst();
```

Cypher output:

```cypher
UNWIND $writes AS item
MATCH (u:User { id: item.userId, tenantId: $tenantId }), (p:Post { id: item.postId, tenantId: $tenantId })
CREATE (u)-[:WROTE { createdAt: item.createdAt }]->(p)
```

`create(...)` is for creating full node/edge patterns. `createEdge(...)` is for creating only relationships between aliases that are already bound by earlier clauses.

## Predicates

Predicates describe boolean conditions, usually passed to `where(...)`.

Each comparison helper accepts a left expression and a right expression or literal:

```ts
eq(prop("u", "email"), param("email"));
gte(prop("u", "age"), 18);
contains(prop("u", "email"), "@example.com");
```

Comparison helpers:

| Helper | Meaning | Cypher output example |
| --- | --- | --- |
| `eq(left, right)` | Checks equality. | `u.email = $email` |
| `neq(left, right)` | Checks inequality. | `u.status != $p0` |
| `gt(left, right)` | Checks that `left` is greater than `right`. | `u.age > $p0` |
| `gte(left, right)` | Checks that `left` is greater than or equal to `right`. | `u.age >= $p0` |
| `lt(left, right)` | Checks that `left` is less than `right`. | `u.age < $p0` |
| `lte(left, right)` | Checks that `left` is less than or equal to `right`. | `u.age <= $p0` |
| `contains(left, right)` | Checks that a string contains another string. | `u.email CONTAINS $p0` |

Logical helpers combine other predicates:

| Helper | Meaning | Cypher output example |
| --- | --- | --- |
| `and(a, b, ...)` | All child predicates must be true. | `(u.age >= $p0) AND (u.active = $p1)` |
| `or(a, b, ...)` | At least one child predicate must be true. | `(u.role = $p0) OR (u.role = $p1)` |
| `not(predicate)` | Negates a predicate. | `NOT (u.deleted = $p0)` |

Example with comparison and logical predicates:

```ts
import { and, contains, eq, gte, node, not, prop, query, select } from "graph-dsl";

const ast = query()
  .match(node("u", "User"))
  .where(
    and(
      eq(prop("u", "active"), true),
      gte(prop("u", "age"), 18),
      contains(prop("u", "email"), "@example.com"),
      not(eq(prop("u", "deleted"), true)),
    ),
  )
  .return(select("u", "email", "email"))
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)
WHERE (u.active = $p0) AND (u.age >= $p1) AND (u.email CONTAINS $p2) AND (NOT (u.deleted = $p3))
RETURN u.email AS email
```

## Returning Data

Return a whole node:

```ts
query().match(node("u", "User")).return(node("u", "User"));
```

Return a property:

```ts
query()
  .match(node("u", "User"))
  .return(select("u", "email"));
```

Return a property with an alias:

```ts
query()
  .match(node("u", "User"))
  .return(select("u", "email", "email"));
```

## Cypher Compiler

```ts
import { compileCypher } from "graph-dsl";

const result = compileCypher(ast, {
  params: {
    email: "ada@example.com",
  },
});

console.log(result.query);
console.log(result.params);
```

Compiler result:

```ts
type CompilerOutput = {
  query: string;
  params: Record<string, string | number | boolean | null>;
};
```

## Memory Executor

The memory executor runs the same AST against an in-memory graph. It is useful for tests, mocks, and checking DSL semantics without a database.

```ts
import { executeMemory, type MemoryGraph } from "graph-dsl";

const graph: MemoryGraph = {
  nodes: [
    {
      id: "user-1",
      labels: ["User"],
      properties: { email: "ada@example.com", name: "Ada" },
    },
    {
      id: "post-1",
      labels: ["Post"],
      properties: { title: "Graph DSLs" },
    },
  ],
  edges: [
    {
      id: "edge-1",
      label: "WROTE",
      from: "user-1",
      to: "post-1",
      properties: {},
    },
  ],
};

const rows = executeMemory(ast, graph, {
  params: { email: "ada@example.com" },
});
```

`executeMemory(...)` mutates the graph for `create`, `set`, and `delete` operations.

## AST Shape

The AST is intentionally small:

```ts
type QueryAst = {
  kind: "query";
  clauses: Clause[];
};
```

Supported clause kinds:

```ts
type Clause =
  | MatchClause
  | CreateClause
  | WhereClause
  | ReturnClause
  | SetPropertyClause
  | DeleteClause;
```

You can inspect it directly:

```ts
console.log(JSON.stringify(ast, null, 2));
```

## Current Limitations

- Gremlin compiler is not implemented yet.
- Typed schema API is not implemented yet.
- `set(...)` currently updates one property at a time.
- The memory executor is intentionally small and not a full database.
- Cypher support currently covers the portable MVP: `MATCH`, `CREATE`, `WHERE`, `SET`, `DELETE`, and `RETURN`.

## Roadmap

The next useful layer is a typed schema API:

```ts
const schema = defineGraph({
  User: {
    props: {
      id: string(),
      email: string(),
    },
  },
  Post: {
    props: {
      id: string(),
      title: string(),
    },
  },
  WROTE: {
    from: "User",
    to: "Post",
  },
});
```

That schema can later make invalid traversals a TypeScript error:

```ts
user.out("WROTE", post); // ok
post.out("WROTE", user); // type error
```
