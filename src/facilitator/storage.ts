// Durable storage for the self-hosted facilitator, on the same Db seam (D1 in production).
// Each method is a single SQL statement where the SDK requires atomicity, so concurrent Worker
// isolates cannot both "create" one channel row.
import type { Network } from "@x402/core/types";
import type { PendingSettlementStore } from "@x402/core/facilitator";
import type { PaymentChannelStorage } from "@x402/svm/upto/facilitator";
import type { Db } from "../db.js";

type PaymentChannelRecord = Awaited<ReturnType<PaymentChannelStorage["get"]>> & {};
type PaymentChannelOpenWrite = Awaited<ReturnType<PaymentChannelStorage["recordOpen"]>>;

type Row = {
  network: string; channel_id: string; pay_to: string; token_program: string; expires_at: number;
  last_activity_at: number; receiver_authorizer: string; caller_identity: string; token: string;
};

const toRecord = (r: Row): PaymentChannelRecord => ({
  network: r.network as Network,
  channelId: r.channel_id,
  payTo: r.pay_to,
  tokenProgram: r.token_program,
  expiresAt: Number(r.expires_at),
  lastActivityAt: Number(r.last_activity_at),
  receiverAuthorizer: r.receiver_authorizer,
  callerIdentity: r.caller_identity,
});

const newToken = () => crypto.randomUUID();

export class D1ChannelStorage implements PaymentChannelStorage {
  constructor(private readonly db: Db) {}

  private row(network: string, channelId: string) {
    return this.db.first<Row>("SELECT * FROM channels WHERE network = ? AND channel_id = ?", network, channelId);
  }

  async recordOpen(rec: PaymentChannelRecord): Promise<PaymentChannelOpenWrite> {
    const token = newToken();
    const created = await this.db.run(
      `INSERT INTO channels (network, channel_id, pay_to, token_program, expires_at, last_activity_at, receiver_authorizer, caller_identity, token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (network, channel_id) DO NOTHING`,
      rec.network, rec.channelId, rec.payTo, rec.tokenProgram, rec.expiresAt, rec.lastActivityAt, rec.receiverAuthorizer, rec.callerIdentity, token,
    );
    if (created.changes === 1) return { record: rec, revertToken: token };
    // Existing row: a non-conflicting open moves the clocks forward and rotates the token, so the
    // original creator's revert no longer matches. A conflicting open (different non-empty binding)
    // changes nothing. Both cases return an empty token.
    await this.db.run(
      `UPDATE channels SET expires_at = max(expires_at, ?), last_activity_at = max(last_activity_at, ?), token = ?
       WHERE network = ? AND channel_id = ?
         AND (caller_identity = '' OR ? = '' OR caller_identity = ?)
         AND (receiver_authorizer = '' OR ? = '' OR receiver_authorizer = ?)`,
      rec.expiresAt, rec.lastActivityAt, newToken(), rec.network, rec.channelId,
      rec.callerIdentity, rec.callerIdentity, rec.receiverAuthorizer, rec.receiverAuthorizer,
    );
    const stored = await this.row(rec.network, rec.channelId);
    return { record: stored ? toRecord(stored) : rec, revertToken: "" };
  }

  async revertOpen(write: PaymentChannelOpenWrite): Promise<void> {
    if (!write.revertToken) return;
    await this.db.run("DELETE FROM channels WHERE network = ? AND channel_id = ? AND token = ?", write.record.network, write.record.channelId, write.revertToken);
  }

  async recordActivity(...records: PaymentChannelRecord[]): Promise<void> {
    await this.db.batch(
      records.map((r) => ({
        sql: `INSERT INTO channels (network, channel_id, pay_to, token_program, expires_at, last_activity_at, receiver_authorizer, caller_identity, token)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (network, channel_id) DO UPDATE SET
                expires_at = max(channels.expires_at, excluded.expires_at),
                last_activity_at = max(channels.last_activity_at, excluded.last_activity_at)`,
        params: [r.network, r.channelId, r.payTo, r.tokenProgram, r.expiresAt, r.lastActivityAt, r.receiverAuthorizer, r.callerIdentity, newToken()],
      })),
    );
  }

  async get(network: Network, channelId: string) {
    const r = await this.row(network, channelId);
    return r ? toRecord(r) : undefined;
  }

  async list(network: Network) {
    return (await this.db.all<Row>("SELECT * FROM channels WHERE network = ?", network)).map(toRecord);
  }

  async delete(network: Network, channelId: string) {
    await this.db.run("DELETE FROM channels WHERE network = ? AND channel_id = ?", network, channelId);
  }
}

/** Broadcast-but-unconfirmed settlements, so a retry on another isolate reconciles instead of re-broadcasting. */
export class D1PendingStore implements PendingSettlementStore {
  constructor(private readonly db: Db, private readonly ttlMs = 10 * 60_000) {}

  async get(key: string) {
    const r = await this.db.first<{ v: string; updated_at: string }>("SELECT v, updated_at FROM kv WHERE ns = 'pending' AND k = ?", key);
    if (!r) return undefined;
    if (Date.now() - Date.parse(r.updated_at) > this.ttlMs) {
      await this.delete(key);
      return undefined;
    }
    return r.v;
  }

  async set(key: string, txHash: string) {
    await this.db.run(
      "INSERT INTO kv (ns, k, v, updated_at) VALUES ('pending', ?, ?, ?) ON CONFLICT (ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at",
      key, txHash, new Date().toISOString(),
    );
  }

  async delete(key: string) {
    await this.db.run("DELETE FROM kv WHERE ns = 'pending' AND k = ?", key);
  }
}
