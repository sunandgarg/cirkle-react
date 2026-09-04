import { describe, expect, it } from "vitest";
import { matchesFilter, matchesLogicNode, parseInValue, parseOrExpression, serializedQuerySchema } from "../src/data/query.js";
import { buildFilter } from "../src/services/data.js";

describe("Supabase-shaped query compatibility", () => {
  it("accepts expression-only OR filters", () => {
    const query = serializedQuerySchema.parse({
      table: "profiles", operation: "select",
      filters: [{ operator: "or", expression: "name.ilike.%sun%,headline.ilike.%founder%" }],
    });
    expect(parseOrExpression(query.filters[0]!.expression!)).toHaveLength(2);
  });

  it("supports parenthesized NOT IN filters", () => {
    const filter = serializedQuerySchema.parse({
      table: "posts", operation: "select",
      filters: [{ column: "id", operator: "not", value: "(first,second)", options: { operator: "in" } }],
    }).filters[0]!;
    expect(parseInValue(filter.value)).toEqual(["first", "second"]);
    expect(matchesFilter({ id: "third" }, filter)).toBe(true);
    expect(matchesFilter({ id: "first" }, filter)).toBe(false);
  });

  it("supports null-or-future expressions used by jobs", () => {
    const nodes = parseOrExpression("expires_at.is.null,expires_at.gt.2026-09-04T12:00:00.000Z");
    expect(nodes.some((node) => matchesLogicNode({ expires_at: null }, node))).toBe(true);
    expect(nodes.some((node) => matchesLogicNode({ expires_at: "2026-09-05T12:00:00.000Z" }, node))).toBe(true);
    expect(nodes.some((node) => matchesLogicNode({ expires_at: "2026-09-03T12:00:00.000Z" }, node))).toBe(false);
  });

  it("supports nested connection and cursor groups", () => {
    const pair = parseOrExpression("and(requester_id.eq.viewer,receiver_id.eq.profile),and(requester_id.eq.profile,receiver_id.eq.viewer)");
    expect(pair.some((node) => matchesLogicNode({ requester_id: "viewer", receiver_id: "profile" }, node))).toBe(true);
    expect(pair.some((node) => matchesLogicNode({ requester_id: "stranger", receiver_id: "profile" }, node))).toBe(false);

    const cursor = parseOrExpression("created_at.lt.2026-09-04T12:00:00.000Z,and(created_at.eq.2026-09-04T12:00:00.000Z,id.lt.0002)");
    expect(cursor.some((node) => matchesLogicNode({ created_at: "2026-09-04T12:00:00.000Z", id: "0001" }, node))).toBe(true);
    expect(cursor.some((node) => matchesLogicNode({ created_at: "2026-09-04T12:00:00.000Z", id: "0003" }, node))).toBe(false);
  });

  it("rejects nested predicates on non-allowlisted columns", () => {
    expect(() => buildFilter([
      { operator: "or", expression: "name.eq.safe,and(role.eq.owner,password_hash.neq.empty)" },
    ], ["name", "role"])).toThrowError(/password_hash/);
  });
});
