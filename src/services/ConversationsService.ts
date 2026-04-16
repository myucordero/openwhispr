import { OPENWHISPR_API_URL } from "../config/constants.js";

interface ConversationInput {
  client_conversation_id?: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  messages?: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    metadata?: Record<string, unknown> | null;
  }>;
}

interface CloudConversation {
  id: string;
  client_conversation_id: string | null;
  title: string;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CloudMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

async function create(input: ConversationInput): Promise<CloudConversation> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/conversations/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CloudConversation>;
}

async function update(
  id: string,
  updates: { title?: string; archived_at?: string }
): Promise<CloudConversation> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/conversations/update`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ id, ...updates }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CloudConversation>;
}

async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/conversations/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await res.text());
}

interface CloudConversationWithMessages extends CloudConversation {
  messages?: CloudMessage[];
}

async function list(
  limit?: number,
  before?: string,
  archived?: boolean,
  include?: string
): Promise<{ conversations: CloudConversationWithMessages[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (before !== undefined) params.set("before", before);
  if (archived) params.set("archived", "true");
  if (include !== undefined) params.set("include", include);
  const query = params.toString();
  const res = await fetch(
    `${OPENWHISPR_API_URL}/api/conversations/list${query ? `?${query}` : ""}`,
    { credentials: "include" }
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ conversations: CloudConversationWithMessages[] }>;
}

async function addMessage(
  conversationId: string,
  role: "user" | "assistant" | "system",
  content: string,
  metadata?: Record<string, unknown> | null
): Promise<CloudMessage> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/conversations/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      conversation_id: conversationId,
      role,
      content,
      ...(metadata ? { metadata } : {}),
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CloudMessage>;
}

async function listMessages(conversationId: string): Promise<{ messages: CloudMessage[] }> {
  const params = new URLSearchParams({ conversation_id: conversationId });
  const res = await fetch(`${OPENWHISPR_API_URL}/api/conversations/messages?${params}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ messages: CloudMessage[] }>;
}

async function search(
  query: string,
  limit?: number
): Promise<{ conversations: CloudConversation[] }> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/conversations/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ query, ...(limit !== undefined ? { limit } : {}) }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ conversations: CloudConversation[] }>;
}

export { create, update, deleteConversation, list, addMessage, listMessages, search };

export const ConversationsService = {
  create,
  update,
  delete: deleteConversation,
  list,
  addMessage,
  listMessages,
  search,
};
