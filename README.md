# graph-dsl

Typed graph query DSL for JavaScript/TypeScript.

`graph-dsl` lets you describe graph operations with a small TypeScript DSL. The DSL emits a portable AST, and that AST can then be compiled or executed by different backends.

```txt
DSL -> AST -> Cypher Compiler -> Neo4j
         |
         +-> Ladybug Cypher Compiler -> LadybugDB
         |
         +-> Gremlin Compiler -> JanusGraph
         |
         +-> Memory Executor -> Mock database/tests
```

The current package is an MVP. It already supports a neutral AST, a fluent DSL, Cypher compilation, and an in-memory executor useful for tests.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Mental Model](#mental-model)
- [Core Concepts](#core-concepts)
- [Query Operations](#query-operations)
- [Runtime Schemas](#runtime-schemas)
- [Bulk Operations](#bulk-operations)
- [Path Traversal](#path-traversal)
- [Aggregations](#aggregations)
- [Predicates](#predicates)
- [Returning Data](#returning-data)
- [Cypher Compiler](#cypher-compiler)
- [Ladybug Compiler](#ladybug-compiler)
- [Memory Executor](#memory-executor)
- [AST Shape](#ast-shape)
- [Current Limitations](#current-limitations)
- [Roadmap](#roadmap)

## Installation

This package is private and is currently intended to be installed directly from the private GitHub repository over SSH.

```bash
npm install git+ssh://git@github.com/KarolCislowski/graph-dsl.git
```

You can also pin a branch, tag, or commit:

```bash
npm install git+ssh://git@github.com/KarolCislowski/graph-dsl.git#main
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

Use `anyNode(alias)` when a scoped/admin query intentionally matches any node label:

```ts
query()
  .scope({ graphId: param("graphId") })
  .match(anyNode("node"));
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

For reads, an edge can match any of several relationship types:

```ts
edge(user, ["WROTE", "EDITED"], post).as("r");
```

This compiles to:

```cypher
(user)-[r:WROTE|EDITED]->(post)
```

Use `anyEdge(from, to, direction)` when a query intentionally matches any relationship type:

```ts
query()
  .match(anyEdge(anyNode("source"), anyNode("target"), "both").as("relationship"));
```

### Paths And Traversals

Use `traverse(...)` when you want to match a variable-length relationship chain instead of one fixed edge:

```ts
const source = node("source", "Person");
const target = node("target", "Person");

const traversal = traverse(source, "KNOWS", target).hops(1, 3);
```

This compiles to a variable-length relationship:

```cypher
(source:Person)-[:KNOWS*1..3]->(target:Person)
```

Traversals can also match several relationship types:

```ts
traverse(source, ["KNOWS", "FOLLOWS"], target).hops(1, 3);
```

Use `path(alias, ...)` when you want to name and return the whole path:

```ts
const p = path("p", source, "KNOWS", target).hops(1, 3);
```

`hops(min, max)` sets a bounded traversal range. `hops(min)` means `min` or more hops in Cypher. The in-memory executor requires a bounded `max` to avoid open-ended graph walks in tests.

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

`scope(props)` adds the same properties to every node and edge used by later query clauses.

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
MATCH (u:User { tenantId: $tenantId, workspaceId: $workspaceId, orgId: $orgId })-[:WROTE { tenantId: $tenantId, workspaceId: $workspaceId, orgId: $orgId }]->(p:Post { tenantId: $tenantId, workspaceId: $workspaceId, orgId: $orgId })
WHERE u.email = $email
RETURN p
```

Scope is applied to both nodes and edges:

```ts
query()
  .scope({ tenantId: param("tenantId") })
  .match(edge(node("u", "User"), "WROTE", node("p", "Post")));
```

The generated node patterns and the `WROTE` relationship all get `tenantId`. Traversal relationships created with `traverse(...)` get the same scoped properties too.

When an aliased path is matched with `path("p", ...)`, scope is also enforced against the full returned path:

```ts
const ast = query()
  .scope({ tenantId: param("tenantId") })
  .match(path("p", node("a", "Person"), "KNOWS", node("b", "Person")).hops(1, 3))
  .return("p")
  .toAst();
```

Cypher output includes guards for every node and relationship inside `p`:

```cypher
MATCH p = (a:Person { tenantId: $tenantId })-[:KNOWS*1..3 { tenantId: $tenantId }]->(b:Person { tenantId: $tenantId })
WHERE all(n IN nodes(p) WHERE n.tenantId = $tenantId) AND all(r IN relationships(p) WHERE r.tenantId = $tenantId)
WITH *
RETURN p
```

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

If a node or edge explicitly defines a property that also exists in the scope, the builder throws an error:

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

Use `optionalMatch(...)` when related data should not filter out the base row:

```ts
const ast = query()
  .match(user)
  .optionalMatch(edge(user, "WROTE", post))
  .return(select(user, "email", "email"), select(post, "title", "title"))
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)
OPTIONAL MATCH (u:User)-[:WROTE]->(p:Post)
RETURN u.email AS email, p.title AS title
```

`optionalMatch(...)` must follow at least one non-optional `match(...)` clause so the query is anchored before optional expansion.

Use `orderBy(...)`, `skip(...)`, and `limit(...)` to control result order and pagination:

```ts
const ast = query()
  .match(user)
  .return(select(user, "name", "name"))
  .orderBy(order(user.prop("name"), "desc"))
  .skip(param("offset"))
  .limit(25)
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)
RETURN u.name AS name
ORDER BY u.name DESC
SKIP $offset
LIMIT 25
```

Use `with(...)` to project values into the next pipeline stage:

```ts
const ast = query()
  .match(user)
  .optionalMatch(edge(user, "WROTE", post))
  .with(user, count(post, "postCount"))
  .where(gte(variable("postCount"), 1))
  .return(select(user, "email", "email"), "postCount")
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)
OPTIONAL MATCH (u:User)-[:WROTE]->(p:Post)
WITH u, count(p) AS postCount
WHERE postCount >= $p0
RETURN u.email AS email, postCount
```

Use `variable(name)` when a later predicate, sort, or expression needs a scalar alias produced by `with(...)`.

Use `call(...)` for nested subqueries that produce additional columns for each current row:

```ts
const user = node("u", "User");
const post = node("p", "Post");

const postCount = query()
  .with(user)
  .optionalMatch(edge(user, "WROTE", post))
  .return(count(post, "postCount"));

const ast = query()
  .match(user)
  .call(postCount, { import: [user] })
  .return(
    map("user", {
      email: user.prop("email"),
      postCount: variable("postCount"),
    }),
  )
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)
CALL {
  WITH u
  OPTIONAL MATCH (u:User)-[:WROTE]->(p:Post)
  RETURN count(p) AS postCount
}
RETURN { email: u.email, postCount: postCount } AS user
```

When a subquery needs outer aliases, pass them through `call(subquery, { import: [...] })`. In Cypher this is represented by an initial `WITH` inside the subquery. For the in-memory executor, the same import list controls which outer bindings are visible to the nested query.

### Path Traversal

Use `traverse(...)` for variable-length graph reads:

```ts
const source = node("source", "Person").props({ id: param("sourceId") });
const target = node("target", "Person").props({ id: param("targetId") });

const ast = query()
  .match(traverse(source, "KNOWS", target).hops(1, 3))
  .return(target)
  .toAst();
```

Cypher output:

```cypher
MATCH (source:Person { id: $sourceId })-[:KNOWS*1..3]->(target:Person { id: $targetId })
RETURN target
```

Use `path(alias, ...)` to bind the whole path:

```ts
const ast = query()
  .match(path("p", source, "KNOWS", target).hops(1, 3))
  .return("p", select(target, "id", "targetId"))
  .toAst();
```

Cypher output:

```cypher
MATCH p = (source:Person { id: $sourceId })-[:KNOWS*1..3]->(target:Person { id: $targetId })
RETURN p, target.id AS targetId
```

Traversals can be undirected, can bind the traversed relationships, and can apply relationship property filters:

```ts
const ast = query()
  .match(
    traverse(source, "KNOWS", target, "both")
      .hops(2, 2)
      .via("rels")
      .props({ active: true }),
  )
  .return("rels", target)
  .toAst();
```

Cypher output:

```cypher
MATCH (source:Person { id: $sourceId })-[rels:KNOWS*2 { active: $p0 }]-(target:Person { id: $targetId })
RETURN rels, target
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

### Merge

Use `merge(...)` when a node pattern should be found or created by identity properties:

```ts
const ast = query()
  .scope({ tenantId: param("tenantId") })
  .merge(node("u", "User").props({ id: param("userId") }))
  .toAst();
```

Cypher output:

```cypher
MERGE (u:User { id: $userId, tenantId: $tenantId })
```

Use `mergeEdge(...)` when the endpoint nodes are already bound:

```ts
const user = node("u", "User").props({ id: param("userId") });
const post = node("p", "Post").props({ id: param("postId") });

const ast = query()
  .scope({ tenantId: param("tenantId") })
  .merge(user)
  .merge(post)
  .mergeEdge(edge(user, "WROTE", post).props({ role: "author" }))
  .toAst();
```

Cypher output:

```cypher
MERGE (u:User { id: $userId, tenantId: $tenantId })
MERGE (p:Post { id: $postId, tenantId: $tenantId })
MERGE (u)-[:WROTE { role: $p0, tenantId: $tenantId }]->(p)
```

Properties inside a `merge(...)` pattern are identity properties. If you want to merge by one field and update other fields, merge the identity pattern first and then use `set(...)`, `setProps(...)`, `onCreateSet(...)`, or `onMatchSet(...)`.

Use `onCreateSet(...)` for values that should be written only when the merge creates a new node or edge. Use `onMatchSet(...)` for values that should be written only when the merge finds an existing node or edge:

```ts
const ast = query()
  .merge(node("p", "Person").props({ id: param("personId") }))
  .onCreateSet(prop("p", "createdAt"), param("now"))
  .onMatchSet(prop("p", "updatedAt"), param("now"))
  .toAst();
```

Cypher output:

```cypher
MERGE (p:Person { id: $personId })
ON CREATE SET p.createdAt = $now
ON MATCH SET p.updatedAt = $now
```

Schema patches can be used with merge-specific setters too:

```ts
const identity = Person.identity("p", formData, ["id"]);
const createPatch = Person.patch("p", {
  name: formData.name,
  createdAt: formData.createdAt,
});
const matchPatch = Person.patch("p", {
  name: formData.name,
  updatedAt: formData.updatedAt,
});

const ast = query()
  .merge(identity.node)
  .onCreateSetProps(createPatch)
  .onMatchSetProps(matchPatch)
  .toAst();
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

Use `setMap(...)` for Cypher map patches such as `SET node += row`:

```ts
const ast = query()
  .match(node("u", "User"))
  .where(eq(prop("u", "email"), param("email")))
  .setMap("u", row("item", "patch"))
  .return("u")
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)
WHERE u.email = $email
SET u += item.patch
RETURN u
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

### Detach Delete

Use this when the node may still have relationships.

```ts
const ast = query()
  .match(node("u", "User"))
  .where(eq(prop("u", "email"), param("email")))
  .detachDelete("u")
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)
WHERE u.email = $email
DETACH DELETE u
```

## Runtime Schemas

You can describe node and edge properties with a serializable JSON schema. This is useful when schemas are stored outside the codebase, for example in MongoDB.

```ts
import { compileCypher, defineNodeFromJson, query } from "graph-dsl";

const schemaDoc = {
  kind: "node",
  label: "Person",
  fields: {
    id: { type: "string", required: true },
    name: { type: "string", required: true },
    age: { type: "number" },
    active: { type: "boolean" },
  },
} as const;

const Person = defineNodeFromJson(schemaDoc);
```

Map a plain JavaScript object, such as form data, to a DSL node and generated params:

```ts
const mapped = Person.from("p", {
  id: "person-1",
  name: "Ada",
  age: 36,
  active: true,
});

const ast = query()
  .create(mapped.node)
  .toAst();

const result = compileCypher(ast, {
  params: mapped.params,
});
```

Cypher output:

```cypher
CREATE (p:Person { id: $p_id, name: $p_name, age: $p_age, active: $p_active })
```

Generated params:

```ts
{
  p_id: "person-1",
  p_name: "Ada",
  p_age: 36,
  p_active: true,
}
```

The mapper validates input at runtime:

- required fields must be present
- field values must match their schema type
- unknown fields throw by default
- optional fields with `undefined` are skipped

Unknown fields can be stripped instead:

```ts
const Car = defineNodeFromJson({
  kind: "node",
  label: "Car",
  fields: {
    id: { type: "string", required: true },
    model: { type: "string", required: true },
  },
  options: {
    unknownFields: "strip",
  },
});
```

You can load the same JSON shape from MongoDB:

```ts
const schemaDoc = await db.collection("graphSchemas").findOne({
  label: "Person",
});

const Person = defineNodeFromJson(schemaDoc);
const mapped = Person.from("p", formData);
```

For merges, use `identity(...)` to map only the fields that identify the graph entity. Selected identity fields must be present even if the schema marks them as optional, and the rest of the input is ignored for the identity pattern:

```ts
const identity = Person.identity("p", formData, ["id"], {
  paramPrefix: "person",
});

const ast = query()
  .merge(identity.node)
  .toAst();
```

Cypher output:

```cypher
MERGE (p:Person { id: $person_id })
```

For updates, use `patch(...)`. Patches validate only fields that are present, so `required` fields are not required for partial updates:

```ts
const patch = Person.patch("p", {
  name: "Ada Lovelace",
  age: 37,
});

const ast = query()
  .match(node("p", "Person").props({ id: param("personId") }))
  .setProps(patch)
  .toAst();

const result = compileCypher(ast, {
  params: {
    personId: "person-1",
    ...patch.params,
  },
});
```

Cypher output:

```cypher
MATCH (p:Person { id: $personId })
SET p.name = $p_name
SET p.age = $p_age
```

Edge schemas work the same way:

```ts
import { defineEdgeFromJson, node, param } from "graph-dsl";

const Wrote = defineEdgeFromJson({
  kind: "edge",
  label: "WROTE",
  fields: {
    role: { type: "string", required: true },
    createdAt: { type: "string", required: true },
    featured: { type: "boolean" },
  },
});

const person = node("p", "Person").props({
  id: param("personId"),
});

const post = node("post", "Post").props({
  id: param("postId"),
});

const mappedEdge = Wrote.from(
  person,
  post,
  {
    role: "author",
    createdAt: "2026-06-30",
    featured: true,
  },
  { paramPrefix: "wrote" },
);

const ast = query()
  .match(person, post)
  .createEdge(mappedEdge.edge)
  .toAst();
```

Cypher output:

```cypher
MATCH (p:Person { id: $personId }), (post:Post { id: $postId })
CREATE (p)-[:WROTE { role: $wrote_role, createdAt: $wrote_createdAt, featured: $wrote_featured }]->(post)
```

Edge schemas also support patches for already-bound relationship aliases:

```ts
const relation = edge(person, "WROTE", post).as("r");

const patch = Wrote.patch("r", {
  featured: true,
});

const ast = query()
  .match(relation)
  .setProps(patch)
  .toAst();
```

Cypher output:

```cypher
MATCH (p:Person)-[r:WROTE]->(post:Post)
SET r.featured = $r_featured
```

For relationship identity, use `Wrote.identity(...)` with `mergeEdge(...)`:

```ts
const identityEdge = Wrote.identity(person, post, {
  role: "author",
  createdAt: "2026-06-30",
}, ["role"]);

const ast = query()
  .match(person, post)
  .mergeEdge(identityEdge.edge)
  .toAst();
```

Cypher output:

```cypher
MATCH (p:Person { id: $personId }), (post:Post { id: $postId })
MERGE (p)-[:WROTE { role: $p_WROTE_post_role }]->(post)
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
CREATE (u)-[:WROTE { createdAt: item.createdAt, tenantId: $tenantId }]->(p)
```

`create(...)` is for creating full node/edge patterns. `createEdge(...)` is for creating only relationships between aliases that are already bound by earlier clauses.

### Batching Bulk Operations

For large inputs, avoid passing the entire array as one parameter. Use `runParamBatches(...)` to execute the same `UNWIND` query in smaller chunks.

The helper is driver-neutral: you decide what happens for each batch.

```ts
import { compileCypher, runParamBatches } from "graph-dsl";

await runParamBatches({
  items: hugeUsersArray,
  batchParam: "users",
  batchSize: 1000,
  params: {
    tenantId: "tenant-1",
  },
  onBatch: async (params, meta) => {
    const compiled = compileCypher(ast, { params });

    await session.run(compiled.query, compiled.params);

    console.log(`Batch ${meta.index + 1}/${meta.totalBatches ?? "?"}`);
  },
});
```

The same helper can be used with the memory executor:

```ts
import { executeMemory, runParamBatches } from "graph-dsl";

await runParamBatches({
  items: hugeUsersArray,
  batchParam: "users",
  batchSize: 1000,
  params: {
    tenantId: "tenant-1",
  },
  onBatch: (params) => executeMemory(ast, graph, { params }),
});
```

For lower-level control, use `chunk(...)` or `runBatches(...)`:

```ts
for (const usersBatch of chunk(hugeUsersArray, { batchSize: 1000 })) {
  const compiled = compileCypher(ast, {
    params: {
      tenantId: "tenant-1",
      users: usersBatch,
    },
  });

  await session.run(compiled.query, compiled.params);
}
```

## Aggregations

Aggregate helpers are return selections. Use them inside `return(...)` together with aliases or property selections.

```ts
import { collect, count, countAll, edge, node, prop, query, select } from "graph-dsl";

const user = node("u", "User");
const post = node("p", "Post");

const ast = query()
  .match(edge(user, "WROTE", post))
  .return(
    select(user, "role", "role"),
    countAll("rows"),
    count(post, "postCount"),
    collect(prop(post, "title"), "titles", { distinct: true }),
  )
  .toAst();
```

Cypher output:

```cypher
MATCH (u:User)-[:WROTE]->(p:Post)
RETURN u.role AS role, count(*) AS rows, count(p) AS postCount, collect(DISTINCT p.title) AS titles
```

Cypher groups by every non-aggregate return selection. In the example above, results are grouped by `u.role`.

Supported aggregate helpers:

| Helper | Meaning | Example |
| --- | --- | --- |
| `countAll(as)` | Counts rows with `count(*)`. | `countAll("rows")` |
| `count(target, as)` | Counts non-null values for an alias or expression. | `count(node("u"), "users")` |
| `sum(expression, as)` | Sums numeric values. | `sum(prop("u", "score"), "totalScore")` |
| `avg(expression, as)` | Averages numeric values. | `avg(prop("u", "score"), "avgScore")` |
| `min(expression, as)` | Returns the smallest value. | `min(prop("u", "age"), "youngest")` |
| `max(expression, as)` | Returns the largest value. | `max(prop("u", "age"), "oldest")` |
| `collect(target, as)` | Collects values into a list. | `collect(prop("u", "email"), "emails")` |
| `stDev(expression, as)` | Returns sample standard deviation. | `stDev(prop("u", "score"), "scoreStdDev")` |
| `percentileCont(expression, percentile, as)` | Returns a continuous percentile with interpolation. | `percentileCont(prop("u", "score"), 0.95, "p95")` |
| `countWhen(predicate, as)` | Counts rows where a predicate is true. | `countWhen(lt(variable("value"), param("low")), "low")` |

Every aggregate helper accepts `{ distinct: true }` as the last argument:

```ts
query()
  .match(node("u", "User"))
  .return(count(prop("u", "role"), "roles", { distinct: true }));
```

Cypher output:

```cypher
MATCH (u:User)
RETURN count(DISTINCT u.role) AS roles
```

Neo4j statistical aggregates are also available:

```ts
query()
  .match(node("u", "User"))
  .return(
    stDev(prop("u", "score"), "scoreStdDev"),
    percentileCont(prop("u", "score"), 0.95, "p95"),
  );
```

Cypher output:

```cypher
MATCH (u:User)
RETURN stDev(u.score) AS scoreStdDev, percentileCont(u.score, $p0) AS p95
```

Aggregate value helpers can be embedded inside larger expressions. This is useful for composed aggregate projections such as variance:

```ts
query()
  .match(node("u", "User"))
  .return(
    expr(
      mul(stDevValue(prop("u", "score")), stDevValue(prop("u", "score"))),
      "variance",
    ),
  );
```

Cypher output:

```cypher
MATCH (u:User)
RETURN (stDev(u.score) * stDev(u.score)) AS variance
```

Available aggregate value helpers mirror the return-selection helpers: `countValue(...)`, `sumValue(...)`, `avgValue(...)`, `minValue(...)`, `maxValue(...)`, `collectValue(...)`, `stDevValue(...)`, and `percentileContValue(...)`.

For conditional counts, use `countWhen(...)` or `countWhenValue(...)`:

```ts
query()
  .with(expr(toFloat(row("item", "age")), "value"))
  .return(
    countWhen(lt(variable("value"), param("lowThreshold")), "low"),
    countWhen(gt(variable("value"), param("highThreshold")), "high"),
  );
```

Cypher output:

```cypher
WITH toFloat(item.age) AS value
RETURN count(CASE WHEN value < $lowThreshold THEN $p0 END) AS low, count(CASE WHEN value > $highThreshold THEN $p1 END) AS high
```

Map values can be collected or passed through expression helpers:

```ts
const company = node("company", "Company");

query()
  .match(company)
  .return(
    collect(
      mapValue({
        nodeId: elementId(company),
        labels: labels(company),
        properties: properties(company),
      }),
      "companies",
      { distinct: true },
    ),
  );
```

Dynamic property access and mapped list comprehensions cover runtime-selected identity fields:

```ts
const record = node("node", "Person");

query()
  .match(record)
  .with(
    expr(
      mapList(
        "field",
        param("identityFields"),
        toString(dynamicProp(record, listItem("field"))),
      ),
      "identityValues",
    ),
    count(record, "recordCount"),
  );
```

Cypher output:

```cypher
MATCH (node:Person)
WITH [field IN $identityFields | toString(node[field])] AS identityValues, count(node) AS recordCount
```

Case-insensitive runtime filters can be represented with `toLower(...)` and `toString(...)`:

```ts
contains(toLower(toString(variable("column"))), param("filterContains"));
```

Cypher output:

```cypher
toLower(toString(column)) CONTAINS $filterContains
```

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
| `neq(left, right)` | Checks inequality. | `u.status <> $p0` |
| `gt(left, right)` | Checks that `left` is greater than `right`. | `u.age > $p0` |
| `gte(left, right)` | Checks that `left` is greater than or equal to `right`. | `u.age >= $p0` |
| `lt(left, right)` | Checks that `left` is less than `right`. | `u.age < $p0` |
| `lte(left, right)` | Checks that `left` is less than or equal to `right`. | `u.age <= $p0` |
| `contains(left, right)` | Checks that a string contains another string. | `u.email CONTAINS $p0` |
| `inList(left, right)` | Checks that `left` is in a list expression. | `label IN $targetLabels` |
| `isNull(expression)` | Checks Cypher null state. | `u.email IS NULL` |
| `isNotNull(expression)` | Checks Cypher non-null state. | `u.email IS NOT NULL` |

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

List predicates are available through `anyInList(...)` and `allInList(...)`. Use `listItem(...)` to reference the item bound by the predicate:

```ts
query()
  .match(node("target"))
  .where(
    anyInList(
      "label",
      labels("target"),
      inList(listItem("label"), param("targetLabels")),
    ),
  );
```

Cypher output:

```cypher
MATCH (target)
WHERE any(label IN labels(target) WHERE label IN $targetLabels)
```

List, path, and map expression helpers cover common data-view projections:

```ts
query()
  .match(path("p", node("source"), "KNOWS", node("target")).hops(1, 3).via("rels"))
  .return(
    expr(listAt(labels("target"), 0), "targetType"),
    expr(type(last(aliasRef("rels"))), "relationshipType"),
    expr(length("p"), "depth"),
    expr(size(labels("target")), "labelCount"),
  );
```

For map-like values, use `mapProp(...)`:

```ts
mapProp(variable("value"), "nodeId");
```

Filtered list comprehensions are available through `filterList(...)`:

```ts
query()
  .with(
    expr(
      filterList(
        "value",
        variable("rawValues"),
        isNotNull(mapProp(listItem("value"), "nodeId")),
      ),
      "values",
    ),
  );
```

Cypher output:

```cypher
WITH [value IN rawValues WHERE value.nodeId IS NOT NULL] AS values
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

Return a scalar expression with an alias:

```ts
const user = node("u", "User");

query()
  .match(user)
  .return(expr(elementId(user), "id"));
```

Cypher output:

```cypher
MATCH (u:User)
RETURN elementId(u) AS id
```

Return a map/object projection:

```ts
const user = node("u", "User");

query()
  .match(user)
  .return(
    map("user", {
      id: elementId(user),
      email: user.prop("email"),
      source: "neo4j",
    }),
  );
```

Cypher output:

```cypher
MATCH (u:User)
RETURN { id: elementId(u), email: u.email, source: $p0 } AS user
```

`elementId(...)` accepts a node reference, an aliased edge reference, or an alias string. Edge references must be aliased before they can be passed to `elementId(...)`.

Use `labels(...)`, `type(...)`, `coalesce(...)`, and `inList(...)` for common data-view expressions:

```ts
const user = node("u", "User");
const post = node("p", "Post");
const wrote = edge(user, "WROTE", post).as("r");

query()
  .match(wrote)
  .where(inList(value("Author"), labels(user)))
  .return(
    expr(type(wrote), "relationshipType"),
    map("user", {
      id: elementId(user),
      labels: labels(user),
      displayName: coalesce(user.prop("name"), user.prop("email"), "Unknown"),
    }),
  );
```

Cypher output:

```cypher
MATCH (u:User)-[r:WROTE]->(p:Post)
WHERE $p0 IN labels(u)
RETURN type(r) AS relationshipType, { id: elementId(u), labels: labels(u), displayName: coalesce(u.name, u.email, $p1) } AS user
```

Use scalar conversion and math helpers in projections or `with(...)` stages:

```ts
query()
  .unwind(param("items"), "item")
  .with(expr(toFloat(row("item", "score")), "value"))
  .match(user)
  .return(
    expr(floor(variable("value")), "bucket"),
    expr(round(variable("value")), "rounded"),
    expr(toInteger(variable("value")), "integerValue"),
    expr(toString(user.prop("email")), "emailText"),
    expr(properties(user), "props"),
  );
```

Cypher output:

```cypher
UNWIND $items AS item
WITH toFloat(item.score) AS value
MATCH (u:User)
RETURN floor(value) AS bucket, round(value) AS rounded, toInteger(value) AS integerValue, toString(u.email) AS emailText, properties(u) AS props
```

Use arithmetic helpers and `caseWhen(...)` for searched CASE expressions:

```ts
const rawBucket = variable("rawBucket");
const bucketCount = param("bucketCount");

query()
  .unwind(param("items"), "item")
  .with(expr(toInteger(row("item", "bucket")), "rawBucket"))
  .return(
    expr(
      caseWhen(
        [
          { when: gte(rawBucket, bucketCount), then: sub(bucketCount, 1) },
          { when: lt(rawBucket, 0), then: 0 },
        ],
        rawBucket,
      ),
      "bucketIndex",
    ),
  );
```

Cypher output:

```cypher
UNWIND $items AS item
WITH toInteger(item.bucket) AS rawBucket
RETURN CASE WHEN rawBucket >= $bucketCount THEN ($bucketCount - $p0) WHEN rawBucket < $p1 THEN $p2 ELSE rawBucket END AS bucketIndex
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

You can also compile standalone expression and predicate fragments. This is useful when migrating a runtime filter system incrementally while keeping parameter handling in the DSL compiler:

```ts
import { compileExpression, compilePredicate, contains, param, toLower, toString, variable } from "graph-dsl";

compileExpression(toLower(toString(variable("column"))));
compilePredicate(contains(toLower(toString(variable("column"))), param("filterContains")));
```

Compiler result:

```ts
type CompilerOutput = {
  query: string;
  params: Record<
    string,
    | string
    | number
    | boolean
    | null
    | Record<string, string | number | boolean | null>
    | Array<string | number | boolean | null | Record<string, string | number | boolean | null>>
  >;
};
```

## Ladybug Compiler

`compileLadybugCypher(...)` emits the Ladybug-compatible subset of Cypher supported by this MVP. Ladybug is close to openCypher, so the emitted query text is usually the same as `compileCypher(...)`; the important difference is that the Ladybug compiler validates the AST against Ladybug's structured property graph model before emitting a query.

```ts
import { compileLadybugCypher, node, param, query, select } from "graph-dsl";

const user = node("u", "User").props({
  id: param("userId"),
});

const result = compileLadybugCypher(
  query()
    .match(user)
    .return(select(user, "id", "userId"))
    .toAst(),
  {
    params: {
      userId: "user-1",
    },
    terminateStatement: true,
  },
);

console.log(result.query);
// MATCH (u:User { id: $userId })
// RETURN u.id AS userId;
```

Use `terminateStatement: true` when you want a trailing semicolon for Ladybug CLI-style execution. Driver APIs commonly accept statements without the semicolon, so the default is `false`.

### Ladybug vs openCypher

Ladybug follows openCypher where possible, but it is not a drop-in openCypher runtime. The most important differences for this DSL are:

- Ladybug uses a structured property graph model: node and relationship tables must usually be declared before inserting data.
- A Ladybug node or relationship belongs to one table/label; Neo4j-style multi-label nodes are not part of the normal structured model.
- Node tables have primary keys, and relationship tables declare their allowed `FROM`/`TO` node table pairs.
- Variable-length relationships use walk semantics by default, so repeated relationships are allowed unless the query checks otherwise.
- Variable-length relationships need an upper bound for termination; if omitted, Ladybug applies its own default bound.
- Some Neo4j/openCypher clauses and functions are renamed or unsupported, such as `LOAD CSV` becoming Ladybug's broader `LOAD FROM`, no `FOREACH`, no `USE`, and `label()` instead of `labels()`.
- Ladybug's type system is closer to Postgres than Neo4j; list and map values are more strongly typed.
- Bulk loading is usually better expressed with Ladybug's native `COPY FROM`/scan flow than many small `CREATE` statements.

### Ladybug MVP Limitations

The Ladybug compiler is intentionally conservative. It validates the subset below and throws early for patterns that would be ambiguous or semantically different in Ladybug.

- Schemas are not generated yet. Define Ladybug node and relationship tables separately with `CREATE NODE TABLE` and `CREATE REL TABLE`.
- Node patterns may use at most one label. Ladybug's structured model treats labels as tables, while the generic DSL still allows Neo4j-style multi-label nodes.
- `CREATE` and `MERGE` node patterns must have an explicit node label. Relationship patterns must have an explicit relationship label.
- Variable-length traversals must be bounded with `.hops(min, max)`. Unbounded traversals such as `.hops(1)` are rejected because Ladybug uses walk semantics and requires an upper bound for predictable termination.
- Path semantics differ from Neo4j: Neo4j `MATCH` uses trail semantics for relationships, while Ladybug uses walk semantics by default. The compiler does not rewrite queries to force Neo4j-equivalent trail behavior.
- DDL, primary keys, relationship multiplicities, indexes, and constraints are outside this compiler. They should be managed by migration code or a future schema compiler.
- `REMOVE`, `FOREACH`, `CALL { ... }` subqueries, `USE`, `LOAD CSV`, and Ladybug-specific `LOAD FROM`/`COPY FROM` are not represented in the current AST and are not emitted.
- Bulk writes can use the existing `UNWIND` DSL shape, but large Ladybug imports should prefer Ladybug's native `COPY FROM` flow outside this MVP compiler.

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

`executeMemory(...)` mutates the graph for `create`, `createEdge`, `merge`, `mergeEdge`, `set`, `setProps`, and `delete` operations.

For traversal tests, `executeMemory(...)` supports bounded path patterns. Use `.hops(min, max)` with a finite `max`.

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
  | UnwindClause
  | MatchClause
  | CreateClause
  | MergeClause
  | CreateEdgeClause
  | MergeEdgeClause
  | WhereClause
  | ReturnClause
  | SetPropertyClause
  | OnCreateSetClause
  | OnMatchSetClause
  | DeleteClause;
```

Supported pattern kinds:

```ts
type Pattern =
  | NodePattern
  | EdgePattern
  | PathPattern;
```

Return selections can project aliases, properties, or aggregates:

```ts
type ReturnSelection =
  | AliasSelection
  | PropertySelection
  | AggregateSelection;
```

You can inspect it directly:

```ts
console.log(JSON.stringify(ast, null, 2));
```

## Current Limitations

- Gremlin compiler is not implemented yet.
- Runtime schemas currently support `string`, `number`, and `boolean` fields.
- Typed compile-time schema API is not implemented yet.
- Path/traversal patterns are read-only and can be used with `match(...)`; `create(...)` and `merge(...)` reject them.
- The memory executor requires `maxHops` for traversal patterns. Cypher compilation can emit unbounded traversals such as `*1..`.
- Ladybug Cypher compilation requires bounded traversal patterns and rejects multi-label node patterns.
- `set(...)`, `onCreateSet(...)`, and `onMatchSet(...)` update one property at a time; use `setProps(...)`, `onCreateSetProps(...)`, `onMatchSetProps(...)`, or `setMap(...)` for broader patches.
- The memory executor is intentionally small and not a full database; it is meant for tests, mocks, and semantic checks.
- Cypher support currently covers the portable MVP plus migration-focused primitives: `UNWIND`, `MATCH`, `OPTIONAL MATCH`, `WITH`, `CALL`, variable-length path traversal, `CREATE`, `MERGE`, merge-specific `ON CREATE SET`/`ON MATCH SET`, relationship-only `CREATE`/`MERGE` via `createEdge(...)`/`mergeEdge(...)`, `WHERE`, `RETURN` with aggregate projections, result controls, `SET`, map patch `SET +=`, `DELETE`, and `DETACH DELETE`.
- Batch helpers are driver-neutral and sequential by default; there is no built-in Neo4j session/transaction adapter yet.

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
