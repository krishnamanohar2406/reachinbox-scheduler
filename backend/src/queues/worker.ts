import "../config/env"; // ensure dotenv loads first
import { Worker, Job } from "bullmq";
import { redisConnection } from "../config/redis";
import { env } from "../config/env";
import { query, pool } from "../config/db";
import { EMAIL_QUEUE_NAME, EmailJobData, scheduleEmailJob } from "./emailQueue";
import { tryConsumeSendSlot } from "../services/rateLimiter";
import { sendEmail, SenderCreds } from "../services/emailService";
import { notifyRateLimitHit } from "../services/slackService";
import { indexEmail } from "../services/searchService";

interface EmailRow {
  id: string;
  batch_id: string;
  user_id: string;
  sender_id: string;
  recipient: string;
  subject: string;
  body: string;
  scheduled_time: string;
  status: string;
  idempotency_key: string;
  attempts: number;
}

interface SenderRow {
  id: string;
  email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_pass: string;
}

/**
 * Minimum delay between individual sends. We enforce this by having the
 * worker itself pace consumption per sender via a short redis lock, in
 * addition to BullMQ's own per-worker concurrency. This mimics real
 * provider throttling ("don't fire 50 emails in the same millisecond").
 */
async function enforceMinDelay(senderId: string) {
  const lockKey = `send-pace:${senderId}`;
  // SET NX PX = only one worker can "hold the pace slot" for this sender at a time.
  const acquired = await redisConnection.set(lockKey, "1", "PX", env.minDelayBetweenSendsMs, "NX");
  if (acquired) return;

  // Someone else just sent for this sender - wait out the remaining window,
  // then retry acquiring. Small poll loop, bounded.
  await new Promise((r) => setTimeout(r, env.minDelayBetweenSendsMs));
  await enforceMinDelay(senderId);
}

async function processEmailJob(job: Job<EmailJobData>) {
  const client = await pool.connect();
  try {
    // 1. Load the email row (source of truth). If it's already 'sent', this
    //    job is a duplicate re-run (e.g. after a crash mid-processing) -
    //    idempotency check, skip re-sending.
    const rows = await query<EmailRow>(`SELECT * FROM emails WHERE id = $1`, [job.data.emailId]);
    const email = rows[0];
    if (!email) {
      console.warn(`[worker] email ${job.data.emailId} not found, skipping (possibly deleted)`);
      return;
    }
    if (email.status === "sent") {
      console.log(`[worker] email ${email.id} already sent - idempotent skip`);
      return;
    }

    // 2. Mark as processing (best-effort visibility in the dashboard).
    await query(`UPDATE emails SET status = 'processing', updated_at = now() WHERE id = $1`, [email.id]);

    // 3. Rate limit check - atomic, Redis-backed, safe across workers.
    const limitResult = await tryConsumeSendSlot(email.sender_id);
    if (!limitResult.allowed) {
      // Do NOT drop or fail the job. Reschedule into the next hour window,
      // preserving relative order by keeping the same small offset.
      const nextAt = new Date(limitResult.nextAvailableAt!);
      await query(
        `UPDATE emails SET status = 'rescheduled', scheduled_time = $2, updated_at = now() WHERE id = $1`,
        [email.id, nextAt]
      );
      await scheduleEmailJob({ emailId: email.id, idempotencyKey: email.idempotency_key, sendAt: nextAt });

      const senderRows = await query<SenderRow>(`SELECT email FROM senders WHERE id = $1`, [email.sender_id]);
      await notifyRateLimitHit({
        userId: email.user_id,
        senderEmail: senderRows[0]?.email ?? email.sender_id,
        windowResetAt: limitResult.nextAvailableAt!,
        limit: env.maxEmailsPerHourPerSender,
      });

      console.log(`[worker] rate limit hit for sender ${email.sender_id}, rescheduled email ${email.id} to ${nextAt.toISOString()}`);
      return; // job "completes" here - the reschedule created a new job
    }

    // 4. Enforce minimum delay between sends for this sender (throttling).
    await enforceMinDelay(email.sender_id);

    // 5. Load sender creds and actually send via Ethereal SMTP.
    const senderRows = await query<SenderRow>(`SELECT * FROM senders WHERE id = $1`, [email.sender_id]);
    const sender = senderRows[0];
    if (!sender) throw new Error(`Sender ${email.sender_id} not found`);

    const creds: SenderCreds = {
      smtpHost: sender.smtp_host,
      smtpPort: sender.smtp_port,
      smtpUser: sender.smtp_user,
      smtpPass: sender.smtp_pass,
    };

    const { messageId, previewUrl } = await sendEmail({
      from: sender.email,
      to: email.recipient,
      subject: email.subject,
      html: email.body,
      creds,
    });

    // 6. Mark sent (idempotent: this UPDATE is what makes future duplicate
    //    job runs for this same emailId a no-op, per step 1's check).
    await query(
      `UPDATE emails SET status = 'sent', sent_at = now(), attempts = attempts + 1, updated_at = now() WHERE id = $1`,
      [email.id]
    );

    await indexEmail({
      id: email.id,
      userId: email.user_id,
      senderId: email.sender_id,
      recipient: email.recipient,
      subject: email.subject,
      body: email.body,
      status: "sent",
      scheduledTime: email.scheduled_time,
      sentAt: new Date().toISOString(),
    });

    console.log(`[worker] sent email ${email.id} -> ${email.recipient} (messageId=${messageId}) preview: ${previewUrl}`);
  } catch (err) {
    console.error(`[worker] failed to process email ${job.data.emailId}:`, err);
    await query(
      `UPDATE emails SET status = 'failed', attempts = attempts + 1, error_message = $2, updated_at = now() WHERE id = $1`,
      [job.data.emailId, String(err)]
    );
    throw err; // let BullMQ retry with backoff
  } finally {
    client.release();
  }
}

export const emailWorker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmailJob, {
  connection: redisConnection,
  concurrency: env.workerConcurrency, // configurable worker concurrency
});

emailWorker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

emailWorker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err.message);
});

console.log(`[worker] started with concurrency=${env.workerConcurrency}, minDelay=${env.minDelayBetweenSendsMs}ms, hourlyLimit=${env.maxEmailsPerHourPerSender}/sender`);
