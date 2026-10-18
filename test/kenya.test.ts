// Kenya: AfriRadar's CMA Kenya CSV (captured from afriradar.com, Dec 2023 to Mar 2026) into the API.
import { describe, expect, it, beforeAll } from "vitest";
import { ask, currencyGuard, type Llm, type LlmTurn, type ToolCall } from "../src/agent/ask.js";
import { ASK_PRICING, PRODUCTS } from "../src/catalog.js";
import type { Db } from "../src/db.js";
import * as kenya from "../src/data/kenya.js";
import { sqlite } from "../src/sqlite.js";
import { fixtureFetch, loadedDb } from "./helpers.js";

const HEAD = "quarter_ended,scheme,scheme_key,aum_kes,previous_quarter_aum_kes,change,market_share,source_url";
const ROW = "2026-03-31,Sanlam Unit Trust Scheme,sanlam,161017593553,144310234841,0.11577,0.18905,https://www.cma.or.ke/x.pdf";

let db: Db;
beforeAll(async () => { db = await loadedDb(); });

describe("parseKenya", () => {
  it("reads a row and leaves a new scheme's previous figure empty", () => {
    const [r, n] = kenya.parseKenya(`${HEAD}\n${ROW}\n2026-03-31,Jaza Unit Trust Fund,jaza,44106,,,0.0000518,https://www.cma.or.ke/x.pdf\n`);
    expect(r).toMatchObject({ key: "sanlam", quarter: "2026-03-31", aum_kes: 161017593553, prev_aum_kes: 144310234841 });
    expect([n.prev_aum_kes, n.change]).toEqual([null, null]);
  });
  it("rejects a malformed figure, a bad key and a duplicate scheme", () => {
    expect(() => kenya.parseKenya(`${HEAD}\n${ROW.replace("161017593553", "lots")}\n`)).toThrow(/aum_kes/);
    expect(() => kenya.parseKenya(`${HEAD}\n${ROW.replace(",sanlam,", ",Sanlam!,")}\n`)).toThrow(/bad scheme row/);
    expect(() => kenya.parseKenya(`${HEAD}\n${ROW}\n${ROW}\n`)).toThrow(/twice/);
  });
  it("re-ingesting the same file changes nothing", async () => {
    const fresh = sqlite();
    const a = await kenya.ingestKenya(fresh, { baseUrl: "https://afriradar.test", fetchImpl: fixtureFetch });
    await kenya.ingestKenya(fresh, { baseUrl: "https://afriradar.test", fetchImpl: fixtureFetch });
    expect((await fresh.first<{ n: number }>("SELECT count(*) AS n FROM kenya_quarters"))?.n).toBe(a.rows);
    expect(a.quarters).toHaveLength(10);
  });
});

describe("Kenya queries on real CMA data", () => {
  it("serves every scheme for March 2026, largest first", async () => {
    const k = await kenya.kenyaSchemes(db);
    expect(k.quarter).toBe("2026-03-31");
    expect(k.quarterLabel).toBe("quarter ended 31 March 2026");
    expect(k.schemes).toBe(43);
    expect(k.totalAumKes).toBe(851_708_510_287); // CMA prints 851,708,510,285: whole shillings rounded per row
    expect(k.rows[0]).toMatchObject({ id: "sanlam", aumKes: 161_017_593_553 });
    const apollo = k.rows.find((r) => r.id === "apollo");
    expect(apollo?.changeOnQuarter).toBeLessThan(0); // CMA printed this fall as "12.2%"
    expect(k.changeOnQuarter).toBeCloseTo(851_708_510_285 / 756_266_044_500 - 1, 6);
    // Ranked by the server: Jaza (+39.8%) comes before Arvocap (+38.7%), new schemes are left out.
    expect(k.fastestGrowing.map((r) => r.id)).toEqual(["faida", "cpf", "ziidi-shariah-money-market", "gulfcap", "jaza"]);
    expect(k.largest.map((r) => r.id)).toEqual(["sanlam", "standard-investment", "cic", "britam", "ncba"]);
  });
  it("keeps one history across a rename", async () => {
    const h = await kenya.kenyaScheme(db, "nabo-africa"); // "Nabo Capital Ltd" until Sep 2024
    expect(h?.quarters).toHaveLength(10);
    expect(h?.quarters[0]).toMatchObject({ quarter: "2023-12-31", name: "Nabo Capital Ltd" });
    expect(h?.name).toBe("Nabo Africa Funds");
    expect(await kenya.kenyaScheme(db, "no-such-scheme")).toBeNull();
  });
  it("free search and overview give ids and totals, not the table", async () => {
    expect(await kenya.searchKenya(db, "sanlam")).toEqual([{ id: "sanlam", name: "Sanlam Unit Trust Scheme", market: "kenya" }]);
    expect(await kenya.kenyaOverview(db)).toMatchObject({ quarter: "2026-03-31", schemes: 43, quartersOnFile: 10, firstQuarter: "2023-12-31" });
  });
});

describe("the analyst on Kenya", () => {
  const call = (name: string, args: object): ToolCall => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const turn = (toolCalls: ToolCall[], content: string | null = null): LlmTurn => ({ content, toolCalls, usage: { prompt: 1000, completion: 200 } });

  it("buys Kenya data at list price and only that", async () => {
    const turns = [
      turn([call("kenya_search", { query: "sanlam" }), call("kenya_unit_trusts", {})]),
      turn([], "Sanlam Unit Trust Scheme was the largest at KES 161.0bn at the end of March 2026."),
    ];
    let i = 0;
    const llm: Llm = async () => turns[i++];
    const r = await ask(db, llm, "Which Kenyan unit trust is the biggest?");
    expect(r.bill.data).toEqual([{ tool: "kenya_unit_trusts", args: {}, price: PRODUCTS.kenya.price }]);
    expect(r.bill.total).toBe(ASK_PRICING.base + PRODUCTS.kenya.price + Math.ceil((2400 * ASK_PRICING.perThousandTokens) / 1000));
  });

  it("never prints a naira sign on an answer built only from Kenyan data", async () => {
    const turns = [turn([call("kenya_unit_trusts", {})]), turn([], "The market held about ₦851.7 billion at the end of March 2026.")];
    let i = 0;
    const r = await ask(db, async () => turns[i++], "How big is the Kenyan unit trust market?");
    expect(r.answer).toBe("The market held about KES 851.7 billion at the end of March 2026.");
    expect(currencyGuard("₦6.67trn in money market funds", [{ tool: "top_funds" }])).toBe("₦6.67trn in money market funds");
  });

  it("does not bill a refused scheme id", async () => {
    const turns = [turn([call("kenya_scheme_history", { id: "../etc" })]), turn([], "No such scheme.")];
    let i = 0;
    const r = await ask(db, async () => turns[i++], "History of scheme ../etc?");
    expect(r.bill.data).toEqual([]);
  });
});
