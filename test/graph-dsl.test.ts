import { describe, expect, it } from "vitest";
import {
  avg,
  collect,
  compileCypher,
  compileLadybugCypher,
  count,
  countAll,
  defineEdgeFromJson,
  defineNodeFromJson,
  edge,
  elementId,
  eq,
  expr,
  executeMemory,
  gte,
  map,
  max,
  min,
  node,
  neq,
  order,
  param,
  path,
  prop,
  query,
  row,
  runBatches,
  runParamBatches,
  select,
  chunk,
  sum,
  traverse,
  variable,
  type MemoryGraph,
} from "../src/index.js";

describe("graph-dsl", () => {
  it("builds a portable AST and compiles it to Cypher", () => {
    const user = node("u", "User");
    const post = node("p", "Post");

    const ast = query()
      .match(edge(user, "WROTE", post))
      .where(eq(prop(user, "email"), param("email")))
      .return(post, select(user, "email", "authorEmail"))
      .toAst();

    expect(ast).toMatchObject({
      kind: "query",
      clauses: [
        { kind: "match" },
        { kind: "where" },
        { kind: "return" },
      ],
    });

    expect(compileCypher(ast, { params: { email: "ada@example.com" } })).toEqual({
      query:
        "MATCH (u:User)-[:WROTE]->(p:Post)\nWHERE u.email = $email\nRETURN p, u.email AS authorEmail",
      params: {
        email: "ada@example.com",
      },
    });
  });

  it("compiles inequality predicates using Neo4j Cypher syntax", () => {
    const user = node("u", "User");

    const ast = query()
      .match(user)
      .where(neq(prop(user, "status"), "inactive"))
      .return(user)
      .toAst();

    expect(compileCypher(ast)).toEqual({
      query: "MATCH (u:User)\nWHERE u.status <> $p0\nRETURN u",
      params: {
        p0: "inactive",
      },
    });
  });

  it("compiles optional match clauses to Cypher", () => {
    const user = node("u", "User");
    const post = node("p", "Post");

    expect(
      compileCypher(
        query()
          .match(user)
          .optionalMatch(edge(user, "WROTE", post))
          .return(select(user, "email", "email"), select(post, "title", "title"))
          .toAst(),
      ),
    ).toEqual({
      query:
        "MATCH (u:User)\nOPTIONAL MATCH (u:User)-[:WROTE]->(p:Post)\nRETURN u.email AS email, p.title AS title",
      params: {},
    });
  });

  it("preserves rows without optional matches in the memory executor", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "user-1", labels: ["User"], properties: { email: "ada@example.com" } },
        { id: "user-2", labels: ["User"], properties: { email: "grace@example.com" } },
        { id: "post-1", labels: ["Post"], properties: { title: "Graph DSLs" } },
      ],
      edges: [
        { id: "edge-1", label: "WROTE", from: "user-1", to: "post-1", properties: {} },
      ],
    };
    const user = node("u", "User");
    const post = node("p", "Post");

    expect(
      executeMemory(
        query()
          .match(user)
          .optionalMatch(edge(user, "WROTE", post))
          .orderBy(user.prop("email"))
          .return(select(user, "email", "email"), select(post, "title", "title"))
          .toAst(),
        graph,
      ),
    ).toEqual([
      { email: "ada@example.com", title: "Graph DSLs" },
      { email: "grace@example.com", title: null },
    ]);
  });

  it("requires a non-optional match before optionalMatch", () => {
    expect(() =>
      query()
        .optionalMatch(edge(node("u", "User"), "WROTE", node("p", "Post")))
        .toAst(),
    ).toThrow("optionalMatch() requires a preceding match() clause to anchor the query.");
  });

  it("compiles order, skip, and limit result controls to Cypher", () => {
    const user = node("u", "User");

    expect(
      compileCypher(
        query()
          .match(user)
          .return(select(user, "name", "name"))
          .orderBy(order(user.prop("name"), "desc"))
          .skip(param("offset"))
          .limit(10)
          .toAst(),
        { params: { offset: 20 } },
      ),
    ).toEqual({
      query: "MATCH (u:User)\nRETURN u.name AS name\nORDER BY u.name DESC\nSKIP $offset\nLIMIT 10",
      params: {
        offset: 20,
      },
    });
  });

  it("compiles expression and map return projections to Cypher", () => {
    const user = node("u", "User");

    expect(
      compileCypher(
        query()
          .match(user)
          .return(
            expr(elementId(user), "id"),
            map("user", {
              id: elementId(user),
              email: user.prop("email"),
              source: "neo4j",
            }),
          )
          .toAst(),
      ),
    ).toEqual({
      query:
        "MATCH (u:User)\nRETURN elementId(u) AS id, { id: elementId(u), email: u.email, source: $p0 } AS user",
      params: {
        p0: "neo4j",
      },
    });
  });

  it("executes expression and map return projections against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "node-1", labels: ["User"], properties: { email: "ada@example.com" } },
      ],
      edges: [],
    };
    const user = node("u", "User");

    expect(
      executeMemory(
        query()
          .match(user)
          .return(
            expr(elementId(user), "id"),
            map("user", {
              id: elementId(user),
              email: user.prop("email"),
              active: true,
            }),
          )
          .toAst(),
        graph,
      ),
    ).toEqual([
      {
        id: "node-1",
        user: {
          id: "node-1",
          email: "ada@example.com",
          active: true,
        },
      },
    ]);
  });

  it("supports function expressions in distinct aggregates", () => {
    const user = node("u", "User");

    expect(
      compileCypher(
        query()
          .match(user)
          .return(count(elementId(user), "users", { distinct: true }))
          .toAst(),
      ),
    ).toEqual({
      query: "MATCH (u:User)\nRETURN count(DISTINCT elementId(u)) AS users",
      params: {},
    });
  });

  it("compiles with clauses for pipeline queries", () => {
    const user = node("u", "User");
    const post = node("p", "Post");

    expect(
      compileCypher(
        query()
          .match(user)
          .optionalMatch(edge(user, "WROTE", post))
          .with(user, count(post, "postCount"))
          .where(gte(variable("postCount"), 1))
          .return(select(user, "email", "email"), "postCount")
          .toAst(),
      ),
    ).toEqual({
      query:
        "MATCH (u:User)\nOPTIONAL MATCH (u:User)-[:WROTE]->(p:Post)\nWITH u, count(p) AS postCount\nWHERE postCount >= $p0\nRETURN u.email AS email, postCount",
      params: {
        p0: 1,
      },
    });
  });

  it("executes with clauses for aggregate pipeline queries", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "user-1", labels: ["User"], properties: { email: "ada@example.com" } },
        { id: "user-2", labels: ["User"], properties: { email: "grace@example.com" } },
        { id: "post-1", labels: ["Post"], properties: { title: "Graph DSLs" } },
        { id: "post-2", labels: ["Post"], properties: { title: "Compilers" } },
      ],
      edges: [
        { id: "edge-1", label: "WROTE", from: "user-1", to: "post-1", properties: {} },
        { id: "edge-2", label: "WROTE", from: "user-1", to: "post-2", properties: {} },
      ],
    };
    const user = node("u", "User");
    const post = node("p", "Post");

    expect(
      executeMemory(
        query()
          .match(user)
          .optionalMatch(edge(user, "WROTE", post))
          .with(user, count(post, "postCount"))
          .where(gte(variable("postCount"), 1))
          .return(select(user, "email", "email"), "postCount")
          .toAst(),
        graph,
      ),
    ).toEqual([{ email: "ada@example.com", postCount: 2 }]);
  });

  it("executes order, skip, and limit result controls against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "user-1", labels: ["User"], properties: { name: "Ada", score: 30 } },
        { id: "user-2", labels: ["User"], properties: { name: "Grace", score: 10 } },
        { id: "user-3", labels: ["User"], properties: { name: "Katherine", score: 20 } },
      ],
      edges: [],
    };
    const user = node("u", "User");

    expect(
      executeMemory(
        query()
          .match(user)
          .orderBy(order(user.prop("score"), "asc"))
          .skip(1)
          .limit(param("pageSize"))
          .return(select(user, "name", "name"))
          .toAst(),
        graph,
        { params: { pageSize: 1 } },
      ),
    ).toEqual([{ name: "Katherine" }]);
  });

  it("compiles the Ladybug Cypher MVP subset", () => {
    const user = node("u", "User").props({ id: param("userId") });
    const post = node("p", "Post").props({ id: param("postId") });

    expect(
      compileLadybugCypher(
        query()
          .match(user, post)
          .mergeEdge(edge(user, "WROTE", post).props({ role: "author" }))
          .return(select(user, "id", "userId"))
          .toAst(),
        {
          params: {
            userId: "user-1",
            postId: "post-1",
          },
          terminateStatement: true,
        },
      ),
    ).toEqual({
      query:
        "MATCH (u:User { id: $userId }), (p:Post { id: $postId })\nMERGE (u)-[:WROTE { role: $p0 }]->(p)\nRETURN u.id AS userId;",
      params: {
        userId: "user-1",
        postId: "post-1",
        p0: "author",
      },
    });
  });

  it("rejects Ladybug-incompatible MVP patterns", () => {
    expect(() =>
      compileLadybugCypher(query().match(node("u", "User", "Author")).toAst()),
    ).toThrow('Ladybug compiler MVP supports one node label per pattern; node "u" has 2.');

    expect(() => compileLadybugCypher(query().create(node("u")).toAst())).toThrow(
      "Ladybug compiler MVP requires an explicit node label for u in CREATE and MERGE patterns.",
    );

    expect(() =>
      compileLadybugCypher(
        query()
          .match(traverse(node("a", "User"), "FOLLOWS", node("b", "User")))
          .toAst(),
      ),
    ).toThrow('Ladybug compiler MVP requires bounded traversal patterns; "FOLLOWS" is missing maxHops.');
  });

  it("executes the same AST against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "user-1", labels: ["User"], properties: { email: "ada@example.com", name: "Ada" } },
        { id: "user-2", labels: ["User"], properties: { email: "grace@example.com", name: "Grace" } },
        { id: "post-1", labels: ["Post"], properties: { title: "Graph DSLs" } },
      ],
      edges: [
        { id: "edge-1", label: "WROTE", from: "user-1", to: "post-1", properties: {} },
      ],
    };

    const user = node("u", "User");
    const post = node("p", "Post");

    const ast = query()
      .match(edge(user, "WROTE", post))
      .where(eq(user.prop("email"), param("email")))
      .return(select(post, "title", "title"), select(user, "name", "author"))
      .toAst();

    expect(executeMemory(ast, graph, { params: { email: "ada@example.com" } })).toEqual([
      {
        title: "Graph DSLs",
        author: "Ada",
      },
    ]);
  });

  it("compiles create, update, and delete operations to Cypher", () => {
    const user = node("u", "User").props({
      email: param("email"),
      name: param("name"),
    });

    expect(
      compileCypher(
        query()
          .create(user)
          .return(select(user, "email", "email"))
          .toAst(),
        { params: { email: "ada@example.com", name: "Ada" } },
      ),
    ).toEqual({
      query: "CREATE (u:User { email: $email, name: $name })\nRETURN u.email AS email",
      params: {
        email: "ada@example.com",
        name: "Ada",
      },
    });

    expect(
      compileCypher(
        query()
          .match(node("u", "User"))
          .where(eq(prop("u", "email"), param("email")))
          .set(prop("u", "name"), "Ada Lovelace")
          .return(select("u", "name", "name"))
          .toAst(),
      ),
    ).toEqual({
      query:
        "MATCH (u:User)\nWHERE u.email = $email\nSET u.name = $p0\nRETURN u.name AS name",
      params: {
        p0: "Ada Lovelace",
      },
    });

    expect(
      compileCypher(
        query()
          .match(node("u", "User"))
          .where(eq(prop("u", "email"), param("email")))
          .delete("u")
          .toAst(),
        { params: { email: "ada@example.com" } },
      ),
    ).toEqual({
      query: "MATCH (u:User)\nWHERE u.email = $email\nDELETE u",
      params: {
        email: "ada@example.com",
      },
    });

    expect(
      compileCypher(
        query()
          .match(node("u", "User"))
          .where(eq(prop("u", "email"), param("email")))
          .detachDelete("u")
          .toAst(),
        { params: { email: "ada@example.com" } },
      ),
    ).toEqual({
      query: "MATCH (u:User)\nWHERE u.email = $email\nDETACH DELETE u",
      params: {
        email: "ada@example.com",
      },
    });
  });

  it("executes create, update, and delete operations against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [],
      edges: [],
    };

    const user = node("u", "User").props({
      email: param("email"),
      name: "Ada",
    });

    expect(
      executeMemory(
        query()
          .create(user)
          .return(select(user, "email", "email"), select(user, "name", "name"))
          .toAst(),
        graph,
        { params: { email: "ada@example.com" } },
      ),
    ).toEqual([
      {
        email: "ada@example.com",
        name: "Ada",
      },
    ]);
    expect(graph.nodes).toHaveLength(1);

    const matchedUser = node("u", "User");

    expect(
      executeMemory(
        query()
          .match(matchedUser)
          .where(eq(matchedUser.prop("email"), param("email")))
          .set(matchedUser.prop("name"), "Ada Lovelace")
          .return(select(matchedUser, "name", "name"))
          .toAst(),
        graph,
        { params: { email: "ada@example.com" } },
      ),
    ).toEqual([
      {
        name: "Ada Lovelace",
      },
    ]);

    expect(
      executeMemory(
        query()
          .match(matchedUser)
          .where(eq(matchedUser.prop("email"), param("email")))
          .detachDelete(matchedUser)
          .toAst(),
        graph,
        { params: { email: "ada@example.com" } },
      ),
    ).toHaveLength(1);
    expect(graph.nodes).toHaveLength(0);
  });

  it("distinguishes delete from detachDelete when relationships exist", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "user-1", labels: ["User"], properties: { email: "ada@example.com" } },
        { id: "post-1", labels: ["Post"], properties: { title: "Graph DSLs" } },
      ],
      edges: [
        { id: "edge-1", label: "WROTE", from: "user-1", to: "post-1", properties: {} },
      ],
    };

    const user = node("u", "User");

    expect(() =>
      executeMemory(
        query().match(user).where(eq(user.prop("email"), param("email"))).delete(user).toAst(),
        graph,
        { params: { email: "ada@example.com" } },
      ),
    ).toThrow("Use detachDelete(...) instead.");

    expect(
      executeMemory(
        query()
          .match(user)
          .where(eq(user.prop("email"), param("email")))
          .detachDelete(user)
          .toAst(),
        graph,
        { params: { email: "ada@example.com" } },
      ),
    ).toHaveLength(1);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it("compiles merge operations to Cypher", () => {
    const user = node("u", "User").props({ id: param("userId") });
    const post = node("p", "Post").props({ id: param("postId") });

    expect(
      compileCypher(
        query()
          .scope({ tenantId: param("tenantId") })
          .merge(user)
          .merge(post)
          .mergeEdge(edge(user, "WROTE", post).props({ role: "author" }))
          .toAst(),
      ),
    ).toEqual({
      query:
        "MERGE (u:User { id: $userId, tenantId: $tenantId })\nMERGE (p:Post { id: $postId, tenantId: $tenantId })\nMERGE (u)-[:WROTE { role: $p0, tenantId: $tenantId }]->(p)",
      params: {
        p0: "author",
      },
    });
  });

  it("executes merge operations against a memory graph without duplicating matches", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "node-1", labels: ["User"], properties: { id: "user-1", tenantId: "tenant-1" } },
      ],
      edges: [],
    };

    const user = node("u", "User").props({ id: param("userId") });
    const post = node("p", "Post").props({ id: param("postId") });
    const ast = query()
      .scope({ tenantId: param("tenantId") })
      .merge(user)
      .merge(post)
      .mergeEdge(edge(user, "WROTE", post).props({ role: "author" }))
      .toAst();

    expect(
      executeMemory(ast, graph, {
        params: {
          tenantId: "tenant-1",
          userId: "user-1",
          postId: "post-1",
        },
      }),
    ).toHaveLength(1);
    expect(
      executeMemory(ast, graph, {
        params: {
          tenantId: "tenant-1",
          userId: "user-1",
          postId: "post-1",
        },
      }),
    ).toHaveLength(1);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      label: "WROTE",
      from: "node-1",
      properties: { role: "author", tenantId: "tenant-1" },
    });
  });

  it("compiles merge on-create and on-match sets with runtime schema identity helpers", () => {
    const Person = defineNodeFromJson({
      kind: "node",
      label: "Person",
      fields: {
        id: { type: "string", required: true },
        name: { type: "string" },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
    });
    const form = {
      id: "person-1",
      name: "Ada",
      createdAt: "2026-07-01",
      updatedAt: "2026-07-01",
    };
    const identity = Person.identity("p", form, ["id"]);
    const createPatch = Person.patch("p", {
      name: form.name,
      createdAt: form.createdAt,
    });
    const matchPatch = Person.patch("p", {
      name: form.name,
      updatedAt: form.updatedAt,
    });

    expect(
      compileCypher(
        query()
          .merge(identity.node)
          .onCreateSetProps(createPatch)
          .onMatchSetProps(matchPatch)
          .toAst(),
        {
          params: {
            ...identity.params,
            ...createPatch.params,
            ...matchPatch.params,
          },
        },
      ),
    ).toEqual({
      query:
        "MERGE (p:Person { id: $p_id })\nON CREATE SET p.name = $p_name\nON CREATE SET p.createdAt = $p_createdAt\nON MATCH SET p.name = $p_name\nON MATCH SET p.updatedAt = $p_updatedAt",
      params: {
        p_id: "person-1",
        p_name: "Ada",
        p_createdAt: "2026-07-01",
        p_updatedAt: "2026-07-01",
      },
    });
  });

  it("executes merge on-create and on-match sets against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [],
      edges: [],
    };
    const ast = query()
      .merge(node("p", "Person").props({ id: param("id") }))
      .onCreateSet(prop("p", "createdAt"), param("now"))
      .onMatchSet(prop("p", "updatedAt"), param("now"))
      .return(select("p", "createdAt", "createdAt"), select("p", "updatedAt", "updatedAt"))
      .toAst();

    expect(
      executeMemory(ast, graph, {
        params: { id: "person-1", now: "2026-07-01T09:00:00Z" },
      }),
    ).toEqual([{ createdAt: "2026-07-01T09:00:00Z", updatedAt: null }]);
    expect(
      executeMemory(ast, graph, {
        params: { id: "person-1", now: "2026-07-01T10:00:00Z" },
      }),
    ).toEqual([{ createdAt: "2026-07-01T09:00:00Z", updatedAt: "2026-07-01T10:00:00Z" }]);
    expect(graph.nodes).toHaveLength(1);
  });

  it("throws when on-create or on-match set is not attached to a merge", () => {
    expect(() => query().onCreateSet(prop("p", "createdAt"), param("now"))).toThrow(
      "onCreateSet() must be called immediately after merge(), mergeEdge(), or another merge set clause.",
    );
    expect(() => query().match(node("p", "Person")).onMatchSet(prop("p", "updatedAt"), param("now"))).toThrow(
      "onMatchSet() must be called immediately after merge(), mergeEdge(), or another merge set clause.",
    );
  });

  it("compiles path and traversal patterns to Cypher", () => {
    const source = node("source", "Person").props({ id: param("sourceId") });
    const target = node("target", "Person").props({ id: param("targetId") });

    expect(
      compileCypher(
        query()
          .match(path("p", source, "KNOWS", target).hops(1, 3))
          .return("p")
          .toAst(),
      ),
    ).toEqual({
      query:
        "MATCH p = (source:Person { id: $sourceId })-[:KNOWS*1..3]->(target:Person { id: $targetId })\nRETURN p",
      params: {},
    });

    expect(
      compileCypher(
        query()
          .match(traverse(source, "KNOWS", target, "both").hops(2, 2).via("rels").props({ active: true }))
          .toAst(),
      ),
    ).toEqual({
      query:
        "MATCH (source:Person { id: $sourceId })-[rels:KNOWS*2 { active: $p0 }]-(target:Person { id: $targetId })",
      params: {
        p0: true,
      },
    });
  });

  it("executes bounded traversal patterns against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "node-1", labels: ["Person"], properties: { id: "ada", name: "Ada" } },
        { id: "node-2", labels: ["Person"], properties: { id: "grace", name: "Grace" } },
        { id: "node-3", labels: ["Person"], properties: { id: "katherine", name: "Katherine" } },
      ],
      edges: [
        { id: "edge-1", label: "KNOWS", from: "node-1", to: "node-2", properties: { active: true } },
        { id: "edge-2", label: "KNOWS", from: "node-2", to: "node-3", properties: { active: true } },
      ],
    };
    const source = node("source", "Person").props({ id: param("sourceId") });
    const target = node("target", "Person").props({ id: param("targetId") });
    const ast = query()
      .match(path("p", source, "KNOWS", target).hops(1, 2).props({ active: true }))
      .return("p", select(target, "name", "targetName"))
      .toAst();

    const result = executeMemory(ast, graph, {
      params: {
        sourceId: "ada",
        targetId: "katherine",
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.targetName).toBe("Katherine");
    expect(result[0]?.p).toMatchObject({
      nodes: [{ id: "node-1" }, { id: "node-2" }, { id: "node-3" }],
      edges: [{ id: "edge-1" }, { id: "edge-2" }],
    });
  });

  it("requires bounded traversal patterns in the memory executor", () => {
    expect(() =>
      executeMemory(
        query()
          .match(traverse(node("a"), "KNOWS", node("b")))
          .toAst(),
        { nodes: [], edges: [] },
      ),
    ).toThrow("executeMemory() requires maxHops for traversal patterns.");
  });

  it("applies scoped properties to traversal edges", () => {
    const source = node("source", "Person");
    const target = node("target", "Person");

    expect(
      compileCypher(
        query()
          .scope({ tenantId: param("tenantId") })
          .match(traverse(source, "KNOWS", target).hops(1, 2))
          .toAst(),
      ),
    ).toEqual({
      query:
        "MATCH (source:Person { tenantId: $tenantId })-[:KNOWS*1..2 { tenantId: $tenantId }]->(target:Person { tenantId: $tenantId })",
      params: {},
    });
  });

  it("guards every node and edge when returning a scoped path", () => {
    const source = node("source", "Person");
    const target = node("target", "Person");

    expect(
      compileCypher(
        query()
          .scope({ tenantId: param("tenantId") })
          .match(path("p", source, "KNOWS", target).hops(1, 2))
          .return("p")
          .toAst(),
      ),
    ).toEqual({
      query:
        "MATCH p = (source:Person { tenantId: $tenantId })-[:KNOWS*1..2 { tenantId: $tenantId }]->(target:Person { tenantId: $tenantId })\nWHERE all(n IN nodes(p) WHERE n.tenantId = $tenantId) AND all(r IN relationships(p) WHERE r.tenantId = $tenantId)\nWITH *\nRETURN p",
      params: {},
    });
  });

  it("excludes scoped memory paths with out-of-scope intermediate nodes", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "node-1", labels: ["Person"], properties: { tenantId: "tenant-1", id: "source" } },
        { id: "node-2", labels: ["Person"], properties: { tenantId: "tenant-2", id: "middle" } },
        { id: "node-3", labels: ["Person"], properties: { tenantId: "tenant-1", id: "target" } },
      ],
      edges: [
        { id: "edge-1", label: "KNOWS", from: "node-1", to: "node-2", properties: { tenantId: "tenant-1" } },
        { id: "edge-2", label: "KNOWS", from: "node-2", to: "node-3", properties: { tenantId: "tenant-1" } },
      ],
    };
    const source = node("source", "Person").props({ id: "source" });
    const target = node("target", "Person").props({ id: "target" });

    expect(
      executeMemory(
        query()
          .scope({ tenantId: param("tenantId") })
          .match(path("p", source, "KNOWS", target).hops(2, 2))
          .return("p")
          .toAst(),
        graph,
        { params: { tenantId: "tenant-1" } },
      ),
    ).toEqual([]);
  });

  it("compiles aggregate return selections to Cypher", () => {
    const user = node("u", "User");
    const post = node("p", "Post");

    expect(
      compileCypher(
        query()
          .match(edge(user, "WROTE", post))
          .return(
            select(user, "role", "role"),
            countAll("rows"),
            count(post, "postCount"),
            collect(prop(post, "title"), "titles", { distinct: true }),
          )
          .toAst(),
      ),
    ).toEqual({
      query:
        "MATCH (u:User)-[:WROTE]->(p:Post)\nRETURN u.role AS role, count(*) AS rows, count(p) AS postCount, collect(DISTINCT p.title) AS titles",
      params: {},
    });
  });

  it("executes aggregate return selections against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "user-1", labels: ["User"], properties: { role: "admin", score: 10 } },
        { id: "user-2", labels: ["User"], properties: { role: "admin", score: 20 } },
        { id: "user-3", labels: ["User"], properties: { role: "reader", score: 5 } },
      ],
      edges: [],
    };
    const user = node("u", "User");

    expect(
      executeMemory(
        query()
          .match(user)
          .return(
            select(user, "role", "role"),
            count(user, "users"),
            sum(prop(user, "score"), "totalScore"),
            avg(prop(user, "score"), "avgScore"),
            min(prop(user, "score"), "minScore"),
            max(prop(user, "score"), "maxScore"),
            collect(prop(user, "score"), "scores"),
          )
          .toAst(),
        graph,
      ),
    ).toEqual([
      {
        role: "admin",
        users: 2,
        totalScore: 30,
        avgScore: 15,
        minScore: 10,
        maxScore: 20,
        scores: [10, 20],
      },
      {
        role: "reader",
        users: 1,
        totalScore: 5,
        avgScore: 5,
        minScore: 5,
        maxScore: 5,
        scores: [5],
      },
    ]);
  });

  it("executes distinct aggregates against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "node-1", labels: ["User"], properties: { role: "admin" } },
        { id: "node-2", labels: ["User"], properties: { role: "admin" } },
        { id: "node-3", labels: ["User"], properties: { role: "reader" } },
      ],
      edges: [],
    };

    expect(
      executeMemory(
        query()
          .match(node("u", "User"))
          .return(count(prop("u", "role"), "roles", { distinct: true }), collect(prop("u", "role"), "roleList", { distinct: true }))
          .toAst(),
        graph,
      ),
    ).toEqual([
      {
        roles: 2,
        roleList: ["admin", "reader"],
      },
    ]);
  });

  it("applies scoped properties to every matched and created node and edge", () => {
    const user = node("u", "User");
    const post = node("p", "Post").props({
      title: param("title"),
    });

    const ast = query()
      .scope({
        tenantId: param("tenantId"),
        workspaceId: param("workspaceId"),
      })
      .match(edge(user, "WROTE", post))
      .create(node("comment", "Comment").props({ body: "Nice" }))
      .return(post, select("comment", "body", "commentBody"))
      .toAst();

    expect(compileCypher(ast)).toEqual({
      query:
        "MATCH (u:User { tenantId: $tenantId, workspaceId: $workspaceId })-[:WROTE { tenantId: $tenantId, workspaceId: $workspaceId }]->(p:Post { title: $title, tenantId: $tenantId, workspaceId: $workspaceId })\nCREATE (comment:Comment { body: $p0, tenantId: $tenantId, workspaceId: $workspaceId })\nRETURN p, comment.body AS commentBody",
      params: {
        p0: "Nice",
      },
    });
  });

  it("uses scoped properties when executing against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [
        {
          id: "user-1",
          labels: ["User"],
          properties: { tenantId: "tenant-1", workspaceId: "workspace-1", email: "ada@example.com" },
        },
        {
          id: "user-2",
          labels: ["User"],
          properties: { tenantId: "tenant-2", workspaceId: "workspace-1", email: "ada@example.com" },
        },
      ],
      edges: [],
    };

    const ast = query()
      .scope({
        tenantId: param("tenantId"),
        workspaceId: param("workspaceId"),
      })
      .match(node("u", "User"))
      .where(eq(prop("u", "email"), param("email")))
      .return(select("u", "tenantId", "tenantId"))
      .toAst();

    expect(
      executeMemory(ast, graph, {
        params: {
          email: "ada@example.com",
          tenantId: "tenant-1",
          workspaceId: "workspace-1",
        },
      }),
    ).toEqual([
      {
        tenantId: "tenant-1",
      },
    ]);
  });

  it("throws when a node explicitly defines a scoped property", () => {
    expect(() =>
      query()
        .scope({ tenantId: param("tenantId") })
        .match(node("u", "User").props({ tenantId: param("otherTenantId") }))
        .toAst(),
    ).toThrow('Node "u" already defines scoped properties: tenantId.');
  });

  it("throws when an edge explicitly defines a scoped property", () => {
    expect(() =>
      query()
        .scope({ tenantId: param("tenantId") })
        .match(edge(node("u", "User"), "WROTE", node("p", "Post")).props({ tenantId: param("otherTenantId") }))
        .toAst(),
    ).toThrow('Edge "WROTE" already defines scoped properties: tenantId.');
  });

  it("compiles bulk node creation from an unwound parameter", () => {
    const user = node("u", "User").props({
      id: row("item", "id"),
      email: row("item", "email"),
      name: row("item", "name"),
    });

    const ast = query()
      .scope({ tenantId: param("tenantId") })
      .unwind(param("users"), "item")
      .create(user)
      .toAst();

    expect(
      compileCypher(ast, {
        params: {
          tenantId: "tenant-1",
          users: [
            { id: "user-1", email: "ada@example.com", name: "Ada" },
            { id: "user-2", email: "grace@example.com", name: "Grace" },
          ],
        },
      }),
    ).toEqual({
      query:
        "UNWIND $users AS item\nCREATE (u:User { id: item.id, email: item.email, name: item.name, tenantId: $tenantId })",
      params: {
        tenantId: "tenant-1",
        users: [
          { id: "user-1", email: "ada@example.com", name: "Ada" },
          { id: "user-2", email: "grace@example.com", name: "Grace" },
        ],
      },
    });
  });

  it("executes bulk node creation from an unwound parameter against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [],
      edges: [],
    };

    const ast = query()
      .scope({ tenantId: param("tenantId") })
      .unwind(param("users"), "item")
      .create(
        node("u", "User").props({
          id: row("item", "id"),
          email: row("item", "email"),
        }),
      )
      .return(select("u", "email", "email"))
      .toAst();

    expect(
      executeMemory(ast, graph, {
        params: {
          tenantId: "tenant-1",
          users: [
            { id: "user-1", email: "ada@example.com" },
            { id: "user-2", email: "grace@example.com" },
          ],
        },
      }),
    ).toEqual([{ email: "ada@example.com" }, { email: "grace@example.com" }]);
    expect(graph.nodes).toMatchObject([
      { labels: ["User"], properties: { id: "user-1", email: "ada@example.com", tenantId: "tenant-1" } },
      { labels: ["User"], properties: { id: "user-2", email: "grace@example.com", tenantId: "tenant-1" } },
    ]);
  });

  it("compiles bulk edge creation from an unwound parameter", () => {
    const user = node("u", "User").props({ id: row("item", "userId") });
    const post = node("p", "Post").props({ id: row("item", "postId") });

    const ast = query()
      .scope({ tenantId: param("tenantId") })
      .unwind(param("writes"), "item")
      .match(user, post)
      .createEdge(edge(user, "WROTE", post).props({ createdAt: row("item", "createdAt") }))
      .toAst();

    expect(compileCypher(ast)).toEqual({
      query:
        "UNWIND $writes AS item\nMATCH (u:User { id: item.userId, tenantId: $tenantId }), (p:Post { id: item.postId, tenantId: $tenantId })\nCREATE (u)-[:WROTE { createdAt: item.createdAt, tenantId: $tenantId }]->(p)",
      params: {},
    });
  });

  it("executes bulk edge creation from an unwound parameter against a memory graph", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "node-1", labels: ["User"], properties: { id: "user-1", tenantId: "tenant-1" } },
        { id: "node-2", labels: ["Post"], properties: { id: "post-1", tenantId: "tenant-1" } },
      ],
      edges: [],
    };

    const user = node("u", "User").props({ id: row("item", "userId") });
    const post = node("p", "Post").props({ id: row("item", "postId") });

    expect(
      executeMemory(
        query()
          .scope({ tenantId: param("tenantId") })
          .unwind(param("writes"), "item")
          .match(user, post)
          .createEdge(edge(user, "WROTE", post).props({ createdAt: row("item", "createdAt") }))
          .toAst(),
        graph,
        {
          params: {
            tenantId: "tenant-1",
            writes: [{ userId: "user-1", postId: "post-1", createdAt: "2026-06-30" }],
          },
        },
      ),
    ).toHaveLength(1);
    expect(graph.edges).toEqual([
      {
        id: "edge-1",
        label: "WROTE",
        from: "node-1",
        to: "node-2",
        properties: { createdAt: "2026-06-30", tenantId: "tenant-1" },
      },
    ]);
  });

  it("maps a runtime JSON node schema and form object to a DSL node with params", () => {
    const Person = defineNodeFromJson({
      kind: "node",
      label: "Person",
      fields: {
        id: { type: "string", required: true },
        name: { type: "string", required: true },
        age: { type: "number" },
        active: { type: "boolean" },
      },
    });

    const mapped = Person.from("p", {
      id: "person-1",
      name: "Ada",
      age: 36,
      active: true,
    });

    expect(
      compileCypher(query().create(mapped.node).toAst(), {
        params: mapped.params,
      }),
    ).toEqual({
      query: "CREATE (p:Person { id: $p_id, name: $p_name, age: $p_age, active: $p_active })",
      params: {
        p_id: "person-1",
        p_name: "Ada",
        p_age: 36,
        p_active: true,
      },
    });
  });

  it("supports stripping unknown fields when mapping runtime schema input", () => {
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

    const mapped = Car.from("c", {
      id: "car-1",
      model: "Roadster",
      ignored: "field",
    });

    expect(mapped.params).toEqual({
      c_id: "car-1",
      c_model: "Roadster",
    });
  });

  it("throws for unknown, missing, and invalid runtime schema fields", () => {
    const Person = defineNodeFromJson({
      kind: "node",
      label: "Person",
      fields: {
        id: { type: "string", required: true },
        age: { type: "number" },
      },
    });

    expect(() => Person.from("p", { id: "person-1", role: "admin" })).toThrow(
      'Unknown fields for "Person": role.',
    );
    expect(() => Person.from("p", { age: 36 })).toThrow(
      'Missing required field "id" for "Person".',
    );
    expect(() => Person.from("p", { id: "person-1", age: "36" })).toThrow(
      'Invalid field "age" for "Person": expected number.',
    );
  });

  it("maps a runtime JSON edge schema and form object to a DSL edge with params", () => {
    const Wrote = defineEdgeFromJson({
      kind: "edge",
      label: "WROTE",
      fields: {
        role: { type: "string", required: true },
        createdAt: { type: "string", required: true },
        featured: { type: "boolean" },
      },
    });

    const person = node("p", "Person").props({ id: param("personId") });
    const post = node("post", "Post").props({ id: param("postId") });
    const mapped = Wrote.from(
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
      .createEdge(mapped.edge)
      .toAst();

    expect(
      compileCypher(ast, {
        params: {
          personId: "person-1",
          postId: "post-1",
          ...mapped.params,
        },
      }),
    ).toEqual({
      query:
        "MATCH (p:Person { id: $personId }), (post:Post { id: $postId })\nCREATE (p)-[:WROTE { role: $wrote_role, createdAt: $wrote_createdAt, featured: $wrote_featured }]->(post)",
      params: {
        personId: "person-1",
        postId: "post-1",
        wrote_role: "author",
        wrote_createdAt: "2026-06-30",
        wrote_featured: true,
      },
    });
  });

  it("throws for invalid runtime edge schema fields", () => {
    const Owns = defineEdgeFromJson({
      kind: "edge",
      label: "OWNS",
      fields: {
        since: { type: "number", required: true },
      },
    });

    expect(() => Owns.from(node("p"), node("c"), { since: "2020" })).toThrow(
      'Invalid field "since" for "OWNS": expected number.',
    );
  });

  it("maps runtime node schema patches to set clauses", () => {
    const Person = defineNodeFromJson({
      kind: "node",
      label: "Person",
      fields: {
        id: { type: "string", required: true },
        name: { type: "string", required: true },
        age: { type: "number" },
      },
    });

    const patch = Person.patch("p", {
      name: "Ada Lovelace",
      age: 37,
    });

    expect(
      compileCypher(
        query()
          .match(node("p", "Person").props({ id: param("personId") }))
          .setProps(patch)
          .toAst(),
        {
          params: {
            personId: "person-1",
            ...patch.params,
          },
        },
      ),
    ).toEqual({
      query:
        "MATCH (p:Person { id: $personId })\nSET p.name = $p_name\nSET p.age = $p_age",
      params: {
        personId: "person-1",
        p_name: "Ada Lovelace",
        p_age: 37,
      },
    });
  });

  it("executes runtime node schema patches against a memory graph", () => {
    const Person = defineNodeFromJson({
      kind: "node",
      label: "Person",
      fields: {
        id: { type: "string", required: true },
        name: { type: "string", required: true },
      },
    });
    const graph: MemoryGraph = {
      nodes: [
        { id: "node-1", labels: ["Person"], properties: { id: "person-1", name: "Ada" } },
      ],
      edges: [],
    };
    const patch = Person.patch("p", {
      name: "Ada Lovelace",
    });

    expect(
      executeMemory(
        query()
          .match(node("p", "Person").props({ id: param("personId") }))
          .setProps(patch)
          .return(select("p", "name", "name"))
          .toAst(),
        graph,
        {
          params: {
            personId: "person-1",
            ...patch.params,
          },
        },
      ),
    ).toEqual([{ name: "Ada Lovelace" }]);
  });

  it("maps runtime edge schema patches to set clauses", () => {
    const Wrote = defineEdgeFromJson({
      kind: "edge",
      label: "WROTE",
      fields: {
        role: { type: "string", required: true },
        featured: { type: "boolean" },
      },
    });

    const patch = Wrote.patch("r", {
      featured: true,
    });

    expect(
      compileCypher(
        query()
          .match(edge(node("p", "Person"), "WROTE", node("post", "Post")).as("r"))
          .setProps(patch)
          .toAst(),
        { params: patch.params },
      ),
    ).toEqual({
      query: "MATCH (p:Person)-[r:WROTE]->(post:Post)\nSET r.featured = $r_featured",
      params: {
        r_featured: true,
      },
    });
  });

  it("validates runtime schema patch fields without requiring required fields", () => {
    const Person = defineNodeFromJson({
      kind: "node",
      label: "Person",
      fields: {
        id: { type: "string", required: true },
        age: { type: "number" },
      },
    });

    expect(Person.patch("p", { age: 37 }).params).toEqual({
      p_age: 37,
    });
    expect(() => Person.patch("p", { id: "person-1", unknown: true })).toThrow(
      'Unknown fields for "Person": unknown.',
    );
    expect(() => Person.patch("p", { age: "37" })).toThrow(
      'Invalid field "age" for "Person": expected number.',
    );
  });

  it("chunks synchronous iterables without materializing more than a batch", () => {
    expect([...chunk([1, 2, 3, 4, 5], { batchSize: 2 })]).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => [...chunk([1], { batchSize: 0 })]).toThrow("batchSize must be a positive integer.");
  });

  it("runs batches sequentially with metadata", async () => {
    const seen: Array<{ batch: number[]; index: number; offset: number; totalItems?: number; totalBatches?: number }> = [];

    const results = await runBatches([1, 2, 3, 4, 5], {
      batchSize: 2,
      onBatch: (batch, meta) => {
        seen.push({
          batch,
          index: meta.index,
          offset: meta.offset,
          ...(meta.totalItems === undefined ? {} : { totalItems: meta.totalItems }),
          ...(meta.totalBatches === undefined ? {} : { totalBatches: meta.totalBatches }),
        });

        return batch.reduce((sum, value) => sum + value, 0);
      },
    });

    expect(results).toEqual([3, 7, 5]);
    expect(seen).toEqual([
      { batch: [1, 2], index: 0, offset: 0, totalItems: 5, totalBatches: 3 },
      { batch: [3, 4], index: 1, offset: 2, totalItems: 5, totalBatches: 3 },
      { batch: [5], index: 2, offset: 4, totalItems: 5, totalBatches: 3 },
    ]);
  });

  it("runs batches from async iterables without known totals", async () => {
    async function* source() {
      yield 1;
      yield 2;
      yield 3;
    }

    const metadata = await runBatches(source(), {
      batchSize: 2,
      onBatch: (_batch, meta) => meta,
    });

    expect(metadata).toEqual([
      { index: 0, offset: 0, size: 2 },
      { index: 1, offset: 2, size: 1 },
    ]);
  });

  it("runs parameter batches for unwind queries", async () => {
    const graph: MemoryGraph = {
      nodes: [],
      edges: [],
    };
    const ast = query()
      .scope({ tenantId: param("tenantId") })
      .unwind(param("users"), "item")
      .create(
        node("u", "User").props({
          id: row("item", "id"),
          email: row("item", "email"),
        }),
      )
      .toAst();

    const results = await runParamBatches({
      items: [
        { id: "user-1", email: "ada@example.com" },
        { id: "user-2", email: "grace@example.com" },
        { id: "user-3", email: "katherine@example.com" },
      ],
      batchParam: "users",
      batchSize: 2,
      params: {
        tenantId: "tenant-1",
      },
      onBatch: (params) => executeMemory(ast, graph, { params }).length,
    });

    expect(results).toEqual([2, 1]);
    expect(graph.nodes).toMatchObject([
      { properties: { id: "user-1", email: "ada@example.com", tenantId: "tenant-1" } },
      { properties: { id: "user-2", email: "grace@example.com", tenantId: "tenant-1" } },
      { properties: { id: "user-3", email: "katherine@example.com", tenantId: "tenant-1" } },
    ]);
  });
});
