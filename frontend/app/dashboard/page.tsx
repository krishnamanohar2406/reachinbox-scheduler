"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api, hasSession, ScheduledEmail, SentEmail, Sender, User } from "@/lib/api";
import Header from "@/components/Header";
import EmailTable, { EmailRow } from "@/components/EmailTable";
import ComposeModal from "@/components/ComposeModal";

type Tab = "scheduled" | "sent";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [tab, setTab] = useState<Tab>("scheduled");
  const [scheduled, setScheduled] = useState<ScheduledEmail[]>([]);
  const [sent, setSent] = useState<SentEmail[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [loading, setLoading] = useState(true);
  const [composeOpen, setComposeOpen] = useState(false);
  const [slackConnected, setSlackConnected] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [scheduledRows, sentRows, senderRows, slack] = await Promise.all([
        api.listScheduled(),
        api.listSent(),
        api.listSenders(),
        api.slackStatus(),
      ]);
      setScheduled(scheduledRows);
      setSent(sentRows);
      setSenders(senderRows);
      setSlackConnected(slack.connected);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hasSession()) {
      router.replace("/");
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => router.replace("/"));
    loadAll();
  }, [router, loadAll]);

  async function handleAddEtherealSender() {
    const name = prompt("Name this sender (e.g. 'Sales Outreach'):", "Sales Outreach");
    if (!name) return;
    await api.createEtherealSender(name);
    loadAll();
  }

  async function handleSlackConnect() {
    const { url } = await api.slackAuthorizeUrl();
    window.location.href = url;
  }

  const scheduledRows: EmailRow[] = scheduled.map((e) => ({
    id: e.id,
    recipient: e.recipient,
    subject: e.subject,
    status: e.status,
    sender_email: e.sender_email,
    dateLabel: "Scheduled time",
    dateValue: e.scheduled_time,
  }));

  const sentRows: EmailRow[] = sent.map((e) => ({
    id: e.id,
    recipient: e.recipient,
    subject: e.subject,
    status: e.status,
    sender_email: e.sender_email,
    dateLabel: "Sent time",
    dateValue: e.sent_at,
  }));

  return (
    <div className="min-h-screen bg-slate-50">
      <Header user={user} />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
            {(["scheduled", "sent"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-lg px-4 py-1.5 text-sm font-medium capitalize transition ${
                  tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {t} Emails
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={slackConnected ? undefined : handleSlackConnect}
              disabled={slackConnected}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              {slackConnected ? "✅ Slack Connected" : "Connect Slack"}
            </button>
            <button
              onClick={handleAddEtherealSender}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              + Add Sender
            </button>
            <button
              onClick={() => setComposeOpen(true)}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Compose New Email
            </button>
          </div>
        </div>

        {tab === "scheduled" ? (
          <EmailTable rows={scheduledRows} loading={loading} emptyMessage="No scheduled emails" dateColumnLabel="Scheduled time" />
        ) : (
          <EmailTable rows={sentRows} loading={loading} emptyMessage="No sent emails" dateColumnLabel="Sent time" />
        )}
      </main>

      {composeOpen && <ComposeModal senders={senders} onClose={() => setComposeOpen(false)} onScheduled={loadAll} />}
    </div>
  );
}
