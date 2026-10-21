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

export class TableDefinition<
  Document = any,
  Indexes extends Record<string, string[]> = {},
> {
  readonly indexes: IndexDef[] = [];
  /** Type-only marker. */
  declare readonly __indexes: Indexes;

  constructor(readonly validator: Validator<Document, any>) {}

  index<Name extends string, Fields extends [FieldPath<Document>, ...FieldPath<Document>[]]>(
    name: Name,
    fields: Fields,
  ): TableDefinition<Document, Indexes & Record<Name, Fields>> {
    this.indexes.push({ name, fields });
    return this as any;
  }

  searchIndex(name: string, _config: unknown): this {
    throw new Error(
      `searchIndex("${name}") is not supported by onebase yet. ` +
        `Use a regular .index() and filter in your query instead.`,
    );
  }

  vectorIndex(name: string, _config: unknown): this {
    throw new Error(`vectorIndex("${name}") is not supported by onebase yet.`);
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

export type SchemaDefinition<Tables extends Record<string, TableDefinition<any, any>>> = {
  readonly tables: Tables;
  readonly schemaValidation: boolean;
  readonly __isOnebaseSchema: true;
};

export function defineSchema<Tables extends Record<string, TableDefinition<any, any>>>(
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

export type GenericTableInfo = { document: GenericDocument; indexes: Record<string, string[]> };
export type GenericDataModel = Record<string, GenericTableInfo>;

/** Used when there is no schema.ts: any table, any shape. */
export type AnyDataModel = {
  [table: string]: { document: any; indexes: Record<string, string[]> };
};

export type DataModelFromSchema<S> =
  S extends SchemaDefinition<infer Tables>
    ? {
        [T in keyof Tables & string]: Tables[T] extends TableDefinition<infer D, infer I>
          ? { document: Expand<D & SystemFields<T>>; indexes: Expand<I & { by_creation_time: ["_creationTime"] }> }
          : never;
      }
    : AnyDataModel;
