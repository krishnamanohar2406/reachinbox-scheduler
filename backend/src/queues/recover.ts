import { query } from "../config/db";
import { emailQueue, scheduleEmailJob } from "./emailQueue";

interface PendingEmailRow {
  id: string;
  idempotency_key: string;
  scheduled_time: string;
  status: string;
}

/**
 * Runs on every server boot. BullMQ persists delayed jobs in Redis, so in
 * the common case (Redis survives, only the Node process restarted) jobs
 * are already safe and this is a no-op reconciliation pass.
 *
 * But we still defensively re-sync against the DB (source of truth) to
 * cover the edge case where Redis itself was flushed/restarted separately
 * from Postgres: any email still in 'scheduled' / 'processing' /
 * 'rescheduled' state that has NO corresponding BullMQ job gets re-queued.
 * Jobs are keyed by emailId (see emailQueue.ts), so re-adding an
 * already-existing job is a safe no-op - this is what prevents duplicate
 * sends after a restart.
 */
export async function reconcileQueueOnBoot() {
  const pending = await query<PendingEmailRow>(
    `SELECT id, idempotency_key, scheduled_time, status FROM emails
     WHERE status IN ('scheduled', 'processing', 'rescheduled')`
  );

  if (pending.length === 0) {
    console.log("[recover] no pending emails to reconcile");
    return;
  }

  let requeued = 0;
  for (const row of pending) {
    const existingJob = await emailQueue.getJob(row.id);
    if (existingJob) {
      // Job already present in Redis (e.g. Redis persisted through the
      // restart) - nothing to do, avoids duplicate scheduling.
      continue;
    }

    // 'processing' means the worker died mid-send with no confirmed 'sent'
    // status - safe to re-attempt since sendEmail + status update is only
    // considered successful after the DB write commits.
    await scheduleEmailJob({
      emailId: row.id,
      idempotencyKey: row.idempotency_key,
      sendAt: new Date(row.scheduled_time),
    });
    requeued++;
  }

  console.log(`[recover] reconciled ${pending.length} pending emails, re-queued ${requeued} missing jobs`);
}
