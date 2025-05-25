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

// Updated structure for the new schema format
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

function getEnvList(name: string): string[] {
  return (process.env[name] || "").split(" ").filter(Boolean);
}

const ADDED_FILES: string[] = getEnvList("ADDED_FILES");
const MODIFIED_FILES: string[] = getEnvList("MODIFIED_FILES");
const DELETED_FILES: string[] = getEnvList("DELETED_FILES");

// --- Cloudflare Client ---

const cf = new Cloudflare({ apiToken: CF_API_TOKEN });

// --- Helper Functions ---

function getSubdomainFromPath(filePath: string): string {
  const filename = path.basename(filePath, ".json");

  // If the filename accidentally contains the full domain, strip off the base domain
  // This handles cases where someone creates "docs.is-an.ai.json" instead of "docs.json"
  if (filename.endsWith(`.${BASE_DOMAIN}`)) {
    return filename.slice(0, -BASE_DOMAIN.length - 1); // Remove ".is-an.ai" part
  }

  // Return just the subdomain part (what Cloudflare API expects)
  return filename;
}

// Fetches all existing DNS records for a specific subdomain (name)
async function getExistingRecords(subdomain: string) {
  try {
    // The list method is paginated, but we can filter by name.
    // Assume for now that filtering by name gives us all relevant records.
    // For zones with many records of the same name, pagination might be needed.
    const response = await cf.dns.records.list({
      zone_id: CF_ZONE_ID,
      name: {
        exact: subdomain + "." + BASE_DOMAIN,
      },
    });
    // The actual records are in the response object directly if using default pagination
    // If using cursors/pages, you'd access response.data
    // Let's assume the default retrieves what we need for this specific name.
    // The SDK might abstract pagination; check behavior if issues arise.
    // The response itself seems iterable or directly contains the records.
    // Convert iterator/paginated response to a simple array.

    return response.result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error fetching records for ${subdomain}:`, message);
    return []; // Return empty on error
  }
}

// Deletes a specific DNS record by its ID
async function deleteDNSRecord(recordId: string): Promise<void> {
  console.log(`Deleting DNS record ID: ${recordId}`);
  try {
    await cf.dns.records.delete(recordId, { zone_id: CF_ZONE_ID });
    console.log(`Successfully deleted record ID: ${recordId}`);
  } catch (error: any) {
    // Use 'any' or a more specific Cloudflare error type if available
    // Check for specific error codes or messages indicating the record doesn't exist
    // The exact error structure/codes might need verification via testing or SDK docs
    if (error.status === 404 || error.message?.includes("Record not found")) {
      console.warn(
        `Record ID ${recordId} not found, possibly already deleted.`
      );
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error deleting record ID ${recordId}:`, message);
      // Consider re-throwing if needed: throw error;
    }
  }
}

// Type guard for our MxRecordValue interface
function isMxRecordValue(value: any): value is MxRecordValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.priority === "number" &&
    typeof value.exchange === "string"
  );
}

