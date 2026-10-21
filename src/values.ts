// Validators: describe the shape of documents and function arguments.
// The API mirrors `convex/values` so existing Convex knowledge applies.

export type GenericId<T extends string> = string & { readonly __tableName: T };

type Kind =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "id"
  | "array"
  | "object"
  | "record"
  | "union"
  | "literal"
  | "any";

export type Validator<T = unknown, Optional extends boolean = false> = {
  readonly kind: Kind;
  readonly isOptional: Optional;
  readonly tableName?: string;
  readonly element?: Validator<any, any>;
  readonly fields?: Record<string, Validator<any, any>>;
  readonly values?: Validator<any, any>;
  readonly members?: Validator<any, any>[];
  readonly value?: string | number | boolean;
  /** Type-only marker; never set at runtime. */
  readonly __type?: T;
};

export type AnyValidator = Validator<any, any>;
export type PropertyValidators = Record<string, AnyValidator>;

export type Infer<V> = V extends Validator<infer T, any> ? T : never;

type Expand<T> = T extends object ? { [K in keyof T]: T[K] } : T;

export type ObjectType<F extends PropertyValidators> = Expand<
  { [K in keyof F as F[K] extends Validator<any, true> ? never : K]: Infer<F[K]> } & {
    [K in keyof F as F[K] extends Validator<any, true> ? K : never]?: Infer<F[K]>;
  }
>;

function make<T>(kind: Kind, extra: Partial<Validator<any, any>> = {}): Validator<T, false> {
  return { kind, isOptional: false, ...extra } as Validator<T, false>;
}

export const v = {
  string: () => make<string>("string"),
  number: () => make<number>("number"),
  /** Alias kept for Convex compatibility. */
  float64: () => make<number>("number"),
  boolean: () => make<boolean>("boolean"),
  null: () => make<null>("null"),
  any: () => make<any>("any"),
  id: <T extends string>(tableName: T) => make<GenericId<T>>("id", { tableName }),
  literal: <T extends string | number | boolean>(value: T) => make<T>("literal", { value }),
  array: <E extends AnyValidator>(element: E) => make<Infer<E>[]>("array", { element }),
  object: <F extends PropertyValidators>(fields: F) => make<ObjectType<F>>("object", { fields }),
  record: <K extends AnyValidator, V extends AnyValidator>(_keys: K, values: V) =>
    make<Record<Infer<K> & string, Infer<V>>>("record", { values }),
  union: <M extends AnyValidator[]>(...members: M) =>
    make<Infer<M[number]>>("union", { members }),
  optional: <T>(inner: Validator<T, any>): Validator<T | undefined, true> =>
    ({ ...inner, isOptional: true }) as Validator<T | undefined, true>,
};

export function isValidator(x: unknown): x is AnyValidator {
  return typeof x === "object" && x !== null && typeof (x as any).kind === "string" && "isOptional" in x;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const s = JSON.stringify(value);
  const shown = s && s.length > 40 ? s.slice(0, 37) + "..." : s;
  return `${typeof value} (${shown})`;
}

export function describeValidator(val: AnyValidator): string {
  switch (val.kind) {
    case "id":
      return `v.id("${val.tableName}")`;
    case "literal":
      return `v.literal(${JSON.stringify(val.value)})`;
    case "array":
      return `v.array(${describeValidator(val.element!)})`;
    case "union":
      return val.members!.map(describeValidator).join(" | ");
    case "object":
      return "v.object({...})";
    default:
      return `v.${val.kind}()`;
  }
}

/** Returns a list of human-readable problems; empty means valid. */
export function validate(val: AnyValidator, value: unknown, path = "value"): string[] {
  if (value === undefined) {
    return val.isOptional ? [] : [`${path} is required (expected ${describeValidator(val)})`];
  }
  const expected = () => [`${path} must be ${describeValidator(val)}, got ${describeValue(value)}`];
  switch (val.kind) {
    case "any":
      return [];
    case "string":
      return typeof value === "string" ? [] : expected();
    case "number":
      return typeof value === "number" && !Number.isNaN(value) ? [] : expected();
    case "boolean":
      return typeof value === "boolean" ? [] : expected();
    case "null":
      return value === null ? [] : expected();
    case "id":
      return typeof value === "string" && value.length > 0 ? [] : expected();
    case "literal":
      return value === val.value ? [] : expected();
    case "array":
      if (!Array.isArray(value)) return expected();
      return value.flatMap((item, i) => validate(val.element!, item, `${path}[${i}]`));
    case "record":
      if (!isPlainObject(value)) return expected();
      return Object.entries(value).flatMap(([k, item]) => validate(val.values!, item, `${path}.${k}`));
    case "object": {
      if (!isPlainObject(value)) return expected();
      const errors: string[] = [];
      for (const [k, fieldVal] of Object.entries(val.fields!)) {
        errors.push(...validate(fieldVal, (value as any)[k], `${path}.${k}`));
      }
      for (const k of Object.keys(value)) {
        if (!(k in val.fields!) && (value as any)[k] !== undefined) {
          const known = Object.keys(val.fields!).join(", ") || "(none)";
          errors.push(`${path}.${k} is not allowed (known fields: ${known})`);
        }
      }
      return errors;
    }
    case "union": {
      for (const m of val.members!) {
        if (validate(m, value, path).length === 0) return [];
      }
      return expected();
    }
  }
}

export function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Accepts either `{ a: v.string() }` or `v.object({ a: v.string() })`. */
export function asObjectValidator(args: PropertyValidators | AnyValidator): AnyValidator {
  return isValidator(args) ? args : v.object(args);
}

/**
 * Throw this for errors the client should see (e.g. "Not allowed").
 * Other errors are hidden from clients in production.
 */
export class ConvexError<Data = string> extends Error {
  readonly data: Data;
  constructor(data: Data) {
    super(typeof data === "string" ? data : JSON.stringify(data));
    this.name = "ConvexError";
    this.data = data;
  }
}
