import { Queue } from "bullmq";
import { redisConnection } from "../config/redis";

export const EMAIL_QUEUE_NAME = "email-send";

export interface EmailJobData {
  emailId: string; // primary key in `emails` table - single source of truth
  idempotencyKey: string;
}

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 3600 * 24 }, // keep 24h of history for the dashboard
    removeOnFail: false, // keep failures visible for debugging
  },
});

/**
 * Schedules a delayed BullMQ job for a given email row. We use the email's
 * DB id as the BullMQ jobId. BullMQ treats jobId as unique per queue, so
 * calling this twice for the same emailId is a safe no-op (idempotent) -
 * this is what protects us from double-scheduling on restart or retry.
 */
export async function scheduleEmailJob(params: { emailId: string; idempotencyKey: string; sendAt: Date }) {
  const delay = Math.max(0, params.sendAt.getTime() - Date.now());
  await emailQueue.add(
    "send",
    { emailId: params.emailId, idempotencyKey: params.idempotencyKey },
    {
      jobId: params.emailId, // <-- idempotency: same id = same job, BullMQ dedupes
      delay,
    }
  );
}
