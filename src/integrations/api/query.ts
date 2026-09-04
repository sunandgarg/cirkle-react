import { ApiError, type ApiResult } from "./types";
import { apiRequest } from "./http";

type QueryOperation = "select" | "insert" | "update" | "upsert" | "delete";

type QueryFilter = {
  column?: string;
  operator: string;
  value?: unknown;
  expression?: string;
  options?: Record<string, unknown>;
};

type QueryOrder = {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
  foreignTable?: string;
};

export interface SerializedDataQuery {
  table: string;
  operation: QueryOperation;
  columns?: string;
  values?: unknown;
  filters: QueryFilter[];
  order: QueryOrder[];
  limit?: number;
  range?: { from: number; to: number };
  cardinality?: "single" | "maybeSingle";
  options?: Record<string, unknown>;
}

const asResult = <T>(result: ApiResult<unknown>, cardinality?: "single" | "maybeSingle"): ApiResult<T> => {
  if (result.error || !cardinality || !Array.isArray(result.data)) return result as ApiResult<T>;
  if (result.data.length === 1) return { ...result, data: result.data[0] as T };
  if (cardinality === "maybeSingle" && result.data.length === 0) return { ...result, data: null as T };
  return {
    ...result,
    data: null,
    error: new ApiError(cardinality === "single"
      ? "JSON object requested, but the result did not contain exactly one row"
      : "JSON object requested, but the result contained more than one row", {
      code: "PGRST116",
      status: 406,
      details: `The result contains ${result.data.length} rows`,
    }),
  };
};

export class ApiQueryBuilder<T = any> implements PromiseLike<ApiResult<T>> {
  private readonly query: SerializedDataQuery;
  private execution?: Promise<ApiResult<T>>;

  constructor(table: string) {
    this.query = { table, operation: "select", columns: "*", filters: [], order: [] };
  }

  select(columns = "*", options: Record<string, unknown> = {}): this {
    this.query.columns = columns;
    this.query.options = { ...this.query.options, ...options };
    return this;
  }

  insert(values: unknown, options: Record<string, unknown> = {}): this {
    this.query.operation = "insert";
    this.query.values = values;
    this.query.columns = undefined;
    this.query.options = { ...this.query.options, ...options };
    return this;
  }

  update(values: unknown, options: Record<string, unknown> = {}): this {
    this.query.operation = "update";
    this.query.values = values;
    this.query.columns = undefined;
    this.query.options = { ...this.query.options, ...options };
    return this;
  }

  upsert(values: unknown, options: Record<string, unknown> = {}): this {
    this.query.operation = "upsert";
    this.query.values = values;
    this.query.columns = undefined;
    this.query.options = { ...this.query.options, ...options };
    return this;
  }

  delete(options: Record<string, unknown> = {}): this {
    this.query.operation = "delete";
    this.query.values = undefined;
    this.query.columns = undefined;
    this.query.options = { ...this.query.options, ...options };
    return this;
  }

  private addFilter(operator: string, column: string, value?: unknown, options?: Record<string, unknown>): this {
    this.query.filters.push({ operator, column, value, ...(options ? { options } : {}) });
    return this;
  }

  eq(column: string, value: unknown): this { return this.addFilter("eq", column, value); }
  neq(column: string, value: unknown): this { return this.addFilter("neq", column, value); }
  gt(column: string, value: unknown): this { return this.addFilter("gt", column, value); }
  gte(column: string, value: unknown): this { return this.addFilter("gte", column, value); }
  lt(column: string, value: unknown): this { return this.addFilter("lt", column, value); }
  lte(column: string, value: unknown): this { return this.addFilter("lte", column, value); }
  like(column: string, value: string): this { return this.addFilter("like", column, value); }
  ilike(column: string, value: string): this { return this.addFilter("ilike", column, value); }
  is(column: string, value: unknown): this { return this.addFilter("is", column, value); }
  in(column: string, values: readonly unknown[]): this { return this.addFilter("in", column, [...values]); }
  contains(column: string, value: unknown): this { return this.addFilter("contains", column, value); }
  containedBy(column: string, value: unknown): this { return this.addFilter("containedBy", column, value); }
  overlaps(column: string, value: unknown): this { return this.addFilter("overlaps", column, value); }
  filter(column: string, operator: string, value: unknown): this { return this.addFilter(operator, column, value); }
  textSearch(column: string, value: string, options: Record<string, unknown> = {}): this {
    return this.addFilter("textSearch", column, value, options);
  }

  not(column: string, operator: string, value: unknown): this {
    this.query.filters.push({ operator: "not", column, value, options: { operator } });
    return this;
  }

  or(expression: string, options: Record<string, unknown> = {}): this {
    this.query.filters.push({ operator: "or", expression, options });
    return this;
  }

  match(values: Record<string, unknown>): this {
    Object.entries(values).forEach(([column, value]) => this.eq(column, value));
    return this;
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string; referencedTable?: string } = {}): this {
    this.query.order.push({
      column,
      ascending: options.ascending !== false,
      ...(options.nullsFirst === undefined ? {} : { nullsFirst: options.nullsFirst }),
      ...((options.foreignTable || options.referencedTable) ? { foreignTable: options.foreignTable || options.referencedTable } : {}),
    });
    return this;
  }

  limit(count: number, options: { foreignTable?: string; referencedTable?: string } = {}): this {
    this.query.limit = count;
    if (options.foreignTable || options.referencedTable) {
      this.query.options = { ...this.query.options, limitForeignTable: options.foreignTable || options.referencedTable };
    }
    return this;
  }

  range(from: number, to: number, options: { foreignTable?: string; referencedTable?: string } = {}): this {
    this.query.range = { from, to };
    if (options.foreignTable || options.referencedTable) {
      this.query.options = { ...this.query.options, rangeForeignTable: options.foreignTable || options.referencedTable };
    }
    return this;
  }

  single(): this {
    this.query.cardinality = "single";
    return this;
  }

  maybeSingle(): this {
    this.query.cardinality = "maybeSingle";
    return this;
  }

  returns<Result>(): ApiQueryBuilder<Result> {
    return this as unknown as ApiQueryBuilder<Result>;
  }

  private execute(): Promise<ApiResult<T>> {
    if (!this.execution) {
      const snapshot = JSON.parse(JSON.stringify(this.query)) as SerializedDataQuery;
      this.execution = apiRequest<unknown>("data/query", { method: "POST", body: snapshot })
        .then((result) => asResult<T>(result, snapshot.cardinality));
    }
    return this.execution;
  }

  then<TResult1 = ApiResult<T>, TResult2 = never>(
    onfulfilled?: ((value: ApiResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}
