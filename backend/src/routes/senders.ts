import { Router } from "express";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { query } from "../config/db";
import { createEtherealAccount } from "../services/emailService";

const router = Router();

router.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const rows = await query(`SELECT id, name, email, created_at FROM senders WHERE user_id = $1 ORDER BY created_at DESC`, [req.userId]);
  res.json(rows);
});

/**
 * Convenience endpoint: spins up a brand new Ethereal test mailbox and
 * registers it as a sender for this user. Lets you demo "multiple senders"
 * without manually creating accounts at ethereal.email.
 */
router.post("/ethereal", requireAuth, async (req: AuthedRequest, res) => {
  const { name } = req.body as { name?: string };
  const account = await createEtherealAccount();

  const rows = await query<{ id: string }>(
    `INSERT INTO senders (user_id, name, email, smtp_host, smtp_port, smtp_user, smtp_pass)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [req.userId, name ?? "Ethereal Sender", account.smtpUser, account.smtpHost, account.smtpPort, account.smtpUser, account.smtpPass]
  );

  res.status(201).json({ id: rows[0].id, email: account.smtpUser });
});

router.delete("/:id", requireAuth, async (req: AuthedRequest, res) => {
  await query(`DELETE FROM senders WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
  res.json({ ok: true });
});

export default router;