// Creates or updates a DNS record based on the file content
async function createOrUpdateDNSRecord(
  subdomain: string,
  recordType: RecordResponse["type"], // Use the type from Cloudflare SDK
  recordValue: string | MxRecordValue, // Value from our JSON structure
  ttl: number = 1 /* Auto TTL */
): Promise<void> {
  console.log(
    `Processing ${recordType} record for ${subdomain} -> ${JSON.stringify(
      recordValue
    )}`
  );

  // Common properties for create/update payloads
  const commonPayload = {
    name: subdomain,
    ttl: ttl,
    proxied: false, // Default to DNS only
  };

  let createPayload: RecordCreateParams;
  let specificContent: any;
  let priority: number | undefined = undefined;

  // Build the type-specific payload part
  switch (recordType) {
    case "A":
    case "AAAA":
    case "CNAME":
    case "TXT": // TXT content is just a string
      if (typeof recordValue !== "string") {
        console.error(
          `Invalid value for ${recordType} record: Expected string, got ${typeof recordValue}`
        );
        return;
      }
      specificContent = recordValue;
      createPayload = {
        ...commonPayload,
        type: recordType,
        content: recordValue,
        zone_id: CF_ZONE_ID, // Required for create
      };
      break;
    case "MX":
      if (!isMxRecordValue(recordValue)) {
        console.error(
          `Invalid MX record value for ${subdomain}: ${JSON.stringify(
            recordValue
          )}`
        );
        return;
      }
      priority = recordValue.priority; // Cloudflare uses 'priority'
      specificContent = recordValue.exchange;
      createPayload = {
        ...commonPayload,
        type: "MX",
        content: recordValue.exchange,
        priority: recordValue.priority,
        zone_id: CF_ZONE_ID,
      };
      break;
    // Add cases for other record types (SRV, CAA, etc.) if needed
    default:
      console.warn(`Unsupported record type: ${recordType} for ${subdomain}`);
      return;
  }

  try {
    const existingRecords = await getExistingRecords(subdomain);

    // Find existing record matching type, content, and priority (for MX)
    const recordToUpdate = existingRecords.find((r) => {
      if (r.type !== recordType) return false;
      if (r.type === "MX") {
        // For MX, match content (exchange) and priority
        const mxRecord = r as MXRecord;
        return (
          mxRecord.content === specificContent && mxRecord.priority === priority
        );
      } else {
        // For others, just match content
        return r.content === specificContent;
      }
    });

    if (recordToUpdate) {
      // Check if TTL is the only difference that needs updating
      if (recordToUpdate.ttl !== ttl) {
        console.log(
          `Updating TTL for existing ${recordType} record ID: ${recordToUpdate.id}`
        );
        // Construct update payload (similar to create, but uses RecordUpdateParams)
        const updatePayload: RecordUpdateParams = {
          ...commonPayload, // Includes name, ttl, proxied
          type: recordType,
          content: specificContent, // Provide content even if not changing?
          zone_id: CF_ZONE_ID, // Required for update
          ...(priority !== undefined && { priority }), // Add priority only for MX
        };
        await cf.dns.records.update(recordToUpdate.id, updatePayload);
        console.log(
          `Successfully updated TTL for record ID: ${recordToUpdate.id}`
        );
      } else {
        console.log(
          `No changes needed for ${recordType} record ID: ${recordToUpdate.id} (content/priority/TTL match)`
        );
      }
    } else {
      // Record with this exact content/priority doesn't exist, create it
      console.log(`Creating new ${recordType} record for ${subdomain}`);
      await cf.dns.records.create(createPayload);
      console.log(
        `Successfully created ${recordType} record for ${subdomain} with content: ${JSON.stringify(
          specificContent
        )}`
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Error processing ${recordType} record for ${subdomain} with value ${JSON.stringify(
        recordValue
      )}: `,
      message
    );
    // Log the full error object if helpful
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  }
}

// --- Main Logic ---

async function processChanges(): Promise<void> {
  console.log("Starting DNS update process...");

  // 1. Handle Deletions
  console.log("--- Processing Deletions ---");
  await Promise.all(
    DELETED_FILES.map(async (file) => {
      const subdomain = getSubdomainFromPath(file);
      console.log(
        `Processing deletion for subdomain: ${subdomain} (from file ${file})`
      );
      const existingRecords = await getExistingRecords(subdomain);
      if (existingRecords.length === 0) {
        console.log(`No existing records found for ${subdomain}.`);
        return;
      }
      console.log(
        `Found ${existingRecords.length} records to delete for ${subdomain}.`
      );
      // Delete all records associated with this subdomain concurrently
      await Promise.all(
        existingRecords.map((record) => deleteDNSRecord(record.id))
      );
    })
  );

  // 2. Handle Additions and Modifications
  console.log("--- Processing Additions/Modifications ---");
  const filesToProcess = [...new Set([...ADDED_FILES, ...MODIFIED_FILES])]; // Use Set to avoid duplicate processing

  for (const file of filesToProcess) {
    const subdomain = getSubdomainFromPath(file);
    const filePath = path.join(WORKSPACE_PATH, file);
    const isModification = MODIFIED_FILES.includes(file);
    console.log(
      `Processing ${
        isModification ? "modified" : "added"
      } file: ${file} for subdomain: ${subdomain}`
    );

    try {
      const fileContent = await fs.readFile(filePath, "utf-8");
      const data: unknown = JSON.parse(fileContent);

      // Validate the structure of the parsed JSON
      if (
        !data ||
        typeof data !== "object" ||
        !("record" in data) ||
        !Array.isArray((data as RecordFileContent).record)
      ) {
        console.error(
          `Error: Invalid or missing 'record' array in file ${file}. Skipping.`
        );
        continue;
      }
      // Now type assertion is safer
      const fileData = data as RecordFileContent;
      const desiredRecords = fileData.record;

      // Get current state from Cloudflare for this subdomain
      const existingRecords = await getExistingRecords(subdomain);

      // Store promises for record creation/update operations for this file
      const processingPromises: Promise<void>[] = [];

      // Records present in the file (desired state)
      const desiredRecordSignatures = new Set<string>();

      // Iterate through the records defined in the file
      for (const recordDef of desiredRecords) {
        const upperRecordType =
          recordDef.type.toUpperCase() as RecordResponse["type"];
        const valueItem = recordDef.value;

        // Define a unique signature for this desired record (type + content + priority)
        let signature = `${upperRecordType}-`;
        if (upperRecordType === "MX" && isMxRecordValue(valueItem)) {
          signature += `${valueItem.exchange}-${valueItem.priority}`;
        } else if (typeof valueItem === "string") {
          signature += valueItem;
        } else {
          console.warn(
            `Skipping invalid value for record type ${
              recordDef.type
            } in ${file}: ${JSON.stringify(valueItem)}`
          );
          continue; // Skip invalid structured items
        }
        desiredRecordSignatures.add(signature);

        // Queue the creation or update operation
        processingPromises.push(
          createOrUpdateDNSRecord(subdomain, upperRecordType, valueItem)
        );
      }

      // Wait for all create/update operations for this file to settle
      await Promise.all(processingPromises);

      // 3. (Modification Specific) Delete records from Cloudflare that are NOT in the modified file
      if (isModification) {
        console.log(
          `--- Pruning records for modified subdomain: ${subdomain} ---`
        );
        const deletionPromises: Promise<void>[] = [];
        for (const existingRecord of existingRecords) {
          let existingSignature = `${existingRecord.type}-`;
          if (existingRecord.type === "MX") {
            existingSignature += `${existingRecord.content}-${existingRecord.priority}`;
          } else {
            existingSignature += existingRecord.content;
          }

          // If an existing record in Cloudflare doesn't match any record defined in the file,
          // and it wasn't just created/updated (handled by createOrUpdate), delete it.
          if (!desiredRecordSignatures.has(existingSignature)) {
            console.log(
              `   Pruning record (not in file): ID ${existingRecord.id}, Type ${existingRecord.type}, Content ${existingRecord.content}`
            );
            deletionPromises.push(deleteDNSRecord(existingRecord.id));
          }
        }
        await Promise.all(deletionPromises);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error processing file ${file}:`, message);
      // Optionally log stack trace: console.error(error);
    }
  }

  console.log("--- DNS update process finished. ---");
}

processChanges().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Unhandled error during DNS update process:", message);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
