import type {
  ParameterValue,
  Primitive,
} from "../ast.js";

/**
 * Node stored by the in-memory graph executor.
 */
export type MemoryNode = {
  /**
   * Stable node identifier.
   */
  id: string;
  /**
   * Node labels.
   */
  labels: string[];
  /**
   * Primitive node properties.
   */
  properties: Record<string, Primitive>;
};

/**
 * Edge stored by the in-memory graph executor.
 */
export type MemoryEdge = {
  /**
   * Stable edge identifier.
   */
  id: string;
  /**
   * Edge label.
   */
  label: string;
  /**
   * Source node id.
   */
  from: string;
  /**
   * Target node id.
   */
  to: string;
  /**
   * Primitive edge properties.
   */
  properties: Record<string, Primitive>;
};

/**
 * Path produced by the in-memory graph executor.
 */
export type MemoryPath = {
  /**
   * Nodes in path order.
   */
  nodes: MemoryNode[];
  /**
   * Edges in traversal order.
   */
  edges: MemoryEdge[];
};

/**
 * Mutable graph consumed by `executeMemory(...)`.
 */
export type MemoryGraph = {
  /**
   * Nodes available in the graph.
   */
  nodes: MemoryNode[];
  /**
   * Edges available in the graph.
   */
  edges: MemoryEdge[];
};

/**
 * Options accepted by the in-memory executor.
 */
export type MemoryExecuteOptions = {
  /**
   * Runtime parameters available to `param(...)` expressions.
   */
  params?: Record<string, ParameterValue>;
};

/**
 * Row projected by the in-memory executor.
 */
export type MemoryValue =
  | MemoryNode
  | MemoryEdge
  | MemoryEdge[]
  | MemoryPath
  | MemoryRowObject
  | MemoryProjectionObject
  | Primitive
  | Primitive[]
  | MemoryValue[];

export type MemoryRow = Record<string, MemoryValue>;

/**
 * Object produced by an `unwind(...)` row binding.
 */
export type MemoryRowObject = Record<string, Primitive>;

export interface MemoryProjectionObject {
  [key: string]: MemoryValue;
}

export type BindingValue = MemoryValue;

export const mergeCreatedState = Symbol("mergeCreatedState");

export type Binding = Record<string, BindingValue> & {
  [mergeCreatedState]?: boolean;
};

export type MemoryContext = {
  params: Record<string, ParameterValue>;
  listItems?: Record<string, MemoryValue>;
};
