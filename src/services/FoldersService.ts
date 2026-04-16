import { OPENWHISPR_API_URL } from "../config/constants.js";

interface FolderInput {
  name: string;
  client_folder_id?: string;
  is_default?: boolean;
  sort_order?: number;
}

interface CloudFolder {
  id: string;
  client_folder_id: string | null;
  name: string;
  is_default: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

async function create(folder: FolderInput): Promise<CloudFolder> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/folders/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(folder),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CloudFolder>;
}

async function batchCreate(folders: FolderInput[]): Promise<{ created: CloudFolder[] }> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/folders/batch-create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ folders }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ created: CloudFolder[] }>;
}

async function update(id: string, updates: Partial<FolderInput>): Promise<CloudFolder> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/folders/update`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ id, ...updates }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CloudFolder>;
}

async function deleteFolder(id: string): Promise<void> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/folders/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function list(): Promise<{ folders: CloudFolder[] }> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/folders/list`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ folders: CloudFolder[] }>;
}

export { create, batchCreate, update, deleteFolder, list };

export const FoldersService = {
  create,
  batchCreate,
  update,
  delete: deleteFolder,
  list,
};
