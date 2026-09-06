import type {
  QueryAst,
  ReturnSelection,
  ValueExpression,
} from "../ast.js";
import {
  evaluateList,
  evaluatePredicate,
  evaluateResultCount,
} from "./evaluate.js";
import {
  createEdges,
  createPatterns,
  deleteAliases,
  matchPatterns,
  mergeEdges,
  mergePatterns,
  optionalMatchPatterns,
  setProperty,
} from "./patterns.js";
import {
  orderBindings,
  projectAggregatedRows,
  projectRow,
  projectWithBindings,
  rowToBinding,
  selectionsContainAggregate,
} from "./projections.js";
import type {
  Binding,
  MemoryContext,
  MemoryExecuteOptions,
  MemoryGraph,
  MemoryRow,
  MemoryValue,
} from "./types.js";
import { mergeCreatedState } from "./types.js";

/**
 * Executes a query AST against a mutable in-memory graph.
 *
 * `match`, `where`, and `return` read from the graph. `create`, `set`, and
 * `delete` mutate the provided graph object.
 *
 * @param ast - Query AST produced by the DSL.
 * @param graph - Mutable in-memory graph to execute against.
 * @param options - Optional runtime parameters.
 * @returns Projected rows when the query has a return clause, otherwise the current bindings.
 */
export function executeMemory(
  ast: QueryAst,
  graph: MemoryGraph,
  options: MemoryExecuteOptions = {},
): MemoryRow[] {
  const context: MemoryContext = {
    params: options.params ?? {},
  };

  const execution = executeClauses(ast, graph, context, [{}]);

  if (!execution.selections) {
    return execution.bindings;
  }

  if (selectionsContainAggregate(execution.selections)) {
    return projectAggregatedRows(execution.bindings, execution.selections, context);
  }

  return execution.bindings.map((binding) => projectRow(binding, execution.selections!, context));
}

function unwindBindings(
  bindings: Binding[],
  source: ValueExpression,
  alias: string,
  context: MemoryContext,
): Binding[] {
  return bindings.flatMap((binding) =>
    evaluateList(source, binding, context).map((item) => ({
      ...binding,
      [alias]: item,
    })),
  );
}

function executeMemoryFromBindings(
  ast: QueryAst,
  graph: MemoryGraph,
  context: MemoryContext,
  initialBindings: Binding[],
): Binding[] {
  const execution = executeClauses(ast, graph, context, initialBindings);

  if (!execution.selections) {
    return execution.bindings;
  }

  return selectionsContainAggregate(execution.selections)
    ? projectAggregatedRows(execution.bindings, execution.selections, context).map(rowToBinding)
    : execution.bindings.map((binding) => rowToBinding(projectRow(binding, execution.selections!, context)));
}

function executeClauses(
  ast: QueryAst,
  graph: MemoryGraph,
  context: MemoryContext,
  initialBindings: Binding[],
): { bindings: Binding[]; selections?: ReturnSelection[] } {
  let bindings = initialBindings;
  let selections: ReturnSelection[] | undefined;

  for (const clause of ast.clauses) {
    switch (clause.kind) {
      case "unwind":
        bindings = unwindBindings(bindings, clause.source, clause.as, context);
        break;
      case "match":
        bindings = matchPatterns(bindings, clause.patterns, graph, context);
        break;
      case "optionalMatch":
        bindings = optionalMatchPatterns(bindings, clause.patterns, graph, context);
        break;
      case "create":
        bindings = createPatterns(bindings, clause.patterns, graph, context);
        break;
      case "merge":
        bindings = mergePatterns(bindings, clause.patterns, graph, context);
        break;
      case "createEdge":
        bindings = createEdges(bindings, clause.edges, graph, context);
        break;
      case "mergeEdge":
        bindings = mergeEdges(bindings, clause.edges, graph, context);
        break;
      case "where":
        bindings = bindings.filter((binding) => evaluatePredicate(clause.predicate, binding, context));
        break;
      case "with":
        bindings = projectWithBindings(bindings, clause.selections, context);
        break;
      case "set":
        bindings = bindings.map((binding) => setProperty(binding, clause.alias, clause.key, clause.value, context));
        break;
      case "onCreateSet":
        bindings = bindings.map((binding) =>
          binding[mergeCreatedState] === true
            ? setProperty(binding, clause.alias, clause.key, clause.value, context)
            : binding,
        );
        break;
      case "onMatchSet":
        bindings = bindings.map((binding) =>
          binding[mergeCreatedState] === false
            ? setProperty(binding, clause.alias, clause.key, clause.value, context)
            : binding,
        );
        break;
      case "delete":
        deleteAliases(bindings, clause.aliases, graph, { detach: false });
        break;
      case "detachDelete":
        deleteAliases(bindings, clause.aliases, graph, { detach: true });
        break;
      case "return":
        selections = clause.selections;
        break;
      case "orderBy":
        bindings = orderBindings(bindings, clause.expressions, context);
        break;
      case "skip":
        bindings = bindings.slice(evaluateResultCount(clause.count, context));
        break;
      case "limit":
        bindings = bindings.slice(0, evaluateResultCount(clause.count, context));
        break;
      case "call":
        bindings = callSubquery(bindings, clause.query, clause.importAliases, graph, context);
        break;
    }
  }

  return selections ? { bindings, selections } : { bindings };
}

function callSubquery(
  bindings: Binding[],
  subquery: QueryAst,
  importAliases: string[],
  graph: MemoryGraph,
  context: MemoryContext,
): Binding[] {
  return bindings.flatMap((binding) => {
    const imported = Object.fromEntries(
      importAliases
        .filter((alias) => alias in binding)
        .map((alias) => [alias, binding[alias] as MemoryValue]),
    );
    const rows = executeMemoryFromBindings(subquery, graph, context, [imported]);

    return rows.map((row) => ({
      ...binding,
      ...row,
    }));
  });
}
