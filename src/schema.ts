import type { Primitive } from "./ast.js";
import {
  edge,
  node,
  param,
  prop,
  type EdgeRef,
  type NodeRef,
  type PropertySet,
} from "./dsl.js";

/**
 * Primitive field types supported by runtime node schemas.
 *
 * These are intentionally limited to values that can be represented as graph
 * properties and query parameters without backend-specific encoding.
 */
export type JsonFieldType = "string" | "number" | "boolean";

/**
 * Serializable field definition that can be stored in JSON/BSON.
 *
 * A field definition is used at runtime to validate form/input data before it
 * is mapped to DSL properties.
 */
export type JsonFieldSchema = {
  /**
   * Primitive type expected for this field.
   */
  type: JsonFieldType;
  /**
   * Whether this field must be present in mapped input.
   */
  required?: boolean;
};

/**
 * Behavior for fields present in input but absent from the schema.
 *
 * Use `"error"` for stricter form validation and `"strip"` when input may
 * contain unrelated fields that should not be persisted.
 */
export type UnknownFieldBehavior = "error" | "strip";

/**
 * Serializable node schema definition suitable for storing in MongoDB.
 *
 * This is the runtime equivalent of a typed node schema. It is intentionally
 * plain JSON so it can be loaded from configuration or a database.
 */
export type JsonNodeSchema = {
  /**
   * Schema kind. Only node schemas are supported for now.
   */
  kind: "node";
  /**
   * Graph label to apply to mapped nodes.
   */
  label: string;
  /**
   * Serializable field definitions keyed by property name.
   */
  fields: Record<string, JsonFieldSchema>;
  /**
   * Optional runtime mapping behavior.
   */
  options?: {
    /**
     * How to handle fields that are not defined by the schema.
     *
     * @default "error"
     */
    unknownFields?: UnknownFieldBehavior;
  };
};

/**
 * Serializable edge schema definition suitable for storing in MongoDB.
 *
 * Edge schemas validate and map properties for relationships. Endpoints are
 * provided separately as `NodeRef` values when mapping input.
 */
export type JsonEdgeSchema = {
  /**
   * Schema kind.
   */
  kind: "edge";
  /**
   * Graph relationship/edge label to apply to mapped edges.
   */
  label: string;
  /**
   * Serializable field definitions keyed by property name.
   */
  fields: Record<string, JsonFieldSchema>;
  /**
   * Optional runtime mapping behavior.
   */
  options?: {
    /**
     * How to handle fields that are not defined by the schema.
     *
     * @default "error"
     */
    unknownFields?: UnknownFieldBehavior;
  };
};

/**
 * Input object accepted by runtime schema mappers.
 *
 * Typical inputs are form payloads, API request bodies, or documents loaded
 * from another system.
 */
export type SchemaInput = Record<string, unknown>;

/**
 * Options for mapping an input object through a runtime schema.
 */
export type SchemaMapOptions = {
  /**
   * Prefix used for generated parameter names.
   *
   * For node schemas this defaults to the node alias. For edge schemas this
   * defaults to `${fromAlias}_${edgeLabel}_${toAlias}`.
   *
   * @default node alias or derived edge alias
   */
  paramPrefix?: string;
  /**
   * Overrides schema-level unknown field behavior.
   */
  unknownFields?: UnknownFieldBehavior;
};

/**
 * Options for mapping identity fields through a runtime schema.
 */
export type SchemaIdentityOptions = SchemaMapOptions;

/**
 * Result of mapping an input object to a node pattern and parameter bag.
 *
 * Pass `node` to the DSL and merge `params` into compiler/executor params.
 */
export type MappedNode = {
  /**
   * Node reference with properties mapped to generated parameters.
   */
  node: NodeRef;
  /**
   * Generated parameter values.
   */
  params: Record<string, Primitive>;
};

/**
 * Result of mapping an input object to an edge pattern and parameter bag.
 *
 * Pass `edge` to `createEdge(...)` and merge `params` into compiler/executor params.
 */
export type MappedEdge = {
  /**
   * Edge reference with properties mapped to generated parameters.
   */
  edge: EdgeRef;
  /**
   * Generated parameter values.
   */
  params: Record<string, Primitive>;
};

/**
 * Result of mapping an input object to property updates and a parameter bag.
 *
 * Pass this object to `query().setProps(...)` and merge `params` into
 * compiler/executor params.
 */
export type MappedPatch = {
  /**
   * Property assignments mapped from input fields.
   */
  sets: PropertySet[];
  /**
   * Generated parameter values.
   */
  params: Record<string, Primitive>;
};

/**
 * Runtime node schema produced from a serializable JSON definition.
 *
 * Use `from(...)` to turn runtime input into a `NodeRef` with parameterized
 * properties.
 */
