import { env } from "../config/env";
import { query } from "../config/db";

export function getSlackAuthorizeUrl(userId: string): string {
  const params = new URLSearchParams({
    client_id: env.slackClientId,
    scope: "chat:write,incoming-webhook",
    redirect_uri: env.slackRedirectUri,
    state: userId, // ties the callback back to the logged-in user
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function exchangeSlackCode(code: string) {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.slackClientId,
      client_secret: env.slackClientSecret,
      code,
      redirect_uri: env.slackRedirectUri,
    }),
  });
  const data = (await res.json()) as any;
  if (!data.ok) {
    throw new Error(`Slack OAuth exchange failed: ${data.error}`);
  }
  return {
    teamId: data.team?.id as string,
    teamName: data.team?.name as string,
    accessToken: data.access_token as string,
    webhookUrl: data.incoming_webhook?.url as string | undefined,
    channelId: data.incoming_webhook?.channel_id as string | undefined,
  };
}

export async function saveSlackIntegration(userId: string, integration: Awaited<ReturnType<typeof exchangeSlackCode>>) {
  await query(
    `INSERT INTO slack_integrations (user_id, team_id, team_name, access_token, webhook_url, channel_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       team_id = EXCLUDED.team_id,
       team_name = EXCLUDED.team_name,
       access_token = EXCLUDED.access_token,
       webhook_url = EXCLUDED.webhook_url,
       channel_id = EXCLUDED.channel_id`,
    [userId, integration.teamId, integration.teamName, integration.accessToken, integration.webhookUrl, integration.channelId]
  );
}

interface SlackIntegrationRow {
  webhook_url: string | null;
  access_token: string;
  channel_id: string | null;
}

/**
 * Sends a live Slack notification the moment a sender's hourly rate limit
 * is hit. If the user hasn't connected Slack, this silently no-ops (no
 * crash) per the spec. If they connect later, it starts working immediately
 * since we look the integration up fresh from the DB on every call - no
 * redeploy needed.
 */
export async function notifyRateLimitHit(params: {
  userId: string;
  senderEmail: string;
  windowResetAt: number;
  limit: number;
}) {
  const rows = await query<SlackIntegrationRow>(
    `SELECT webhook_url, access_token, channel_id FROM slack_integrations WHERE user_id = $1`,
    [params.userId]
  );
  if (rows.length === 0) {
    // Not connected - no-op, no crash.
    return { sent: false, reason: "not_connected" as const };
  }

  const integration = rows[0];
  const resetTime = new Date(params.windowResetAt).toLocaleTimeString();
  const text = `:warning: *Rate limit reached* for sender \`${params.senderEmail}\`.\nHit the cap of ${params.limit} emails/hour. Remaining emails are being rescheduled for the next window (~${resetTime}).`;

  try {
    if (integration.webhook_url) {
      const res = await fetch(integration.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Slack webhook responded ${res.status}`);
    } else if (integration.channel_id) {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${integration.access_token}`,
        },
        body: JSON.stringify({ channel: integration.channel_id, text }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) throw new Error(`Slack chat.postMessage failed: ${data.error}`);
    } else {
      return { sent: false, reason: "no_destination" as const };
    }
    return { sent: true as const };
  } catch (err) {
    console.error("[slack] failed to send rate-limit notification:", err);
    return { sent: false, reason: "error" as const, error: String(err) };
  }
}

export async function disconnectSlack(userId: string) {
  await query(`DELETE FROM slack_integrations WHERE user_id = $1`, [userId]);
}

export async function isSlackConnected(userId: string): Promise<boolean> {
  const rows = await query(`SELECT 1 FROM slack_integrations WHERE user_id = $1`, [userId]);
  return rows.length > 0;
}
