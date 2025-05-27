import { promises as fs } from "fs";
import path from "path";
import { Cloudflare } from "cloudflare";
import {
  MXRecord,
  RecordCreateParams,
  RecordResponse,
  RecordUpdateParams,
} from "cloudflare/resources/dns/records.mjs";

interface MxRecordValue {
  priority: number;
  exchange: string;
}

interface RecordDefinition {
  type: string;
  value: string | MxRecordValue;
}

interface RecordFileContent {
  description?: string;
  owner: {
    github_username?: string;
    email: string;
  };
  record: RecordDefinition[];
}

interface RecordSignature {
  subdomain: string;
  type: string;
  content: string;
  priority?: number;
}

// --- Environment Variables ---
function getEnvVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: ${name} environment variable not set.`);
    process.exit(1);
  }
  return value;
}

const CF_API_TOKEN: string = getEnvVariable("CLOUDFLARE_API_TOKEN");
const CF_ZONE_ID: string = getEnvVariable("CLOUDFLARE_ZONE_ID");
const BASE_DOMAIN: string = process.env.BASE_DOMAIN || "is-an.ai";
const WORKSPACE_PATH: string = getEnvVariable("GITHUB_WORKSPACE");
const DRY_RUN: boolean = process.env.DRY_RUN === "true";

// --- Cloudflare Client ---
const cf = new Cloudflare({ apiToken: CF_API_TOKEN });

// --- Helper Functions ---

function getSubdomainFromPath(filePath: string): string {
  const filename = path.basename(filePath, ".json");

  if (filename.endsWith(`.${BASE_DOMAIN}`)) {
    return filename.slice(0, -BASE_DOMAIN.length - 1);
  }

  return filename;
}

function isMxRecordValue(value: any): value is MxRecordValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.priority === "number" &&
    typeof value.exchange === "string"
  );
}

function createRecordSignature(record: RecordSignature): string {
  const { subdomain, type, content, priority } = record;
  return priority !== undefined
    ? `${subdomain}:${type}:${content}:${priority}`
    : `${subdomain}:${type}:${content}`;
}

async function fetchAllCloudflareRecords(): Promise<RecordResponse[]> {
  console.log("Fetching all DNS records from Cloudflare...");

  try {
    const response = await cf.dns.records.list({
      zone_id: CF_ZONE_ID,
    });

    // Filter only records that belong to our managed subdomains
    const managedRecords = response.result.filter(
      (record) =>
        record.name &&
        record.name.endsWith(`.${BASE_DOMAIN}`) &&
        record.name !== BASE_DOMAIN // Exclude apex domain records
    );

    console.log(
      `Found ${managedRecords.length} managed DNS records in Cloudflare`
    );
    return managedRecords;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching Cloudflare records:", message);
    throw error;
  }
}

async function loadAllRepositoryRecords(): Promise<
  Map<string, RecordSignature[]>
> {
  console.log("Loading all repository records...");

  const recordsDir = path.join(WORKSPACE_PATH, "records");
  const recordMap = new Map<string, RecordSignature[]>();

  try {
    const files = await fs.readdir(recordsDir);
    const jsonFiles = files.filter(
      (file) => file.endsWith(".json") && file !== "schema.json"
    );

    console.log(`Found ${jsonFiles.length} record files in repository`);

    for (const file of jsonFiles) {
      const filePath = path.join(recordsDir, file);
      const subdomain = getSubdomainFromPath(file);

      try {
        const fileContent = await fs.readFile(filePath, "utf-8");
        const data: unknown = JSON.parse(fileContent);

        if (
          !data ||
          typeof data !== "object" ||
          !("record" in data) ||
          !Array.isArray((data as RecordFileContent).record)
        ) {
          console.warn(`Invalid record structure in file ${file}, skipping`);
          continue;
        }

        const fileData = data as RecordFileContent;
        const signatures: RecordSignature[] = [];

        for (const recordDef of fileData.record) {
          const type = recordDef.type.toUpperCase();

          if (type === "MX" && isMxRecordValue(recordDef.value)) {
            signatures.push({
              subdomain,
              type,
              content: recordDef.value.exchange,
              priority: recordDef.value.priority,
            });
          } else if (typeof recordDef.value === "string") {
            signatures.push({
              subdomain,
              type,
              content: recordDef.value,
            });
          } else {
            console.warn(
              `Invalid record value in ${file}: ${JSON.stringify(
                recordDef.value
              )}`
            );
          }
        }

        recordMap.set(subdomain, signatures);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error processing file ${file}:`, message);
      }
    }

    return recordMap;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error loading repository records:", message);
    throw error;
  }
}

