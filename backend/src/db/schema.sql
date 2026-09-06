-- ReachInbox Email Scheduler - Core Schema
-- Run via: npm run migrate

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub    TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per Slack workspace connection for a user/tenant.
CREATE TABLE IF NOT EXISTS slack_integrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id       TEXT NOT NULL,
  team_name     TEXT,
  access_token  TEXT NOT NULL,      -- bot token (xoxb-...)
  webhook_url   TEXT,               -- incoming webhook url, if granted
  channel_id    TEXT,
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

-- A "sender" is a from-address a user sends through (matches Ethereal accounts here).
CREATE TABLE IF NOT EXISTS senders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  smtp_host     TEXT NOT NULL,
  smtp_port     INTEGER NOT NULL,
  smtp_user     TEXT NOT NULL,
  smtp_pass     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);

-- A batch represents one "Compose" submission (a CSV of leads + subject/body).
CREATE TABLE IF NOT EXISTS batches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject               TEXT NOT NULL,
  body                  TEXT NOT NULL,
  start_time            TIMESTAMPTZ NOT NULL,
  delay_between_ms      INTEGER NOT NULL,
  hourly_limit          INTEGER NOT NULL,
  total_recipients      INTEGER NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per individual recipient email. This is the source of truth for
-- state and is what survives restarts: BullMQ job data references email.id,
-- and on restart we reconcile queue state against this table (see recover.ts).
CREATE TABLE IF NOT EXISTS emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES senders(id),
  recipient       TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  scheduled_time  TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','processing','sent','failed','rescheduled')),
  job_id          TEXT,                 -- BullMQ job id, for idempotency / lookup
  idempotency_key TEXT UNIQUE NOT NULL, -- prevents duplicate sends across retries/restarts
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id);
CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(sender_id);
CREATE INDEX IF NOT EXISTS idx_emails_scheduled_time ON emails(scheduled_time);
