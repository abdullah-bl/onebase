// Which values the dashboard's Data grid lets you edit in place, and how.

import { expect, test } from "bun:test";
import { cellKind } from "../src/dashboard/views/cell-edit";
import { v } from "../src/values";

const json = (validator: unknown) => JSON.parse(JSON.stringify(validator));

test("simple validators are editable, structures aren't", () => {
  expect(cellKind(json(v.string()), "a")).toEqual({ type: "text" });
  expect(cellKind(json(v.id("users")), "x")).toEqual({ type: "text" });
  expect(cellKind(json(v.number()), 1)).toEqual({ type: "number" });
  expect(cellKind(json(v.optional(v.number())), undefined)).toEqual({ type: "number" });
  expect(cellKind(json(v.boolean()), true)).toEqual({ type: "boolean" });
  expect(cellKind(json(v.union(v.literal("a"), v.literal("b"))), "a")).toEqual({ type: "choice", options: ["a", "b"] });
  expect(cellKind(json(v.union(v.string(), v.null())), "a")).toBeNull();
  expect(cellKind(json(v.array(v.string())), [])).toBeNull();
  expect(cellKind(json(v.object({ a: v.string() })), {})).toBeNull();
});

test("without a validator, the value decides", () => {
  expect(cellKind(null, "a")).toEqual({ type: "text" });
  expect(cellKind(json(v.any()), 2)).toEqual({ type: "number" });
  expect(cellKind(undefined, false)).toEqual({ type: "boolean" });
  expect(cellKind(null, { a: 1 })).toBeNull();
  expect(cellKind(null, undefined)).toBeNull();
});
