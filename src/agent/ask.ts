// The AfriRadar analyst behind POST /v1/ask. An LLM answers a question by calling the same data
// products the API sells, each at its list price, inside the ceiling the buyer authorized on chain.
// The bill it returns is what gets settled: base fee + data read + AI tokens, never above the ceiling.
import { ASK_PRICING, PRODUCTS } from "../catalog.js";
import type { Db } from "../db.js";
import { CATEGORIES, isCategory } from "../data/model.js";
import * as kenya from "../data/kenya.js";
import * as q from "../data/queries.js";

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type LlmTurn = { content: string | null; toolCalls: ToolCall[]; usage: { prompt: number; completion: number } };
export type Llm = (messages: ChatMessage[], tools: ToolSpec[]) => Promise<LlmTurn>;
type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: object } };

export class AskError extends Error {
  constructor(message: string, readonly status: 400 | 502 | 503) {
    super(message);
  }
}

const categoryEnum = Object.keys(CATEGORIES);
const idParam = { type: "string", description: "Fund id like money-market/aiico-money-market-fund (from search_funds)" };

type Tool = { price: number; spec: ToolSpec; run: (db: Db, args: Record<string, unknown>) => Promise<unknown> };

const slim = (f: q.Fund) => ({ id: f.id, name: f.name, manager: f.manager, yieldYtd: f.yieldYtd, yieldWtd: f.yieldWtd, navNgn: f.navNgn, navUsd: f.navUsd, unitholders: f.unitholders });
const needCategory = (v: unknown) => {
  if (!isCategory(v)) throw new Error(`category must be one of ${categoryEnum.join(", ")}`);
  return v;
};
const needId = (v: unknown) => {
  if (typeof v !== "string" || !/^[a-z-]+\/[a-z0-9-]+$/.test(v)) throw new Error("id must look like category/slug");
  return v;
};