function convertCloudflareToSignature(record: RecordResponse): RecordSignature {
  if (!record.name || !record.type || !record.content) {
    throw new Error(`Invalid record data: missing required fields`);
  }

  const subdomain = record.name.replace(`.${BASE_DOMAIN}`, "");

  return {
    subdomain,
    type: record.type,
    content: record.content,
    ...(record.type === "MX" && { priority: (record as MXRecord).priority }),
  };
}

function validateRecordContent(signature: RecordSignature): string | null {
  const { type, content } = signature;

  switch (type) {
    case "A":
      // IPv4 validation
      const ipv4Regex =
        /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      if (!ipv4Regex.test(content)) {
        return `Invalid IPv4 address: ${content}`;
      }
      break;
    case "AAAA":
      // IPv6 validation (basic)
      const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$/;
      if (!ipv6Regex.test(content)) {
        return `Invalid IPv6 address: ${content}`;
      }
      break;
    case "CNAME":
      // Hostname validation
      if (!content || content.length === 0) {
        return `CNAME content cannot be empty`;
      }
      break;
    case "TXT":
      // TXT records can be almost anything, but check length
      if (content.length > 255) {
        return `TXT record too long: ${content.length} characters (max 255)`;
      }
      break;
    case "MX":
      if (
        !signature.priority ||
        signature.priority < 0 ||
        signature.priority > 65535
      ) {
        return `Invalid MX priority: ${signature.priority} (must be 0-65535)`;
      }
      break;
  }

  return null; // Valid
}

async function createDNSRecord(signature: RecordSignature): Promise<boolean> {
  const recordSignature = createRecordSignature(signature);
  console.log(`Creating DNS record: ${recordSignature}`);

  // Validate record content before attempting to create
  const validationError = validateRecordContent(signature);
  if (validationError) {
    console.error(`✗ Invalid record: ${recordSignature} - ${validationError}`);
    return false;
  }

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create: ${recordSignature}`);
    return true;
  }

  const commonPayload = {
    name: signature.subdomain,
    ttl: 1, // Auto TTL
    proxied: false,
    zone_id: CF_ZONE_ID,
  };

  let createPayload: RecordCreateParams;

  switch (signature.type) {
    case "A":
    case "AAAA":
    case "CNAME":
    case "TXT":
      createPayload = {
        ...commonPayload,
        type: signature.type as any,
        content: signature.content,
      };
      break;
    case "MX":
      if (signature.priority === undefined) {
        throw new Error(`MX record missing priority: ${recordSignature}`);
      }
      createPayload = {
        ...commonPayload,
        type: "MX",
        content: signature.content,
        priority: signature.priority,
      };
      break;
    default:
      throw new Error(`Unsupported record type: ${signature.type}`);
  }

  try {
    await cf.dns.records.create(createPayload);
    console.log(`✓ Created: ${recordSignature}`);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ Failed to create: ${recordSignature} - ${message}`);
    return false;
  }
}

