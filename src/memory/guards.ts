import type { ParameterValue, Primitive } from "../ast.js";
import type {
  MemoryEdge,
  MemoryNode,
  MemoryPath,
  MemoryRow,
  MemoryRowObject,
  MemoryValue,
} from "./types.js";

/**
 * Narrows unknown runtime data to a graph property primitive, returning null for unsupported values.
 */
export function primitiveOrNull(value: unknown): Primitive {
  return isPrimitive(value) ? value : null;
}

/**
 * Converts a runtime parameter into a value shape that the memory executor can compare/project.
 */
export function parameterValueToMemoryValue(value: ParameterValue | undefined): MemoryValue {
  if (isPrimitive(value) || isPrimitiveArray(value)) {
    return value;
  }

  return null;
}

/**
 * Checks whether a value can be stored directly as a graph property primitive.
 */
export function isPrimitive(value: unknown): value is Primitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * Checks whether a value is a list of graph property primitives.
 */
export function isPrimitiveArray(value: unknown): value is Primitive[] {
  return Array.isArray(value) && value.every(isPrimitive);
}

/**
 * Checks whether a value is an object row produced by UNWIND input data.
 */
export function isRowObject(value: unknown): value is MemoryRowObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isPrimitive)
  );
}

/**
 * Checks whether a value is a list of UNWIND-compatible row objects.
 */
export function isRowObjectArray(value: unknown): value is MemoryRowObject[] {
  return Array.isArray(value) && value.every(isRowObject);
}

/**
 * Checks whether a runtime value looks like a memory graph node.
 */
export function isNode(entity: unknown): entity is MemoryNode {
  return typeof entity === "object" && entity !== null && "labels" in entity;
}

/**
 * Checks whether a runtime value looks like a memory graph edge.
 */
export function isEdge(entity: unknown): entity is MemoryEdge {
  return typeof entity === "object" && entity !== null && "from" in entity && "to" in entity;
}

/**
 * Checks whether a runtime value looks like a path returned by traversal matching.
 */
export function isPath(entity: unknown): entity is MemoryPath {
  return typeof entity === "object" && entity !== null && "nodes" in entity && "edges" in entity;
}

/**
 * Checks whether a memory value is a graph entity with a stable id.
 */
export function isEntity(entity: MemoryValue): entity is MemoryNode | MemoryEdge {
  return isNode(entity) || isEdge(entity);
}

/**
 * Compares a runtime value with a path by node and edge identity.
 */
export function isSamePath(value: MemoryValue, path: MemoryPath): boolean {
  return (
    isPath(value) &&
    value.nodes.map((node) => node.id).join("\0") === path.nodes.map((node) => node.id).join("\0") &&
    value.edges.map((edge) => edge.id).join("\0") === path.edges.map((edge) => edge.id).join("\0")
  );
}

/**
 * Compares a runtime value with a traversal edge list by edge identity and order.
 */
export function isSameEdgeList(value: MemoryValue, edges: MemoryEdge[]): boolean {
  if (!Array.isArray(value) || value.length !== edges.length) {
    return false;
  }

  for (const [index, edge] of value.entries()) {
    if (!isEdge(edge) || edge.id !== edges[index]?.id) {
      return false;
    }
  }

  return true;
}

/**
 * Builds a stable grouping key for aggregate projections.
 */
export function stableGroupKey(values: MemoryRow): string {
  return JSON.stringify(
    Object.entries(values).map(([key, value]) => [key, stableValueKey(value)]),
  );
}

/**
 * Builds a deterministic key for primitive, entity, path, array, and projection values.
 */
export function stableValueKey(value: MemoryValue): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value.map(stableValueKey));
  }

  if (isNode(value)) {
    return `node:${value.id}`;
  }

  if (isEdge(value)) {
    return `edge:${value.id}`;
  }

  if (isPath(value)) {
    return `path:${value.nodes.map((node) => node.id).join(",")}:${value.edges.map((edge) => edge.id).join(",")}`;
  }

  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
