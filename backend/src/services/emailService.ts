import nodemailer, { Transporter } from "nodemailer";
import { env } from "../config/env";

// Cache one transporter per sender (keyed by smtp user) so we reuse connections.
const transporterCache = new Map<string, Transporter>();

export interface SenderCreds {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
}

function getTransporter(creds: SenderCreds): Transporter {
  const cacheKey = creds.smtpUser;
  const cached = transporterCache.get(cacheKey);
  if (cached) return cached;

  const transporter = nodemailer.createTransport({
    host: creds.smtpHost,
    port: creds.smtpPort,
    secure: false,
    auth: { user: creds.smtpUser, pass: creds.smtpPass },
  });

  transporterCache.set(cacheKey, transporter);
  return transporter;
}

/**
 * Creates a fresh Ethereal test account on the fly. Useful for local dev /
 * seeding senders without manually registering at ethereal.email.
 */
export async function createEtherealAccount() {
  const account = await nodemailer.createTestAccount();
  return {
    smtpHost: account.smtp.host,
    smtpPort: account.smtp.port,
    smtpUser: account.user,
    smtpPass: account.pass,
  };
}

export async function sendEmail(params: {
  from: string;
  to: string;
  subject: string;
  html: string;
  creds: SenderCreds;
}) {
  const transporter = getTransporter(params.creds);
  const info = await transporter.sendMail({
    from: params.from,
    to: params.to,
    subject: params.subject,
    html: params.html,
  });

  // Ethereal gives a preview URL - extremely useful for the demo video.
  const previewUrl = nodemailer.getTestMessageUrl(info) || undefined;
  return { messageId: info.messageId, previewUrl };
}
