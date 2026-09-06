import dotenv from "dotenv";
dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  frontendUrl: required("FRONTEND_URL", "http://localhost:3000"),
  jwtSecret: required("JWT_SECRET", "dev_secret_change_me"),

  databaseUrl: required("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/reachinbox"),

  redisHost: process.env.REDIS_HOST ?? "localhost",
  redisPort: Number(process.env.REDIS_PORT ?? 6379),
  redisPassword: process.env.REDIS_PASSWORD || undefined,

  esNode: process.env.ELASTICSEARCH_NODE ?? "http://localhost:9200",
  esIndex: process.env.ELASTICSEARCH_INDEX ?? "emails",

  etherealUser: process.env.ETHEREAL_USER || "",
  etherealPass: process.env.ETHEREAL_PASS || "",

  // Throttling / rate limiting - all configurable via env, no hardcoding
  minDelayBetweenSendsMs: Number(process.env.MIN_DELAY_BETWEEN_SENDS_MS ?? 2000),
  maxEmailsPerHourPerSender: Number(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER ?? 200),
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),

  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",

  slackClientId: process.env.SLACK_CLIENT_ID ?? "",
  slackClientSecret: process.env.SLACK_CLIENT_SECRET ?? "",
  slackRedirectUri: process.env.SLACK_REDIRECT_URI ?? "http://localhost:4000/api/slack/oauth/callback",
};
