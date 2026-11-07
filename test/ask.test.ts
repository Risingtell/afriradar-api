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
// A real reply from 7 Nov 2026: a misspelt tool call that Workers AI passed through as text.
const GARBLED = 'analysisWe need largest scheme and fastest-growing last quarter. Use tool Kenya unit trusts.<|end|><|start|>assistant to=functions Kenya unit trustscommentary{" }<|call|>';

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
    const r = await ask(db, scripted(turn([], "Yields rose \u2014 slightly.")), "Did yields rise?");
    expect(r.answer).toBe("Yields rose, slightly.");
    // A dash alone in a table cell is "none", so it stays a hyphen instead of becoming a comma.
    const t = await ask(db, scripted(turn([], "| Largest | Standard | \u2014 |\n| Fastest | Kibaba | \u2014 | \u2014 |")), "Which is largest?");
    expect(t.answer).toBe("| Largest | Standard | - |\n| Fastest | Kibaba | - | - |");
  });

  it("never shows or bills a garbled reply; it asks the same step again", async () => {
    const llm = scripted(
      turn([], GARBLED, 2400, 124),
      turn([call("top_funds", { category: "money-market", by: "yield_ytd", limit: 3 })]),
      turn([], "First Ally Money Market Fund reported 21.29% for the week ended 2 October 2026."),
    );
    const r = await ask(db, llm, "Which money market fund pays the most?");
    expect(llm.seen).toBe(3);
    expect(r.answer).toMatch(/^First Ally/);
    expect(r.steps).toBe(2);
    expect(r.bill.tokens).toMatchObject({ prompt: 2000, completion: 400 });
    expect(r.bill.data.map((d) => d.tool)).toEqual(["top_funds"]);
  });

  it("a model that keeps garbling fails the question (the payment is then cancelled)", async () => {
    const llm = scripted(turn([], GARBLED), turn([], GARBLED), turn([], GARBLED), turn([], "never reached"));
    await expect(ask(db, llm, "Which Kenyan unit trust scheme is the largest?")).rejects.toMatchObject({ status: 502 });
    expect(llm.seen).toBe(3);
  });
});

describe("garbled", () => {
  it("spots the model's raw transcript and leaves real answers alone", async () => {
    const { garbled } = await import("../src/agent/ask.js");
    expect(garbled(GARBLED)).toBe(true);
    expect(garbled("analysisThe user wants the largest fund.")).toBe(true);
    expect(garbled("Analysis: First Ally Money Market Fund leads with 21.30% year to date.")).toBe(false);
    expect(garbled("Sanlam is the largest scheme, calculated by AfriRadar from CMA figures.")).toBe(false);
    expect(garbled(null)).toBe(false);
  });
});

describe("tidy", () => {
  it("turns non-breaking hyphens and spaces into plain ones", async () => {
    const { tidy } = await import("../src/agent/ask.js");
    expect(tidy("2026\u201110\u201102 at 16.98\u202f%")).toBe("2026-10-02 at 16.98 %");
  });
});
