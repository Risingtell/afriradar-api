// The analyst's billing rules, driven by a scripted model so no AI credits are spent.
import { describe, expect, it, beforeAll } from "vitest";
import { ask, AskError, type Llm, type LlmTurn, type ToolCall } from "../src/agent/ask.js";
import { ASK_PRICING, PRODUCTS } from "../src/catalog.js";
import type { Db } from "../src/db.js";
import { loadedDb } from "./helpers.js";

const call = (name: string, args: object, id = name): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const scripted = (...turns: LlmTurn[]): Llm & { seen: number } => {
  const llm = (async () => {
    const t = turns[llm.seen++];
    if (!t) throw new Error("script ran out");
    return t;
  }) as unknown as Llm & { seen: number };
  llm.seen = 0;
  return llm;
};
const turn = (toolCalls: ToolCall[], content: string | null = null, prompt = 1000, completion = 200): LlmTurn => ({ content, toolCalls, usage: { prompt, completion } });

let db: Db;
beforeAll(async () => { db = await loadedDb(); });

describe("ask", () => {
  it("bills base + each dataset at list price + tokens, and answers", async () => {
    const llm = scripted(
      turn([call("search_funds", { query: "aiico" }), call("top_funds", { category: "money-market", by: "yield_ytd", limit: 3 })]),
      turn([], "First Ally Money Market Fund reported 21.29% for the week ended 2 October 2026."),
    );
    const r = await ask(db, llm, "Which money market fund pays the most?");
    expect(r.answer).toMatch(/First Ally/);
    expect(r.week).toBe("2026-10-02");
    expect(r.bill.data).toEqual([{ tool: "top_funds", args: { category: "money-market", by: "yield_ytd", limit: 3 }, price: PRODUCTS.top.price }]);
    const tokens = Math.ceil((2400 * ASK_PRICING.perThousandTokens) / 1000);
    expect(r.bill.tokens).toEqual({ prompt: 2000, completion: 400, price: tokens });
    expect(r.bill.total).toBe(ASK_PRICING.base + PRODUCTS.top.price + tokens);
  });

  it("refuses a tool call that would break the ceiling, and does not bill it", async () => {
    const llm = scripted(
      turn([call("fund_history", { id: "money-market/aiico-money-market-fund" })]),
      turn([], "Budget ran out before I could read the history."),
    );
    const r = await ask(db, llm, "Show me the AIICO history", { ceiling: 6_000 });
    expect(r.bill.data).toEqual([]);
    expect(r.bill.total).toBeLessThanOrEqual(6_000);
  });

  it("never bills a tool call that failed", async () => {
    const llm = scripted(
      turn([call("fund_detail", { id: "not a valid id" })]),
      turn([], "That fund id was not valid."),
    );
    const r = await ask(db, llm, "Tell me about a fund");
    expect(r.bill.data).toEqual([]);
  });

  it("caps the bill at the ceiling even if the model ran long", async () => {
    const llm = scripted(turn([], "Long answer", 200_000, 50_000));
    const r = await ask(db, llm, "Write me an essay", { ceiling: 50_000 });
    expect(r.bill.total).toBe(50_000);
  });

  it("an AI outage is an error (the payment is then cancelled), never a canned answer", async () => {
    const llm: Llm = async () => { throw new Error("model retired"); };
    await expect(ask(db, llm, "Which fund is best?")).rejects.toMatchObject({ status: 503 });
  });

  it("rejects an empty or oversized question before any AI call", async () => {
    const llm = scripted();
    await expect(ask(db, llm, "  ")).rejects.toBeInstanceOf(AskError);
    await expect(ask(db, llm, "x".repeat(501))).rejects.toBeInstanceOf(AskError);
    expect(llm.seen).toBe(0);
  });

  it("strips em dashes from the answer", async () => {
    const r = await ask(db, scripted(turn([], "Yields rose — slightly.")), "Did yields rise?");
    expect(r.answer).toBe("Yields rose, slightly.");
  });
});
