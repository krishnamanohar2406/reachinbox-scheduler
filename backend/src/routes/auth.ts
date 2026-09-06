import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env";
import { query } from "../config/db";
import { issueSessionToken, requireAuth, AuthedRequest } from "../middleware/auth";

const router = Router();
const googleClient = new OAuth2Client(env.googleClientId);

/**
 * Frontend performs the actual Google Sign-In (via @react-oauth/google or
 * NextAuth) and sends us the resulting Google ID token. We verify it
 * server-side, upsert the user, and issue our own session JWT.
 */
router.post("/google", async (req, res) => {
  const { idToken } = req.body as { idToken?: string };
  if (!idToken) return res.status(400).json({ error: "idToken is required" });

  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: env.googleClientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      return res.status(401).json({ error: "Invalid Google token" });
    }

    const rows = await query<{ id: string }>(
      `INSERT INTO users (google_sub, email, name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_sub) DO UPDATE SET
         email = EXCLUDED.email, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url
       RETURNING id`,
      [payload.sub, payload.email, payload.name ?? null, payload.picture ?? null]
    );

    const userId = rows[0].id;
    const sessionToken = issueSessionToken(userId);

    res.json({
      token: sessionToken,
      user: { id: userId, email: payload.email, name: payload.name, avatarUrl: payload.picture },
    });
  } catch (err) {
    console.error("[auth] google verification failed:", err);
    res.status(401).json({ error: "Google authentication failed" });
  }
});

router.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const rows = await query(`SELECT id, email, name, avatar_url FROM users WHERE id = $1`, [req.userId]);
  if (rows.length === 0) return res.status(404).json({ error: "User not found" });
  res.json(rows[0]);
});

export default router;
