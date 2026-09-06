import { Router } from "express";
import multer from "multer";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { query, pool } from "../config/db";
import { scheduleEmailJob } from "../queues/emailQueue";
import { buildIdempotencyKey } from "../utils/idempotency";
import { searchEmails } from "../services/searchService";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function parseRecipientsFromCsv(buffer: Buffer): string[] {
  const text = buffer.toString("utf-8");
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) ?? [];
  return Array.from(new Set(matches.map((e) => e.toLowerCase().trim())));
}

/**
 * POST /api/emails/schedule
 * multipart/form-data: leadsFile (CSV/txt), subject, body, senderId,
 * startTime (ISO), delayBetweenMs, hourlyLimit
 *
 * Creates one `batches` row + one `emails` row per recipient, then enqueues
 * a delayed BullMQ job per email (staggered by delayBetweenMs so they don't
 * all fire at once, in addition to the worker-side rate limiter).
 */
router.post("/schedule", requireAuth, upload.single("leadsFile"), async (req: AuthedRequest, res) => {
  const { subject, body, senderId, startTime, delayBetweenMs, hourlyLimit } = req.body as Record<string, string>;

  if (!req.file) return res.status(400).json({ error: "leadsFile is required" });
  if (!subject || !body || !senderId || !startTime) {
    return res.status(400).json({ error: "subject, body, senderId, startTime are required" });
  }

  const recipients = parseRecipientsFromCsv(req.file.buffer);
  if (recipients.length === 0) {
    return res.status(400).json({ error: "No valid email addresses found in file" });
  }

  const senderCheck = await query(`SELECT id FROM senders WHERE id = $1 AND user_id = $2`, [senderId, req.userId]);
  if (senderCheck.length === 0) return res.status(404).json({ error: "Sender not found" });

  const delayMs = Number(delayBetweenMs ?? 2000);
  const start = new Date(startTime);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batchRows = await client.query<{ id: string }>(
      `INSERT INTO batches (user_id, subject, body, start_time, delay_between_ms, hourly_limit, total_recipients)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.userId, subject, body, start, delayMs, Number(hourlyLimit ?? 200), recipients.length]
    );
    const batchId = batchRows.rows[0].id;

    const created: { id: string; idempotencyKey: string; sendAt: Date }[] = [];

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const idempotencyKey = buildIdempotencyKey(batchId, recipient);
      // Stagger scheduled_time by index * delayBetweenMs to spread the load
      // as requested ("minimum delay between individual email sends").
      const sendAt = new Date(start.getTime() + i * delayMs);

      const emailRows = await client.query<{ id: string }>(
        `INSERT INTO emails (batch_id, user_id, sender_id, recipient, subject, body, scheduled_time, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [batchId, req.userId, senderId, recipient, subject, body, sendAt, idempotencyKey]
      );

      if (emailRows.rows[0]) {
        created.push({ id: emailRows.rows[0].id, idempotencyKey, sendAt });
      }
    }

    await client.query("COMMIT");

    // Enqueue jobs *after* commit so we never enqueue for a row that
    // ultimately didn't get persisted.
    for (const email of created) {
      await scheduleEmailJob({ emailId: email.id, idempotencyKey: email.idempotencyKey, sendAt: email.sendAt });
    }

    res.status(201).json({ batchId, scheduled: created.length, skippedDuplicates: recipients.length - created.length });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[emails] schedule failed:", err);
    res.status(500).json({ error: "Failed to schedule batch" });
  } finally {
    client.release();
  }
});

router.get("/scheduled", requireAuth, async (req: AuthedRequest, res) => {
  const rows = await query(
    `SELECT e.id, e.recipient, e.subject, e.scheduled_time, e.status, s.email AS sender_email
     FROM emails e JOIN senders s ON s.id = e.sender_id
     WHERE e.user_id = $1 AND e.status IN ('scheduled','processing','rescheduled')
     ORDER BY e.scheduled_time ASC`,
    [req.userId]
  );
  res.json(rows);
});

router.get("/sent", requireAuth, async (req: AuthedRequest, res) => {
  const rows = await query(
    `SELECT e.id, e.recipient, e.subject, e.sent_at, e.status, s.email AS sender_email
     FROM emails e JOIN senders s ON s.id = e.sender_id
     WHERE e.user_id = $1 AND e.status IN ('sent','failed')
     ORDER BY e.sent_at DESC NULLS LAST, e.updated_at DESC`,
    [req.userId]
  );
  res.json(rows);
});

/** GET /api/emails/search?q=...&status=sent — powered by Elasticsearch. */
router.get("/search", requireAuth, async (req: AuthedRequest, res) => {
  const { q, status } = req.query as { q?: string; status?: string };
  const results = await searchEmails({ userId: req.userId!, q, status });
  res.json(results);
});

export default router;
