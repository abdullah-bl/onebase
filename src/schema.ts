import {
  asObjectValidator,
  type AnyValidator,
  type GenericId,
  type Infer,
  type ObjectType,
  type PropertyValidators,
  type Validator,
} from "./values";

export type IndexDef = { name: string; fields: string[] };
export type SearchIndexDef = { name: string; searchField: string; filterFields: string[] };
/** Type-level shape of a search index: its text field and the fields it can filter on. */
export type SearchIndexConfig = { searchField: string; filterFields: string };
export type VectorIndexDef = { name: string; vectorField: string; dimensions: number; filterFields: string[] };
/** Type-level shape of a vector index: its vector field, its size and the fields it can filter on. */
export type VectorIndexConfig = { vectorField: string; dimensions: number; filterFields: string };

/** Vector sizes a vector index accepts, like Convex. */
export const MIN_VECTOR_DIMENSIONS = 2;
export const MAX_VECTOR_DIMENSIONS = 4096;

const INDEX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class TableDefinition<
  Document = any,
  Indexes extends Record<string, string[]> = {},
  SearchIndexes extends Record<string, SearchIndexConfig> = {},
  VectorIndexes extends Record<string, VectorIndexConfig> = {},
> {
  readonly indexes: IndexDef[] = [];
  readonly searchIndexes: SearchIndexDef[] = [];
  readonly vectorIndexes: VectorIndexDef[] = [];
  /** Type-only markers. */
  declare readonly __indexes: Indexes;
  declare readonly __searchIndexes: SearchIndexes;
  declare readonly __vectorIndexes: VectorIndexes;

  constructor(readonly validator: Validator<Document, any>) {}

  index<Name extends string, Fields extends [FieldPath<Document>, ...FieldPath<Document>[]]>(
    name: Name,
    fields: Fields,
  ): TableDefinition<Document, Indexes & Record<Name, Fields>, SearchIndexes, VectorIndexes> {
    this.indexes.push({ name, fields });
    return this as any;
  }

  /**
   * Full-text search over one string field, optionally narrowed by equality on `filterFields`.
   * Query it with `ctx.db.query(table).withSearchIndex(name, q => q.search(field, "text").eq(...))`.
   */
  searchIndex<Name extends string, SearchField extends FieldPath<Document>, FilterFields extends FieldPath<Document> = never>(
    name: Name,
    config: { searchField: SearchField; filterFields?: FilterFields[] },
  ): TableDefinition<Document, Indexes, SearchIndexes & Record<Name, { searchField: SearchField; filterFields: FilterFields }>, VectorIndexes> {
    if (!INDEX_NAME.test(name)) throw new Error(`Invalid search index name "${name}": use letters, digits and _.`);
    if (typeof config?.searchField !== "string") {
      throw new Error(`searchIndex("${name}") needs a searchField, e.g. .searchIndex("${name}", { searchField: "body" }).`);
    }
    const filterFields = config.filterFields ?? [];
    if (!Array.isArray(filterFields) || filterFields.some((f) => typeof f !== "string")) {
      throw new Error(`searchIndex("${name}"): filterFields must be a list of field names.`);
    }
    if (filterFields.length > 16) throw new Error(`searchIndex("${name}") can have at most 16 filterFields.`);
    this.searchIndexes.push({ name, searchField: config.searchField, filterFields: [...filterFields] });
    return this as any;
  }

  /**
   * Nearest-neighbour search over an array of numbers, optionally narrowed by `filterFields`.
   * Query it from an action with `ctx.vectorSearch(table, name, { vector, limit, filter })`.
   * Documents whose field is missing aren't indexed; any other value must be `dimensions` numbers.
   */
  vectorIndex<
    Name extends string,
    VectorField extends FieldPath<Document>,
    Dimensions extends number,
    FilterFields extends FieldPath<Document> = never,
  >(
    name: Name,
    config: { vectorField: VectorField; dimensions: Dimensions; filterFields?: FilterFields[] },
  ): TableDefinition<
    Document,
    Indexes,
    SearchIndexes,
    VectorIndexes & Record<Name, { vectorField: VectorField; dimensions: Dimensions; filterFields: FilterFields }>
  > {
    if (!INDEX_NAME.test(name)) throw new Error(`Invalid vector index name "${name}": use letters, digits and _.`);
    if (typeof config?.vectorField !== "string") {
      throw new Error(`vectorIndex("${name}") needs a vectorField, e.g. .vectorIndex("${name}", { vectorField: "embedding", dimensions: 1536 }).`);
    }
    const { dimensions } = config;
    if (!Number.isInteger(dimensions) || dimensions < MIN_VECTOR_DIMENSIONS || dimensions > MAX_VECTOR_DIMENSIONS) {
      throw new Error(`vectorIndex("${name}"): dimensions must be a whole number from ${MIN_VECTOR_DIMENSIONS} to ${MAX_VECTOR_DIMENSIONS}, got ${dimensions}.`);
    }
    const filterFields = config.filterFields ?? [];
    if (!Array.isArray(filterFields) || filterFields.some((f) => typeof f !== "string")) {
      throw new Error(`vectorIndex("${name}"): filterFields must be a list of field names.`);
    }
    if (filterFields.length > 16) throw new Error(`vectorIndex("${name}") can have at most 16 filterFields.`);
    this.vectorIndexes.push({ name, vectorField: config.vectorField, dimensions, filterFields: [...filterFields] });
    return this as any;
  }
}

