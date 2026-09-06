import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { emailQueue } from "./emailQueue";

/**
 * Live, real-time queue visibility as required by the spec.
 * Mounted at /admin/queues on the Express app.
 */
export function createBullBoardRouter() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");

  createBullBoard({
    // Cast: @bull-board's BaseAdapter typing lags behind the installed
    // bullmq version's Job.progress type - functionally compatible at runtime.
    queues: [new BullMQAdapter(emailQueue) as any],
    serverAdapter,
  });

  return serverAdapter.getRouter();
}
