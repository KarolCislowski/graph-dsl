import { describe, expect, it } from "vitest";
import {
  compileCypher,
  edge,
  eq,
  executeMemory,
  node,
  param,
  prop,
  query,
  row,
  select,
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
          .delete(matchedUser)
          .toAst(),
        graph,
        { params: { email: "ada@example.com" } },
      ),
    ).toHaveLength(1);
    expect(graph.nodes).toHaveLength(0);
  });

  it("applies scoped properties to every matched and created node", () => {
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
        "MATCH (u:User { tenantId: $tenantId, workspaceId: $workspaceId })-[:WROTE]->(p:Post { title: $title, tenantId: $tenantId, workspaceId: $workspaceId })\nCREATE (comment:Comment { body: $p0, tenantId: $tenantId, workspaceId: $workspaceId })\nRETURN p, comment.body AS commentBody",
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
        "UNWIND $writes AS item\nMATCH (u:User { id: item.userId, tenantId: $tenantId }), (p:Post { id: item.postId, tenantId: $tenantId })\nCREATE (u)-[:WROTE { createdAt: item.createdAt }]->(p)",
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
        properties: { createdAt: "2026-06-30" },
      },
    ]);
  });
});
