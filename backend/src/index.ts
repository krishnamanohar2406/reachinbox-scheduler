import express from "express";
import cors from "cors";
import { env } from "./config/env";
import { createBullBoardRouter } from "./queues/bullBoard";
import { reconcileQueueOnBoot } from "./queues/recover";
import { ensureIndex } from "./services/searchService";

import authRoutes from "./routes/auth";
import senderRoutes from "./routes/senders";
import emailRoutes from "./routes/emails";
import slackRoutes from "./routes/slack";

async function main() {
  // 1. Reconcile any pending emails against the queue BEFORE accepting new
  //    traffic - this is what guarantees "future emails still send" and
  //    "not duplicated" after a restart.
  await reconcileQueueOnBoot();

  // 2. Make sure the Elasticsearch index exists.
  try {
    await ensureIndex();
  } catch (err) {
    console.warn("[startup] Elasticsearch not reachable yet - search will be degraded until it is:", (err as Error).message);
  }

  const app = express();
  app.use(cors({ origin: env.frontendUrl }));
  app.use(express.json());

  // Live BullMQ dashboard, required by the spec.
  app.use("/admin/queues", createBullBoardRouter());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRoutes);
  app.use("/api/senders", senderRoutes);
  app.use("/api/emails", emailRoutes);
  app.use("/api/slack", slackRoutes);

  app.listen(env.port, () => {
    console.log(`[server] listening on http://localhost:${env.port}`);
    console.log(`[server] BullMQ dashboard: http://localhost:${env.port}/admin/queues`);
  });
}

main().catch((err) => {
  console.error("[startup] fatal error:", err);
  process.exit(1);
});
