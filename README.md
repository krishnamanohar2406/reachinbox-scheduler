# ReachInbox — Full-Stack Email Job Scheduler

A production-grade email scheduling service + dashboard, built for the ReachInbox
Software Development Intern assignment. Schedules emails at scale using **BullMQ +
Redis** (no cron), sends via **Ethereal** fake SMTP, indexes everything in
**Elasticsearch**, and survives server restarts without losing or duplicating jobs.

---

## 1. Stack

| Layer      | Tech |
|------------|------|
| Backend    | Node.js, TypeScript, Express |
| Queue      | BullMQ (Redis-backed, delayed jobs — no cron) |
| Database   | PostgreSQL |
| Search     | Elasticsearch |
| SMTP       | Ethereal Email (fake SMTP, multi-sender) |
| Auth       | Google OAuth (real), JWT sessions |
| Alerts     | Slack OAuth + live webhook/API notifications |
| Frontend   | Next.js (App Router), TypeScript, Tailwind CSS |
| Dashboard  | Bull-Board (live BullMQ queue visibility) |

---

## 2. Quick Start

### 2.1 Infra (Redis, Postgres, Elasticsearch) via Docker

```bash
docker compose up -d postgres redis elasticsearch
```

### 2.2 Backend

```bash
cd backend
cp .env.example .env      # fill in GOOGLE_CLIENT_ID, SLACK_CLIENT_ID/SECRET etc.
npm install
npm run migrate           # applies src/db/schema.sql
npm run dev                # starts the API server (also reconciles the queue on boot)
```

In a **second terminal**, start the worker (separate process, as it would be in production):

```bash
cd backend
npm run worker
```

- API: http://localhost:4000
- Live queue dashboard: **http://localhost:4000/admin/queues**

### 2.3 Frontend

```bash
cd frontend
cp .env.local.example .env.local   # set NEXT_PUBLIC_GOOGLE_CLIENT_ID
npm install
npm run dev
```

- App: http://localhost:3000

### 2.4 Ethereal Email setup

No manual signup needed — from the dashboard, click **"+ Add Sender"** once logged in.
This calls `POST /api/senders/ethereal`, which uses `nodemailer.createTestAccount()`
to mint a brand-new Ethereal inbox on the fly and registers it as a sender. Every
sent email's console log includes a `preview:` URL (Ethereal's hosted preview of the
actual email) — use that in your demo video instead of a real inbox.

### 2.5 Google OAuth setup

