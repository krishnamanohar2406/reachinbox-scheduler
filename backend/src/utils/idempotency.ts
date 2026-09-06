import crypto from "crypto";

/**
 * Deterministic idempotency key: same (batchId, recipient) always produces
 * the same key. Combined with the UNIQUE constraint on emails.idempotency_key,
 * this guarantees that re-submitting the same CSV/batch (e.g. a retried
 * frontend request) never creates duplicate email rows or duplicate sends.
 */
export function buildIdempotencyKey(batchId: string, recipient: string): string {
  return crypto.createHash("sha256").update(`${batchId}:${recipient.toLowerCase().trim()}`).digest("hex");
}
