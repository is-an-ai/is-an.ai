import { promises as fs } from "fs";
import path from "path";
import https from "https";

// --- Environment Variables ---

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
const WORKER_API_URL = process.env.WORKER_API_URL || "https://api.is-an.ai";
const WORKSPACE_PATH = process.env.GITHUB_WORKSPACE || process.cwd();

const ADDED_FILES = (process.env.ADDED_FILES || "").split(" ").filter(Boolean);
const MODIFIED_FILES = (process.env.MODIFIED_FILES || "").split(" ").filter(Boolean);
const DELETED_FILES = (process.env.DELETED_FILES || "").split(" ").filter(Boolean);

// --- Types ---

interface RecordFile {
  description?: string;
  owner: {
    github_username?: string;
    email: string;
  };
  record: Array<{
    type: string;
    value: string | { priority: number; exchange: string };
  }>;
}

interface SyncRecord {
  name: string;
  content?: RecordFile;
}

// --- Helpers ---

function getSubdomainFromPath(filePath: string): string {
  return path.basename(filePath, ".json");
}

async function loadRecordFile(filePath: string): Promise<RecordFile | null> {
  try {
    const fullPath = path.join(WORKSPACE_PATH, filePath);
    const data = await fs.readFile(fullPath, "utf-8");
    return JSON.parse(data) as RecordFile;
  } catch {
    return null;
  }
}

// --- Main ---

async function syncDB(): Promise<void> {
  console.log("=== Syncing records to D1 database ===");

  if (!ADMIN_API_KEY) {
    console.log("ADMIN_API_KEY not set, skipping DB sync");
    return;
  }

  const added: SyncRecord[] = [];
  const modified: SyncRecord[] = [];
  const deleted: SyncRecord[] = [];

  for (const file of ADDED_FILES) {
    if (file === "records/schema.json") continue;
    const content = await loadRecordFile(file);
    if (content) {
      added.push({ name: getSubdomainFromPath(file), content });
    }
  }

  for (const file of MODIFIED_FILES) {
    if (file === "records/schema.json") continue;
    const content = await loadRecordFile(file);
    if (content) {
      modified.push({ name: getSubdomainFromPath(file), content });
    }
  }

  for (const file of DELETED_FILES) {
    if (file === "records/schema.json") continue;
    deleted.push({ name: getSubdomainFromPath(file) });
  }

  const total = added.length + modified.length + deleted.length;
  if (total === 0) {
    console.log("No records to sync");
    return;
  }

  console.log(`Syncing: ${added.length} added, ${modified.length} modified, ${deleted.length} deleted`);

  const body = JSON.stringify({ added, modified, deleted });

  const url = new URL("/admin/sync-records", WORKER_API_URL);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": ADMIN_API_KEY,
      "User-Agent": "is-an-ai-deploy",
    },
    body,
  });

  if (!res.ok) {
    const error = await res.text();
    console.error(`DB sync failed: ${res.status} ${error}`);
    // Non-fatal: DNS is already deployed, DB sync failure shouldn't block
    return;
  }

  const result = await res.json() as {
    added: number;
    modified: number;
    deleted: number;
    errors: string[];
  };

  console.log(`✓ DB sync complete: ${result.added} added, ${result.modified} modified, ${result.deleted} deleted`);
  if (result.errors.length > 0) {
    console.warn(`⚠️ ${result.errors.length} errors:`);
    for (const err of result.errors) {
      console.warn(`  - ${err}`);
    }
  }
}

syncDB().catch((err) => {
  // Non-fatal: log and continue
  console.error("DB sync error (non-fatal):", err);
});