1. Create an OAuth 2.0 Client ID (Web application) in [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Authorized JavaScript origin: `http://localhost:3000`.
3. Put the client ID in both `backend/.env` (`GOOGLE_CLIENT_ID`) and
   `frontend/.env.local` (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`).
4. The frontend performs the actual sign-in (`@react-oauth/google`) and sends the
   resulting Google ID token to `POST /api/auth/google`, which verifies it
   server-side and issues our own session JWT.

### 2.6 Slack OAuth setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) →
   "From scratch".
2. Under **OAuth & Permissions**, add redirect URL:
   `http://localhost:4000/api/slack/oauth/callback`.
3. Add scopes: `chat:write`, `incoming-webhook`.
4. Copy Client ID / Secret into `backend/.env`.
5. In the dashboard, click **"Connect Slack"** → real OAuth consent screen →
   on approval Slack redirects back to our callback, which stores the
   bot token / webhook per user in `slack_integrations`.

---

## 3. Architecture Overview

### 3.1 How scheduling works (no cron)

1. User submits the Compose form (subject, body, sender, CSV of leads, start time,
   delay-between-sends, hourly limit) → `POST /api/emails/schedule`.
2. The backend parses the CSV, creates one `batches` row and one `emails` row
   **per recipient** in Postgres (the DB is the source of truth), each with:
   - a deterministic `idempotency_key` = `sha256(batchId:recipient)`
   - a `scheduled_time` staggered by `index * delayBetweenMs`
3. After the DB transaction commits, we enqueue one **BullMQ delayed job per
   email**, using the email's own DB `id` as the BullMQ `jobId`. BullMQ
   deduplicates jobs by `jobId` within a queue — this is the core idempotency
   guarantee: re-adding the same `emailId` is always a safe no-op.
4. BullMQ workers (separate process, `npm run worker`) pick up jobs when their
   delay elapses — no polling, no cron, Redis handles the timing internally.

### 3.2 How persistence on restart is handled

- **Emails table is the source of truth**, not the queue. Every email's lifecycle
  (`scheduled → processing → sent/failed/rescheduled`) is persisted in Postgres
  before/after each step.
- On **every server boot**, `reconcileQueueOnBoot()` (`src/queues/recover.ts`) runs:
  it queries all `emails` still in `scheduled`/`processing`/`rescheduled` status,
  checks whether a BullMQ job already exists for that `emailId`
  (`emailQueue.getJob(id)`), and re-adds any that are missing.
  - Normal restart (only the Node process died, Redis kept running): BullMQ's
    jobs were persisted in Redis the whole time, so this is a no-op — nothing
    is duplicated.
  - Worst case (Redis itself was flushed/restarted independently of Postgres):
    the reconciliation re-queues exactly the emails that still need to go out,
    using the same `emailId` as jobId, so there's no duplicate scheduling even
    then.
- The worker itself never sends without first re-checking the DB row's status
  (`if email.status === 'sent': skip`) — so a re-run of an already-completed
  job is a safe no-op. The one known edge case is documented in Section 5.

### 3.3 How rate limiting & concurrency are implemented

- **Worker concurrency**: `Worker(..., { concurrency: env.WORKER_CONCURRENCY })` —
  fully configurable via `.env`, no hardcoding.
- **Minimum delay between sends**: enforced two ways —
  1. Emails are pre-staggered at schedule-time by `delayBetweenMs` (their
     `scheduled_time` fields are spread out).
  2. The worker additionally takes a short-lived Redis lock
     (`SET key val PX <minDelayMs> NX`) per sender before actually sending,
     so even under high concurrency two workers can't send for the same
     sender within the configured window. **Default: 2000ms.**
- **Emails per hour per sender**: a Redis-backed, atomic Lua script
  (`src/services/rateLimiter.ts`) implements `INCR`-with-cap on a key like
  `rate:{senderId}:{hourWindowEpoch}`. Because the check-and-increment is a
  single Lua script, it's atomic across any number of worker processes/instances
  — no in-memory counters, no race conditions. `MAX_EMAILS_PER_HOUR_PER_SENDER`
  is fully configurable via env.
- **On limit hit**: the job is **never dropped or failed**. The email's status
  is set to `rescheduled`, its `scheduled_time` is bumped to the start of the
  next hour window, and a fresh BullMQ delayed job is enqueued for that time —
  preserving order relative to other rescheduled emails for that sender. A
  live Slack notification fires at this exact moment (see below).
- **1000+ emails at once**: since jobs are delayed (not executed immediately)
  and concurrency + per-sender rate limits are enforced at the worker level,
  scheduling 1000 emails for "now" just means 1000 rows + 1000 delayed jobs
  land in Redis; the worker pool drains them at the configured pace, and any
  that would exceed the hourly cap automatically roll into the next window.

### 3.4 Slack notifications

- Real OAuth flow: **Connect Slack** button → `/api/slack/oauth/start` →
  Slack consent screen → `/api/slack/oauth/callback` → token/webhook stored
  per user in `slack_integrations`.
- The worker calls `notifyRateLimitHit()` the instant a sender's hourly cap is
  hit — a live `fetch()` to the stored incoming webhook (or `chat.postMessage`
  if only a bot token was granted), not just a log line.
- If the user hasn't connected Slack, the lookup returns no rows and the
  function no-ops safely (no crash). If they connect later, the very next
  rate-limit hit picks up the new integration automatically — no redeploy,
  since we query the DB fresh on every call.

---

## 4. Features Implemented

### Backend
- [x] Email scheduling API (multipart: CSV/txt leads + subject/body/timing)
- [x] BullMQ delayed jobs (no cron), Redis-backed
- [x] Postgres persistence (source of truth) — `users`, `senders`, `batches`, `emails`, `slack_integrations`
- [x] Multi-sender Ethereal SMTP sending
- [x] Elasticsearch indexing on send + `/api/emails/search`
- [x] Live Bull-Board dashboard at `/admin/queues`
- [x] Restart persistence: future emails still send correctly, no duplication (`recover.ts`)
- [x] Idempotency: deterministic `idempotency_key` (DB unique constraint) + BullMQ `jobId = emailId`
- [x] Configurable worker concurrency
- [x] Configurable minimum delay between sends (Redis pacing lock)
- [x] Configurable per-sender hourly rate limit, atomic Redis/Lua enforcement, safe across workers
- [x] Rate-limit-hit jobs are rescheduled (never dropped) into the next hour window
- [x] Real Slack OAuth + live rate-limit-hit notifications, safe disconnect/reconnect
- [x] Real Google OAuth (id_token verification) + JWT sessions

### Frontend
- [x] Real Google Login (no mock), redirect to dashboard on success
- [x] Header with name, email, avatar, Logout
- [x] Tabs: Scheduled Emails / Sent Emails
- [x] "Compose New Email" — subject, body, CSV upload with live detected-recipient
      count, start time, delay, hourly limit
- [x] Scheduled Emails table: email, subject, scheduled time, status — loading + empty states
- [x] Sent Emails table: email, subject, sent time, status (sent/failed) — loading + empty states
- [x] "Connect Slack" button wired to real OAuth start
- [x] "+ Add Sender" — one-click Ethereal mailbox creation
- [x] Reusable components (`Header`, `StatusBadge`, `EmailTable`, `ComposeModal`), typed API client, DRY structure

---

## 5. Assumptions, Shortcuts & Trade-offs

- **At-least-once delivery, not exactly-once**: if the process crashes in the
  narrow window between the SMTP call succeeding and the DB `status = 'sent'`
  write committing, a retry could resend that one email. A fully
  exactly-once system would need a transactional outbox or SMTP-side
  idempotency (most real providers support an `Idempotency-Key` header —
  Ethereal does not), which was out of scope for this assignment.
- **CSV parsing** is a permissive regex-based email extractor rather than a
  strict CSV column parser, so it tolerates messy files (headers, extra
  columns, stray text) but doesn't validate column structure.
- **Elasticsearch is best-effort**: if it's down at boot, the API still starts
  (search will just error) so a missing ES container doesn't block the whole
  demo.
- **Rate limiting is per-sender** (not per-tenant), since each sender already
  belongs to exactly one user in this schema; this satisfies the "per-sender"
  option explicitly allowed by the spec.
- **Session storage** is a simple `localStorage` JWT rather than httpOnly
  cookies, to keep the demo simple — a real production app should move to
  httpOnly cookies + refresh tokens.

---

## 6. Project Structure

```
reachinbox-scheduler/
├── docker-compose.yml        # Redis, Postgres, Elasticsearch, backend, worker
├── backend/
│   ├── src/
│   │   ├── config/           # env, redis, db
│   │   ├── db/                # schema.sql, migrate.ts
│   │   ├── queues/            # emailQueue.ts, worker.ts, recover.ts, bullBoard.ts
│   │   ├── services/          # rateLimiter, emailService, slackService, searchService
│   │   ├── middleware/        # auth.ts (JWT)
│   │   ├── routes/            # auth, senders, emails, slack
│   │   └── index.ts           # server entrypoint
│   └── Dockerfile
└── frontend/
    ├── app/                   # Next.js App Router pages
    ├── components/            # Header, StatusBadge, EmailTable, ComposeModal
    └── lib/api.ts             # typed API client
```