async function deleteDNSRecord(
  recordId: string,
  signature: string
): Promise<boolean> {
  console.log(`Deleting DNS record: ${signature}`);

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would delete: ${signature}`);
    return true;
  }

  try {
    await cf.dns.records.delete(recordId, { zone_id: CF_ZONE_ID });
    console.log(`✓ Deleted: ${signature}`);
    return true;
  } catch (error: any) {
    if (error.status === 404 || error.message?.includes("Record not found")) {
      console.warn(`⚠ Record already deleted: ${signature}`);
      return true; // Consider already deleted as success
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`✗ Failed to delete: ${signature} - ${message}`);
      return false;
    }
  }
}

async function syncDNSRecords(): Promise<void> {
  console.log("=== Starting DNS Sync Process ===");

  // Load current state from both sources
  const [cloudflareRecords, repositoryRecords] = await Promise.all([
    fetchAllCloudflareRecords(),
    loadAllRepositoryRecords(),
  ]);

  // Convert Cloudflare records to signatures for comparison
  const cloudflareSignatures = new Map<
    string,
    { record: RecordResponse; signature: RecordSignature }
  >();

  for (const record of cloudflareRecords) {
    const signature = convertCloudflareToSignature(record);
    const key = createRecordSignature(signature);
    cloudflareSignatures.set(key, { record, signature });
  }

  // Convert repository records to signatures
  const repositorySignatures = new Map<string, RecordSignature>();

  for (const [subdomain, records] of repositoryRecords) {
    for (const record of records) {
      const key = createRecordSignature(record);
      repositorySignatures.set(key, record);
    }
  }

  console.log(`Repository records: ${repositorySignatures.size}`);
  console.log(`Cloudflare records: ${cloudflareSignatures.size}`);

  // Find discrepancies
  const toCreate: RecordSignature[] = [];
  const toDelete: { id: string; signature: string }[] = [];

  // Records in repository but not in Cloudflare (need to create)
  for (const [key, signature] of repositorySignatures) {
    if (!cloudflareSignatures.has(key)) {
      toCreate.push(signature);
    }
  }

  // Records in Cloudflare but not in repository (need to delete)
  for (const [key, { record }] of cloudflareSignatures) {
    if (!repositorySignatures.has(key)) {
      toDelete.push({ id: record.id, signature: key });
    }
  }

  console.log(`\n=== Sync Summary ===`);
  console.log(`Records to create: ${toCreate.length}`);
  console.log(`Records to delete: ${toDelete.length}`);

  if (toCreate.length === 0 && toDelete.length === 0) {
    console.log("✓ DNS records are already in sync!");
    return;
  }

  // Execute sync operations with error tracking
  console.log(`\n=== Creating Missing Records ===`);
  let createSuccessCount = 0;
  let createFailureCount = 0;

  for (const signature of toCreate) {
    const success = await createDNSRecord(signature);
    if (success && !DRY_RUN) {
      createSuccessCount++;
    } else if (!success) {
      createFailureCount++;
    }
  }

  console.log(`\n=== Deleting Orphaned Records ===`);
  let deleteSuccessCount = 0;
  let deleteFailureCount = 0;

  for (const { id, signature } of toDelete) {
    const success = await deleteDNSRecord(id, signature);
    if (success && !DRY_RUN) {
      deleteSuccessCount++;
    } else if (!success) {
      deleteFailureCount++;
    }
  }

  // Final summary
  console.log(`\n=== Sync Results ===`);
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create: ${toCreate.length} records`);
    console.log(`[DRY RUN] Would delete: ${toDelete.length} records`);
  } else {
    console.log(
      `✓ Successfully created: ${createSuccessCount}/${toCreate.length} records`
    );
    console.log(
      `✓ Successfully deleted: ${deleteSuccessCount}/${toDelete.length} records`
    );

    if (createFailureCount > 0 || deleteFailureCount > 0) {
      console.log(
        `⚠ Failed operations: ${createFailureCount + deleteFailureCount} total`
      );
      console.log(`  - Create failures: ${createFailureCount}`);
      console.log(`  - Delete failures: ${deleteFailureCount}`);
    }
  }

  console.log(`\n✓ DNS sync process completed!`);
}

// --- Main Execution ---
syncDNSRecords().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Unhandled error during DNS sync process:", message);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