export type RuntimeNodeSchema = {
  /**
   * Original serializable schema definition.
   */
  schema: JsonNodeSchema;
  /**
   * Maps an input object to a node reference and generated params.
   *
   * @param alias - Node alias to use in the graph query.
   * @param input - Runtime object, such as form data.
   * @param options - Optional mapping behavior.
   * @returns A mapped node and parameter bag.
   */
  from(alias: string, input: SchemaInput, options?: SchemaMapOptions): MappedNode;
  /**
   * Maps selected input fields to identity properties for `merge(...)`.
   *
   * Selected identity fields must be present even if the schema marks them as optional.
   * Other schema fields in the input are ignored.
   *
   * @param alias - Node alias to use in the graph query.
   * @param input - Runtime object, such as form data.
   * @param fields - Schema field names to use as identity properties.
   * @param options - Optional mapping behavior.
   * @returns A mapped node containing only identity properties and a parameter bag.
   */
  identity(alias: string, input: SchemaInput, fields: string[], options?: SchemaIdentityOptions): MappedNode;
  /**
   * Maps an input object to property updates for an already-bound node alias.
   *
   * Required fields are not required for patches. Present fields are still
   * validated and unknown fields follow normal `unknownFields` behavior.
   *
   * @param alias - Already-bound node alias to update.
   * @param input - Partial runtime object, such as form data.
   * @param options - Optional mapping behavior.
   * @returns A mapped patch and parameter bag.
   */
  patch(alias: string, input: SchemaInput, options?: SchemaMapOptions): MappedPatch;
};

/**
 * Runtime edge schema produced from a serializable JSON definition.
 *
 * Use `from(...)` to turn runtime input into an `EdgeRef` with parameterized
 * properties.
 */
export type RuntimeEdgeSchema = {
  /**
   * Original serializable schema definition.
   */
  schema: JsonEdgeSchema;
  /**
   * Maps an input object to an edge reference and generated params.
   *
   * @param from - Source-side node reference.
   * @param to - Target-side node reference.
   * @param input - Runtime object, such as form data.
   * @param options - Optional mapping behavior.
   * @returns A mapped edge and parameter bag.
   */
  from(from: NodeRef, to: NodeRef, input: SchemaInput, options?: SchemaMapOptions): MappedEdge;
  /**
   * Maps selected input fields to identity properties for `mergeEdge(...)`.
   *
   * Selected identity fields must be present even if the schema marks them as optional.
   * Other schema fields in the input are ignored.
   *
   * @param from - Source-side node reference.
   * @param to - Target-side node reference.
   * @param input - Runtime object, such as form data.
   * @param fields - Schema field names to use as identity properties.
   * @param options - Optional mapping behavior.
   * @returns A mapped edge containing only identity properties and a parameter bag.
   */
  identity(
    from: NodeRef,
    to: NodeRef,
    input: SchemaInput,
    fields: string[],
    options?: SchemaIdentityOptions,
  ): MappedEdge;
  /**
   * Maps an input object to property updates for an already-bound edge alias.
   *
   * Required fields are not required for patches. Present fields are still
   * validated and unknown fields follow normal `unknownFields` behavior.
   *
   * @param alias - Already-bound edge alias to update.
   * @param input - Partial runtime object, such as form data.
   * @param options - Optional mapping behavior.
   * @returns A mapped patch and parameter bag.
   */
  patch(alias: string, input: SchemaInput, options?: SchemaMapOptions): MappedPatch;
};

/**
 * Creates a runtime node schema from a serializable JSON definition.
 *
 * The schema is validated when this function is called. Input values are
 * validated later by `RuntimeNodeSchema.from(...)`.
 *
 * @param schema - Serializable node schema, for example a document loaded from MongoDB.
 * @returns A runtime node mapper.
 */
export function defineNodeFromJson(schema: JsonNodeSchema): RuntimeNodeSchema {
  validateNodeSchema(schema);

  return {
    schema,
    from(alias, input, options = {}) {
      return mapNodeInput(schema, alias, input, options);
    },
    identity(alias, input, fields, options = {}) {
      return mapNodeIdentity(schema, alias, input, fields, options);
    },
    patch(alias, input, options = {}) {
      return mapPatchInput(schema, alias, input, options);
    },
  };
}

/**
 * Creates a runtime edge schema from a serializable JSON definition.
 *
 * The schema is validated when this function is called. Input values are
 * validated later by `RuntimeEdgeSchema.from(...)`.
 *
 * @param schema - Serializable edge schema, for example a document loaded from MongoDB.
 * @returns A runtime edge mapper.
 */
export function defineEdgeFromJson(schema: JsonEdgeSchema): RuntimeEdgeSchema {
  validateEdgeSchema(schema);

  return {
    schema,
    from(from, to, input, options = {}) {
      return mapEdgeInput(schema, from, to, input, options);
    },
    identity(from, to, input, fields, options = {}) {
      return mapEdgeIdentity(schema, from, to, input, fields, options);
    },
    patch(alias, input, options = {}) {
      return mapPatchInput(schema, alias, input, options);
    },
  };
}

function mapNodeIdentity(
  schema: JsonNodeSchema,
  alias: string,
  input: SchemaInput,
  fields: string[],
  options: SchemaIdentityOptions,
): MappedNode {
  const { params, props } = mapInputToProps(schema, alias, input, options, {
    includeFields: fields,
    requireIncludedFields: true,
    requireRequiredFields: false,
  });

  return {
    node: node(alias, schema.label).props(props),
    params,
  };
}

