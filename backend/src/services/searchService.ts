import { Client } from "@elastic/elasticsearch";
import { env } from "../config/env";

export const esClient = new Client({ node: env.esNode });

export async function ensureIndex() {
  const exists = await esClient.indices.exists({ index: env.esIndex });
  if (!exists) {
    await esClient.indices.create({
      index: env.esIndex,
      mappings: {
        properties: {
          id: { type: "keyword" },
          userId: { type: "keyword" },
          senderId: { type: "keyword" },
          recipient: { type: "keyword" },
          subject: { type: "text" },
          body: { type: "text" },
          status: { type: "keyword" },
          scheduledTime: { type: "date" },
          sentAt: { type: "date" },
        },
      },
    });
    console.log(`[elasticsearch] created index "${env.esIndex}"`);
  }
}

export interface EmailDoc {
  id: string;
  userId: string;
  senderId: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduledTime: string;
  sentAt?: string | null;
}

export async function indexEmail(doc: EmailDoc) {
  await esClient.index({
    index: env.esIndex,
    id: doc.id,
    document: doc,
  });
}

export async function searchEmails(params: { userId: string; q?: string; status?: string; from?: number; size?: number }) {
  const must: any[] = [{ term: { userId: params.userId } }];
  if (params.q) {
    must.push({
      multi_match: { query: params.q, fields: ["subject", "body", "recipient"] },
    });
  }
  if (params.status) {
    must.push({ term: { status: params.status } });
  }

  const result = await esClient.search<EmailDoc>({
    index: env.esIndex,
    from: params.from ?? 0,
    size: params.size ?? 20,
    query: { bool: { must } },
    sort: [{ scheduledTime: { order: "desc" } }],
  });

  return result.hits.hits.map((h) => h._source);
}
