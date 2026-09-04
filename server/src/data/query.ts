import { z } from "zod";
import { ApiError } from "../lib/errors.js";

export const filterSchema = z.object({
  column: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "like", "ilike", "contains", "containedBy", "overlaps", "textSearch", "not", "or"]),
  value: z.unknown().optional(),
  expression: z.string().max(4000).optional(),
  options: z.record(z.unknown()).optional(),
}).passthrough();

export const serializedQuerySchema = z.object({
  table: z.string().regex(/^[a-z][a-z0-9_]*$/),
  operation: z.enum(["select", "insert", "update", "upsert", "delete"]),
  columns: z.union([z.string(), z.array(z.string())]).optional(),
  values: z.unknown().optional(),
  filters: z.array(filterSchema).default([]),
  order: z.array(z.object({ column: z.string().regex(/^[a-z][a-z0-9_]*$/), ascending: z.boolean().default(true) })).default([]),
  limit: z.number().int().positive().max(500).optional(),
  range: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional(),
  cardinality: z.enum(["many", "single", "maybeSingle"]).default("many"),
  options: z.object({ count: z.enum(["exact", "planned", "estimated"]).optional(), head: z.boolean().optional(), onConflict: z.string().optional() }).passthrough().optional(),
}).strict();

export type SerializedQuery = z.infer<typeof serializedQuerySchema>;
export type SerializedFilter = z.infer<typeof filterSchema>;

export function applyCardinality<T>(rows: T[], cardinality: SerializedQuery["cardinality"]): T[] | T | null {
  if (cardinality === "many") return rows;
  if (rows.length > 1) throw new ApiError(406, "multiple_rows", "The query returned more than one row");
  if (cardinality === "single" && rows.length !== 1) throw new ApiError(406, "row_not_found", "The query did not return exactly one row");
  return rows[0] ?? null;
}

export function matchesFilter(row: Record<string, unknown>, filter: SerializedFilter): boolean {
  if (filter.operator === "or") return true;
  if (!filter.column) throw new ApiError(400, "invalid_filter", "Filter column is required");
  const actual = row[filter.column];
  const expected = filter.value;
  switch (filter.operator) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt": return String(actual) > String(expected);
    case "gte": return String(actual) >= String(expected);
    case "lt": return String(actual) < String(expected);
    case "lte": return String(actual) <= String(expected);
    case "in": return Array.isArray(expected) && expected.includes(actual);
    case "is": return expected === null ? actual == null : actual === expected;
    case "like": return like(String(actual ?? ""), String(expected ?? ""), false);
    case "ilike": return like(String(actual ?? ""), String(expected ?? ""), true);
    case "contains": return Array.isArray(actual) ? (Array.isArray(expected) ? expected.every((v) => actual.includes(v)) : actual.includes(expected)) : String(actual ?? "").includes(String(expected ?? ""));
    case "overlaps": return Array.isArray(actual) && Array.isArray(expected) && expected.some((v) => actual.includes(v));
    case "containedBy": return Array.isArray(actual) && Array.isArray(expected) && actual.every((v) => expected.includes(v));
    case "textSearch": return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "not": {
      const nested = filter.options?.operator;
      if (nested === "in") return !parseInValue(expected).includes(actual);
      if (nested === "eq") return actual !== expected;
      throw new ApiError(400, "operator_not_supported", "Unsupported NOT filter");
    }
  }
}

export function parseInValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") throw new ApiError(400, "invalid_in_filter", "IN filter requires an array or parenthesized list");
  const trimmed = value.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) throw new ApiError(400, "invalid_in_filter", "IN filter list must be parenthesized");
  return trimmed.slice(1, -1).split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

function like(actual: string, pattern: string, insensitive: boolean): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, insensitive ? "i" : "").test(actual);
}

type LogicOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is" | "like" | "ilike";
export type ParsedLogicNode =
  | { kind: "predicate"; column: string; operator: LogicOperator; value: unknown }
  | { kind: "and"; children: ParsedLogicNode[] }
  | { kind: "or"; children: ParsedLogicNode[] };

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new ApiError(400, "invalid_or_filter", "The OR filter has unbalanced parentheses");
    } else if (character === "," && depth === 0) {
      parts.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) throw new ApiError(400, "invalid_or_filter", "The OR filter has unbalanced parentheses");
  parts.push(input.slice(start).trim());
  if (parts.some((part) => !part)) throw new ApiError(400, "invalid_or_filter", "The OR filter contains an empty expression");
  return parts;
}

function parseLogicNode(raw: string, depth: number): ParsedLogicNode {
  if (depth > 4) throw new ApiError(400, "invalid_or_filter", "The OR filter is nested too deeply");
  const group = raw.match(/^(and|or)\(([\s\S]*)\)$/);
  if (group) {
    const children = splitTopLevel(group[2]!).map((part) => parseLogicNode(part, depth + 1));
    if (!children.length || children.length > 20) throw new ApiError(400, "invalid_or_filter", "The OR filter group is too large");
    return { kind: group[1]! as "and" | "or", children };
  }
  const match = raw.match(/^([a-z][a-z0-9_]*)\.(eq|neq|gt|gte|lt|lte|in|is|like|ilike)\.([\s\S]*)$/);
  if (!match) throw new ApiError(400, "invalid_or_filter", "The OR filter expression is not supported");
  const operator = match[2]! as LogicOperator;
  const rawValue = match[3]!;
  const value = operator === "is"
    ? rawValue === "null" ? null : rawValue === "true" ? true : rawValue === "false" ? false : rawValue
    : operator === "in" ? parseInValue(rawValue) : rawValue;
  return { kind: "predicate", column: match[1]!, operator, value };
}

export function parseOrExpression(expression: string): ParsedLogicNode[] {
  if (!expression || expression.length > 4000) throw new ApiError(400, "invalid_or_filter", "The OR filter is empty or too long");
  const nodes = splitTopLevel(expression).map((part) => parseLogicNode(part, 0));
  const count = (node: ParsedLogicNode): number => node.kind === "predicate" ? 1 : 1 + node.children.reduce((total, child) => total + count(child), 0);
  if (nodes.reduce((total, node) => total + count(node), 0) > 50) throw new ApiError(400, "invalid_or_filter", "The OR filter has too many terms");
  return nodes;
}

export function matchesLogicNode(row: Record<string, unknown>, node: ParsedLogicNode): boolean {
  if (node.kind === "and") return node.children.every((child) => matchesLogicNode(row, child));
  if (node.kind === "or") return node.children.some((child) => matchesLogicNode(row, child));
  return matchesFilter(row, { column: node.column, operator: node.operator, value: node.value });
}

export function projectColumns(row: Record<string, unknown>, columns?: string | string[]): Record<string, unknown> {
  if (!columns || columns === "*") return row;
  const list = Array.isArray(columns) ? columns : columns.split(",");
  const requested = list.map((item) => item.trim()).filter((item) => /^[a-z][a-z0-9_]*$/.test(item));
  if (!requested.length) return row;
  return Object.fromEntries(requested.filter((key) => key in row).map((key) => [key, row[key]]));
}
