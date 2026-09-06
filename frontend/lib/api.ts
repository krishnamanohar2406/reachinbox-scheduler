const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
}

export interface ScheduledEmail {
  id: string;
  recipient: string;
  subject: string;
  scheduled_time: string;
  status: string;
  sender_email: string;
}

export interface SentEmail {
  id: string;
  recipient: string;
  subject: string;
  sent_at: string | null;
  status: "sent" | "failed";
  sender_email: string;
}

export interface Sender {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("session_token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  loginWithGoogle: (idToken: string) =>
    request<{ token: string; user: User }>("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ idToken }),
    }),

  me: () => request<User>("/api/auth/me"),

  listSenders: () => request<Sender[]>("/api/senders"),
  createEtherealSender: (name: string) =>
    request<{ id: string; email: string }>("/api/senders/ethereal", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  listScheduled: () => request<ScheduledEmail[]>("/api/emails/scheduled"),
  listSent: () => request<SentEmail[]>("/api/emails/sent"),

  scheduleBatch: (formData: FormData) =>
    request<{ batchId: string; scheduled: number; skippedDuplicates: number }>("/api/emails/schedule", {
      method: "POST",
      body: formData,
    }),

  slackStatus: () => request<{ connected: boolean }>("/api/slack/status"),
  slackAuthorizeUrl: () => request<{ url: string }>("/api/slack/oauth/start"),
  slackDisconnect: () => request<{ ok: boolean }>("/api/slack/disconnect", { method: "POST" }),
};

export function saveSession(token: string) {
  window.localStorage.setItem("session_token", token);
}

export function clearSession() {
  window.localStorage.removeItem("session_token");
}

export function hasSession(): boolean {
  return !!getToken();
}
