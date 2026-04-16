import { OPENWHISPR_API_URL } from "../config/constants.js";

interface TranscriptionInput {
  client_transcription_id?: string;
  text: string;
  raw_text?: string | null;
  provider?: string | null;
  model?: string | null;
  language?: string | null;
  audio_duration_ms?: number | null;
  status?: string;
  created_at?: string;
}

interface CloudTranscription {
  id: string;
  client_transcription_id: string | null;
  text: string;
  raw_text: string | null;
  word_count: number;
  source: string;
  provider: string | null;
  model: string | null;
  language: string | null;
  audio_duration_ms: number | null;
  status: string;
  deleted_at: string | null;
  created_at: string;
}

async function create(transcription: TranscriptionInput): Promise<CloudTranscription> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/transcriptions/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(transcription),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CloudTranscription>;
}

async function batchCreate(
  transcriptions: TranscriptionInput[]
): Promise<{ created: CloudTranscription[] }> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/transcriptions/batch-create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ transcriptions }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ created: CloudTranscription[] }>;
}

async function list(
  limit?: number,
  before?: string
): Promise<{ transcriptions: CloudTranscription[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (before !== undefined) params.set("before", before);
  const query = params.toString();
  const res = await fetch(
    `${OPENWHISPR_API_URL}/api/transcriptions/list${query ? `?${query}` : ""}`,
    { credentials: "include" }
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ transcriptions: CloudTranscription[] }>;
}

async function deleteTranscription(id: string): Promise<void> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/transcriptions/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export { create, batchCreate, list, deleteTranscription };

export const TranscriptionsService = {
  create,
  batchCreate,
  list,
  delete: deleteTranscription,
};
