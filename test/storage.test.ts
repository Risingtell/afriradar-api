// The facilitator's durable channel storage must follow the SDK's binding rules exactly.
import { describe, expect, it } from "vitest";
import type { Network } from "@x402/core/types";
import { InMemoryPaymentChannelStorage } from "@x402/svm/upto/facilitator";
import { D1ChannelStorage, D1PendingStore } from "../src/facilitator/storage.js";
import { sqlite } from "../src/sqlite.js";

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network;
const rec = (over: Partial<Parameters<D1ChannelStorage["recordOpen"]>[0]> = {}) => ({
  network: NET, channelId: "chan1", payTo: "treasury", tokenProgram: "tok", expiresAt: 100, lastActivityAt: 1000,
  receiverAuthorizer: "", callerIdentity: "", ...over,
});

// Run every rule against our D1 storage AND the SDK's own reference store, so they cannot drift apart.
describe.each([
  ["D1ChannelStorage", () => new D1ChannelStorage(sqlite())],
  ["InMemoryPaymentChannelStorage (reference)", () => new InMemoryPaymentChannelStorage()],
])("%s", (_name, make) => {
  it("first open creates the row and returns a revert token", async () => {
    const s = make();
    const w = await s.recordOpen(rec());
    expect(w.revertToken).not.toBe("");
    expect(await s.get(NET, "chan1")).toMatchObject({ payTo: "treasury", expiresAt: 100 });
  });

  it("a second open keeps the open facts, moves clocks forward only, and invalidates the first revert", async () => {
    const s = make();
    const first = await s.recordOpen(rec());
    const second = await s.recordOpen(rec({ payTo: "attacker", expiresAt: 50, lastActivityAt: 2000 }));
    expect(second.revertToken).toBe("");
    expect(await s.get(NET, "chan1")).toMatchObject({ payTo: "treasury", expiresAt: 100, lastActivityAt: 2000 });
    await s.revertOpen(first);
    expect(await s.get(NET, "chan1")).toBeDefined();
  });

  it("a conflicting caller identity leaves the row untouched", async () => {
    const s = make();
    await s.recordOpen(rec({ callerIdentity: "server-a" }));
    const w = await s.recordOpen(rec({ callerIdentity: "server-b", expiresAt: 999, lastActivityAt: 9999 }));
    expect(w.revertToken).toBe("");
    expect(w.record).toMatchObject({ callerIdentity: "server-a", expiresAt: 100, lastActivityAt: 1000 });
  });

  it("the creator can revert its own open", async () => {
    const s = make();
    const w = await s.recordOpen(rec());
    await s.revertOpen(w);
    expect(await s.get(NET, "chan1")).toBeUndefined();
  });

  it("recordActivity inserts missing rows and never rewinds clocks", async () => {
    const s = make();
    await s.recordActivity(rec({ channelId: "c2", lastActivityAt: 500 }));
    await s.recordActivity(rec({ channelId: "c2", lastActivityAt: 400 }));
    expect((await s.get(NET, "c2"))?.lastActivityAt).toBe(500);
    expect((await s.list(NET)).map((r) => r.channelId)).toEqual(["c2"]);
    await s.delete(NET, "c2");
    expect(await s.list(NET)).toEqual([]);
  });
});

describe("D1PendingStore", () => {
  it("stores, overwrites and deletes a pending signature", async () => {
    const p = new D1PendingStore(sqlite());
    expect(await p.get("k")).toBeUndefined();
    await p.set("k", "sig1");
    await p.set("k", "sig2");
    expect(await p.get("k")).toBe("sig2");
    await p.delete("k");
    expect(await p.get("k")).toBeUndefined();
  });

  it("expires entries after the TTL", async () => {
    const p = new D1PendingStore(sqlite(), -1);
    await p.set("k", "sig");
    expect(await p.get("k")).toBeUndefined();
  });
});