function mapNodeInput(
  schema: JsonNodeSchema,
  alias: string,
  input: SchemaInput,
  options: SchemaMapOptions,
): MappedNode {
  const { params, props } = mapInputToProps(schema, alias, input, options, {
    requireRequiredFields: true,
  });

  return {
    node: node(alias, schema.label).props(props),
    params,
  };
}

function mapEdgeIdentity(
  schema: JsonEdgeSchema,
  from: NodeRef,
  to: NodeRef,
  input: SchemaInput,
  fields: string[],
  options: SchemaIdentityOptions,
): MappedEdge {
  const edgeAlias = `${from.alias}_${schema.label}_${to.alias}`;
  const { params, props } = mapInputToProps(schema, edgeAlias, input, options, {
    includeFields: fields,
    requireIncludedFields: true,
    requireRequiredFields: false,
  });

  return {
    edge: edge(from, schema.label, to).props(props),
    params,
  };
}

function mapEdgeInput(
  schema: JsonEdgeSchema,
  from: NodeRef,
  to: NodeRef,
  input: SchemaInput,
  options: SchemaMapOptions,
): MappedEdge {
  const edgeAlias = `${from.alias}_${schema.label}_${to.alias}`;
  const { params, props } = mapInputToProps(schema, edgeAlias, input, options, {
    requireRequiredFields: true,
  });

  return {
    edge: edge(from, schema.label, to).props(props),
    params,
  };
}

function mapPatchInput(
  schema: JsonNodeSchema | JsonEdgeSchema,
  alias: string,
  input: SchemaInput,
  options: SchemaMapOptions,
): MappedPatch {
  const { params, props } = mapInputToProps(schema, alias, input, options, {
    requireRequiredFields: false,
  });

  return {
    sets: Object.entries(props).map(([key, value]) => ({
      property: prop(alias, key),
      value,
    })),
    params,
  };
}

function mapInputToProps(
  schema: JsonNodeSchema | JsonEdgeSchema,
  defaultParamPrefix: string,
  input: SchemaInput,
  options: SchemaMapOptions,
  mapOptions: {
    includeFields?: string[];
    requireIncludedFields?: boolean;
    requireRequiredFields: boolean;
  },
): { params: Record<string, Primitive>; props: Record<string, ReturnType<typeof param>> } {
  const unknownFields = options.unknownFields ?? schema.options?.unknownFields ?? "error";
  const paramPrefix = options.paramPrefix ?? defaultParamPrefix;
  const selectedFields = mapOptions.includeFields
    ? new Set(mapOptions.includeFields)
    : undefined;
  const schemaFields = new Set(Object.keys(schema.fields));
  const extraFields = Object.keys(input).filter((key) => !schemaFields.has(key));

  if (unknownFields === "error" && extraFields.length > 0) {
    throw new Error(`Unknown fields for "${schema.label}": ${extraFields.join(", ")}.`);
  }

  const params: Record<string, Primitive> = {};
  const props: Record<string, ReturnType<typeof param>> = {};

  if (selectedFields) {
    for (const key of selectedFields) {
      if (!schemaFields.has(key)) {
        throw new Error(`Unknown identity field for "${schema.label}": ${key}.`);
      }
    }
  }

  for (const [key, field] of Object.entries(schema.fields)) {
    if (selectedFields && !selectedFields.has(key)) {
      continue;
    }

    const rawValue = input[key];

    if (rawValue === undefined) {
      if (
        (field.required && mapOptions.requireRequiredFields) ||
        (selectedFields?.has(key) && mapOptions.requireIncludedFields)
      ) {
        throw new Error(`Missing required field "${key}" for "${schema.label}".`);
      }

      continue;
    }

    if (!matchesFieldType(rawValue, field.type)) {
      throw new Error(`Invalid field "${key}" for "${schema.label}": expected ${field.type}.`);
    }

    const paramName = `${paramPrefix}_${key}`;
    params[paramName] = rawValue;
    props[key] = param(paramName);
  }

  return { params, props };
}

function validateNodeSchema(schema: JsonNodeSchema): void {
  if (schema.kind !== "node") {
    throw new Error('Node schema must have kind "node".');
  }

  if (!schema.label) {
    throw new Error("Node schema must define a label.");
  }

  validateFields(schema);
}

function validateEdgeSchema(schema: JsonEdgeSchema): void {
  if (schema.kind !== "edge") {
    throw new Error('Edge schema must have kind "edge".');
  }

  if (!schema.label) {
    throw new Error("Edge schema must define a label.");
  }

  validateFields(schema);
}

function validateFields(schema: JsonNodeSchema | JsonEdgeSchema): void {
  for (const [key, field] of Object.entries(schema.fields)) {
    if (!["string", "number", "boolean"].includes(field.type)) {
      throw new Error(`Unsupported field type for "${key}": ${field.type}.`);
    }
  }
}

function matchesFieldType(value: unknown, type: JsonFieldType): value is Primitive {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
}