type FieldPath<D> = (keyof D & string) | `${keyof D & string}.${string}`;

export function defineTable<F extends PropertyValidators>(
  fields: F,
): TableDefinition<ObjectType<F>>;
export function defineTable<V extends AnyValidator>(validator: V): TableDefinition<Infer<V>>;
export function defineTable(fieldsOrValidator: PropertyValidators | AnyValidator): TableDefinition {
  return new TableDefinition(asObjectValidator(fieldsOrValidator));
}

export type SchemaOptions = {
  /** Validate every write against the table validator (default true). */
  schemaValidation?: boolean;
};

export type SchemaDefinition<Tables extends Record<string, TableDefinition<any, any, any, any>>> = {
  readonly tables: Tables;
  readonly schemaValidation: boolean;
  readonly __isOnebaseSchema: true;
};

export function defineSchema<Tables extends Record<string, TableDefinition<any, any, any, any>>>(
  tables: Tables,
  options: SchemaOptions = {},
): SchemaDefinition<Tables> {
  for (const [name, table] of Object.entries(tables)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid table name "${name}": use letters, digits and _ (must start with a letter).`);
    }
    if (!(table instanceof TableDefinition) && !(table as any)?.validator) {
      throw new Error(`Table "${name}" must be created with defineTable({...}).`);
    }
    const names = [...table.indexes, ...(table.searchIndexes ?? []), ...(table.vectorIndexes ?? [])].map((i) => i.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw new Error(`Table "${name}" has two indexes named "${dup}".`);
  }
  return { tables, schemaValidation: options.schemaValidation ?? true, __isOnebaseSchema: true };
}

// ---- Data model types derived from a schema ----

type Expand<T> = T extends object ? { [K in keyof T]: T[K] } : T;

export type SystemFields<TableName extends string> = {
  _id: GenericId<TableName>;
  _creationTime: number;
};

export type GenericDocument = Record<string, any> & { _id: string; _creationTime: number };

export type GenericTableInfo = {
  document: GenericDocument;
  indexes: Record<string, string[]>;
  searchIndexes?: Record<string, SearchIndexConfig>;
  vectorIndexes?: Record<string, VectorIndexConfig>;
};
export type GenericDataModel = Record<string, GenericTableInfo>;

/** Used when there is no schema.ts: any table, any shape. */
export type AnyDataModel = {
  [table: string]: {
    document: any;
    indexes: Record<string, string[]>;
    searchIndexes: Record<string, SearchIndexConfig>;
    vectorIndexes: Record<string, VectorIndexConfig>;
  };
};

/** Every index implicitly ends with _creationTime (documents with equal fields are in creation order). */
type WithCreationTime<I> = { [K in keyof I]: I[K] extends string[] ? [...I[K], "_creationTime"] : I[K] };

export type DataModelFromSchema<S> =
  S extends SchemaDefinition<infer Tables>
    ? {
        [T in keyof Tables & string]: Tables[T] extends TableDefinition<infer D, infer I, infer SI, infer VI>
          ? {
              document: Expand<D & SystemFields<T>>;
              indexes: Expand<WithCreationTime<I> & { by_creation_time: ["_creationTime"] }>;
              searchIndexes: Expand<SI>;
              vectorIndexes: Expand<VI>;
            }
          : never;
      }
    : AnyDataModel;
