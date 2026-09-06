import { Router } from "express";
import { env } from "../config/env";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { getSlackAuthorizeUrl, exchangeSlackCode, saveSlackIntegration, disconnectSlack, isSlackConnected } from "../services/slackService";

const router = Router();

/** Frontend redirects the browser here (with the user's session already known) to kick off real OAuth. */
router.get("/oauth/start", requireAuth, (req: AuthedRequest, res) => {
  const url = getSlackAuthorizeUrl(req.userId!);
  res.json({ url });
});

/** Slack redirects here after the user approves the app. `state` carries our userId. */
router.get("/oauth/callback", async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) return res.status(400).send("Missing code/state");

  try {
    const integration = await exchangeSlackCode(code);
    await saveSlackIntegration(state, integration);
    res.redirect(`${env.frontendUrl}/dashboard?slack=connected`);
  } catch (err) {
    console.error("[slack] oauth callback failed:", err);
    res.redirect(`${env.frontendUrl}/dashboard?slack=error`);
  }
});

router.get("/status", requireAuth, async (req: AuthedRequest, res) => {
  const connected = await isSlackConnected(req.userId!);
  res.json({ connected });
});

router.post("/disconnect", requireAuth, async (req: AuthedRequest, res) => {
  await disconnectSlack(req.userId!);
  res.json({ ok: true });
});

export default router;