const TOOLS: Record<string, Tool> = {
  overview: {
    price: 0,
    spec: { type: "function", function: { name: "overview", description: "Free. Latest SEC week, and per category: fund count, total NAV, unitholders, median YTD yield.", parameters: { type: "object", properties: {} } } },
    run: (db) => q.overview(db),
  },
  search_funds: {
    price: 0,
    spec: { type: "function", function: { name: "search_funds", description: "Free. Find fund ids by name or manager words.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    run: (db, a) => q.search(db, String(a.query ?? ""), 10),
  },
  top_funds: {
    price: PRODUCTS.top.price,
    spec: { type: "function", function: { name: "top_funds", description: `Costs ${PRODUCTS.top.price} micro-USDC. Rank a category's funds for the latest week.`, parameters: { type: "object", properties: { category: { type: "string", enum: categoryEnum }, by: { type: "string", enum: Object.keys(q.RANK_BY) }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["category", "by"] } } },
    run: async (db, a) => {
      const by = String(a.by) as q.RankBy;
      if (!(by in q.RANK_BY)) throw new Error("by must be yield_ytd, yield_wtd, nav or unitholders");
      const t = await q.top(db, needCategory(a.category), by, Math.min(Number(a.limit) || 10, 20));
      return { ...t, funds: t.funds.map(slim) };
    },
  },
  category_funds: {
    price: PRODUCTS.category.price,
    spec: { type: "function", function: { name: "category_funds", description: `Costs ${PRODUCTS.category.price} micro-USDC. Every fund in a category for the latest week.`, parameters: { type: "object", properties: { category: { type: "string", enum: categoryEnum } }, required: ["category"] } } },
    run: async (db, a) => {
      const c = await q.category(db, needCategory(a.category));
      return { ...c, funds: c.funds.map(slim) };
    },
  },
  fund_detail: {
    price: PRODUCTS.fund.price,
    spec: { type: "function", function: { name: "fund_detail", description: `Costs ${PRODUCTS.fund.price} micro-USDC. One fund's latest figures and last 13 weeks.`, parameters: { type: "object", properties: { id: idParam }, required: ["id"] } } },
    run: async (db, a) => (await q.fund(db, needId(a.id))) ?? { error: "no such fund" },
  },
  fund_history: {
    price: PRODUCTS.history.price,
    spec: { type: "function", function: { name: "fund_history", description: `Costs ${PRODUCTS.history.price} micro-USDC. One fund's full weekly history since Jan 2025 (yield and NAV).`, parameters: { type: "object", properties: { id: idParam }, required: ["id"] } } },
    run: async (db, a) => {
      const h = await q.history(db, needId(a.id));
      if (!h) return { error: "no such fund" };
      return { ...h, weeks: h.weeks.map((w) => ({ week: w.week, yieldYtd: w.yieldYtd, yieldWtd: w.yieldWtd, navNgn: w.navNgn })) };
    },
  },
  compare_funds: {
    price: PRODUCTS.compare.price,
    spec: { type: "function", function: { name: "compare_funds", description: `Costs ${PRODUCTS.compare.price} micro-USDC. Up to 5 funds side by side with 4 and 13 week changes.`, parameters: { type: "object", properties: { ids: { type: "array", items: idParam, maxItems: 5 } }, required: ["ids"] } } },
    run: (db, a) => q.compare(db, (Array.isArray(a.ids) ? a.ids : []).map(needId)),
  },
  kenya_overview: {
    price: 0,
    spec: { type: "function", function: { name: "kenya_overview", description: "Free. Kenya: latest CMA quarter, number of unit trust schemes and their total assets in KES.", parameters: { type: "object", properties: {} } } },
    run: (db) => kenya.kenyaOverview(db),
  },
  kenya_search: {
    price: 0,
    spec: { type: "function", function: { name: "kenya_search", description: "Free. Find Kenyan unit trust scheme ids by name words.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    run: (db, a) => kenya.searchKenya(db, String(a.query ?? ""), 10),
  },
  kenya_unit_trusts: {
    price: PRODUCTS.kenya.price,
    spec: { type: "function", function: { name: "kenya_unit_trusts", description: `Costs ${PRODUCTS.kenya.price} micro-USDC. Kenya: every unit trust scheme for the latest CMA quarter with assets (KES), change on the quarter and market share.`, parameters: { type: "object", properties: {} } } },
    // The bulletin's web address carries CMA's own issue name ("q2-2026" for the March 2026 quarter),
    // which led the model to call the quarter "Q2". The analyst gets the data without it.
    run: async (db) => ({ ...(await kenya.kenyaSchemes(db)), source: "CMA Kenya quarterly statistical bulletin" }),
  },
  kenya_scheme_history: {
    price: PRODUCTS.kenyaScheme.price,
    spec: { type: "function", function: { name: "kenya_scheme_history", description: `Costs ${PRODUCTS.kenyaScheme.price} micro-USDC. Kenya: one unit trust scheme's quarterly assets since December 2023.`, parameters: { type: "object", properties: { id: { type: "string", description: "Scheme id like sanlam (from kenya_search)" } }, required: ["id"] } } },
    run: async (db, a) => {
      const id = String(a.id ?? "");
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error("id must be a scheme id like sanlam");
      const h = await kenya.kenyaScheme(db, id);
      if (!h) return { error: "no such scheme" };
      return { ...h, quarters: h.quarters.map(({ source: _s, ...q }) => ({ ...q, quarterLabel: kenya.quarterLabel(q.quarter) })) };
    },
  },
};

const SYSTEM = `You are AfriRadar's fund analyst. You answer questions about African investment funds using only the data your tools return: SEC Nigeria's weekly NAV report for Nigerian collective investment schemes, and CMA Kenya's quarterly statistical bulletin for Kenyan unit trust schemes.
Rules:
- Every number you state must come from a tool result in this conversation. Never guess or use outside knowledge for figures.
- Yields are decimals: 0.2129 means 21.29%. yieldYtd is the year-to-date yield the manager reported, yieldWtd the week-to-date one.
- Kenya data is quarterly assets under management per scheme (a manager's umbrella of funds), in Kenya shillings (KES). It has no yields or prices; never present a Kenyan figure as a yield. changeOnQuarter and marketShare are decimals too; AfriRadar works out changeOnQuarter from the two figures CMA prints.
- For "fastest growing" or "largest" Kenyan schemes, use the fastestGrowing and largest lists the data already ranks; never re-rank the rows yourself.
- CMA publishes only each Kenyan scheme's assets for this quarter and the one before. Growth figures, rankings, totals and market shares are AfriRadar's calculations from those figures: say "calculated by AfriRadar from CMA figures", never that CMA lists, ranks or reports them.
- Name every Kenya quarter by its end date only, as in quarterLabel: write "quarter ended 31 March 2026", and in table headings "AUM, 31 Mar 2026". No quarter numbers.
- Nigerian figures are in naira (NGN, ₦) unless a field says USD. Kenyan figures are in Kenya shillings: write KES, never ₦. Never add or compare naira and shilling amounts directly.
- Say which SEC week or CMA quarter the figures are for.
- Tools cost money from the user's budget. Use free tools (overview, search_funds, kenya_overview, kenya_search) to plan, then buy only the data you need. Do not buy the same data twice.
- If the data cannot answer the question, say so plainly.
- This is data, not investment advice. Do not tell anyone to buy or sell.
- Plain English, short paragraphs, no em dashes.`;

export type AskBill = {
  ceiling: number;
  base: number;
  data: { tool: string; args: Record<string, unknown>; price: number }[];
  tokens: { prompt: number; completion: number; price: number };
  total: number;
};

export type AskResult = { answer: string; week: string | null; bill: AskBill; steps: number };

/** House style for model output: no em or en dashes; plain hyphens and spaces instead of their non-breaking twins. */
export const tidy = (s: string) =>
  s
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/[\u00a0\u202f]/g, " ");

/**
 * The model has written "₦851.7 billion" for a Kenyan total. When every dataset it bought was Kenyan,
 * a naira sign can only be wrong, so it becomes KES. Answers that used Nigerian data are left alone.
 */
export const currencyGuard = (answer: string, data: { tool: string }[]) =>
  data.length && data.every((d) => d.tool.startsWith("kenya_")) ? answer.replace(/₦\s?/g, "KES ") : answer;

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * CMA names its bulletins by the quarter they come out in, so the model has written "Q2 2026" for the
 * quarter ended 31 March 2026. In an answer built only from Kenyan data, a "Qn YYYY" that ends after the
 * latest quarter we hold can only be CMA's naming, so it is rewritten as the end date of the quarter
 * before. Anything else is left alone.
 */
export const quarterGuard = (answer: string, data: { tool: string }[], latest: string | null) => {
  if (!latest || !data.length || !data.every((d) => d.tool.startsWith("kenya_"))) return answer;
  return answer.replace(/\bQ([1-4])\s?(20\d\d)\b/g, (whole, n: string, y: string) => {
    const calendarEnd = `${y}-${String(Number(n) * 3).padStart(2, "0")}`;
    if (calendarEnd <= latest.slice(0, 7)) return whole;
    let year = Number(y);
    let month = Number(n) * 3 - 3;
    if (month === 0) { year -= 1; month = 12; }
    return `${new Date(Date.UTC(year, month, 0)).getUTCDate()} ${MONTHS_SHORT[month - 1]} ${year}`;
  });
};

const tokenPrice = (prompt: number, completion: number) => Math.ceil(((prompt + completion) * ASK_PRICING.perThousandTokens) / 1000);

/** The question rule, also checked before a paid request opens a payment channel. */
export const questionProblem = (question: string): string | null => {
  const n = question.trim().length;
  return n < 3 || n > 500 ? "question must be 3 to 500 characters" : null;
};

export async function ask(db: Db, llm: Llm, question: string, opts: { ceiling?: number; maxSteps?: number } = {}): Promise<AskResult> {
  const text = question.trim();
  const problem = questionProblem(text);
  if (problem) throw new AskError(problem, 400);
  const ceiling = opts.ceiling ?? PRODUCTS.ask.price;
  const maxSteps = opts.maxSteps ?? 5;
  const bill: AskBill = { ceiling, base: ASK_PRICING.base, data: [], tokens: { prompt: 0, completion: 0, price: 0 }, total: ASK_PRICING.base };
  const recompute = () => {
    bill.tokens.price = tokenPrice(bill.tokens.prompt, bill.tokens.completion);
    bill.total = bill.base + bill.data.reduce((a, d) => a + d.price, 0) + bill.tokens.price;
  };
  // Keep room for the final answer's tokens so the bill never needs to exceed the ceiling.
  const reserve = tokenPrice(4000, 1200);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: text },
  ];
  const specs = Object.values(TOOLS).map((t) => t.spec);

  for (let step = 1; step <= maxSteps + 1; step++) {
    const last = step > maxSteps;
    let turn: LlmTurn;
    try {
      turn = await llm(messages, last ? [] : specs);
    } catch (e) {
      throw new AskError(`AI model unavailable: ${e instanceof Error ? e.message : String(e)}`, 503);
    }
    bill.tokens.prompt += turn.usage.prompt;
    bill.tokens.completion += turn.usage.completion;
    recompute();
    if (!turn.toolCalls.length) {
      const answer = (turn.content ?? "").trim();
      if (!answer) throw new AskError("AI model returned an empty answer", 502);
      if (bill.total > ceiling) bill.total = ceiling; // the channel would refuse more; never ask for it
      return { answer: quarterGuard(currencyGuard(tidy(answer), bill.data), bill.data, await kenya.latestQuarter(db)), week: await q.latestWeek(db), bill, steps: step };
    }
    messages.push({ role: "assistant", content: turn.content ?? "", tool_calls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      const tool = TOOLS[call.function.name];
      let result: unknown;
      if (!tool) result = { error: `unknown tool ${call.function.name}` };
      else if (bill.total + tool.price + reserve > ceiling) result = { error: "Budget exhausted for this question. Answer with the data you already have." };
      else {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          result = await tool.run(db, args);
          if (tool.price) bill.data.push({ tool: call.function.name, args, price: tool.price });
          recompute();
        } catch (e) {
          result = { error: e instanceof Error ? e.message : String(e) }; // a refused call is never billed
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new AskError("AI model did not finish", 502);
}

/** Adapter for Cloudflare Workers AI (OpenAI-style chat with tools). */
export function workersAi(ai: { run: (model: string, input: object) => Promise<unknown> }, model = "@cf/openai/gpt-oss-120b"): Llm {
  return async (messages, tools) => {
    const out = (await ai.run(model, { messages, ...(tools.length ? { tools } : {}), max_tokens: 1200, temperature: 0.2 })) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
      response?: string;
      tool_calls?: { name: string; arguments: unknown }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = out.choices?.[0]?.message;
    const toolCalls: ToolCall[] = msg?.tool_calls
      ?? (out.tool_calls ?? []).map((t, i) => ({ id: `call_${i}`, type: "function" as const, function: { name: t.name, arguments: typeof t.arguments === "string" ? t.arguments : JSON.stringify(t.arguments ?? {}) } }));
    return {
      content: msg?.content ?? out.response ?? null,
      toolCalls,
      usage: { prompt: out.usage?.prompt_tokens ?? 0, completion: out.usage?.completion_tokens ?? 0 },
    };
  };
}
