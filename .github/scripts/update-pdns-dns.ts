import { promises as fs } from "fs";
import path from "path";
import axios, { AxiosInstance } from "axios";
import punycode from "punycode";

// --- PowerDNS API 5.0 Interfaces ---

interface PdnsApiGetRecord {
  content: string;
  disabled: boolean;
}

interface PdnsApiGetRRSet {
  name: string; // FQDN
  type: string;
  ttl: number;
  records: PdnsApiGetRecord[];
}

interface PdnsApiPatchRecord {
  content: string;
  disabled: boolean;
  priority?: number;
}

interface PdnsApiPatchRRSet {
  name: string;
  type: string;
  ttl: number;
  changetype: "REPLACE" | "DELETE";
  records: PdnsApiPatchRecord[];
}

// --- Repository Record Interfaces ---

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

function getEnvList(name: string): string[] {
  return (process.env[name] || "")
    .split(" ")
    .filter((f) => f.trim().length > 0);
}

const PDNS_API_KEY: string = getEnvVariable("PDNS_API_KEY");
const PDNS_API_URL: string = getEnvVariable("PDNS_API_URL");
const PDNS_ZONE: string = getEnvVariable("PDNS_ZONE"); // e.g., "is-an.ai"
const WORKSPACE_PATH: string = getEnvVariable("GITHUB_WORKSPACE");

const ADDED_FILES: string[] = getEnvList("ADDED_FILES");
const MODIFIED_FILES: string[] = getEnvList("MODIFIED_FILES");
const DELETED_FILES: string[] = getEnvList("DELETED_FILES");

const DEFAULT_TTL = 300; // Default TTL
const SOA_MIN_TTL = 300; // Negative Cache TTL (5 minutes)

// --- PowerDNS API Client ---
const pdnsClient: AxiosInstance = axios.create({
  baseURL: PDNS_API_URL,
  headers: {
    "X-API-Key": PDNS_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

// --- Helper Functions (Robust Version) ---

/**
 * Extract subdomain from file path (with punycode conversion)
 */
function getSubdomainFromPath(filePath: string): string {
  const filename = path.basename(filePath, ".json");
  const baseDomainPattern = `.${PDNS_ZONE.replace(/\.$/, "")}`; // remove trailing dot if exists

  let subdomain = filename;
  if (filename.endsWith(baseDomainPattern)) {
    subdomain = filename.slice(0, -baseDomainPattern.length);
  } else if (filename === PDNS_ZONE.replace(/\.$/, "")) {
    subdomain = "@";
  }

  return punycode.toASCII(subdomain).toLowerCase();
}

function isMxRecordValue(value: any): value is MxRecordValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.priority === "number" &&
    typeof value.exchange === "string"
  );
}

/**
 * Convert subdomain to FQDN (append trailing dot, remove duplicate dots)
 */
function subdomainToFqdn(subdomain: string): string {
  // Strip leading and trailing dots
  while (subdomain.startsWith(".")) subdomain = subdomain.slice(1);
  while (subdomain.endsWith(".")) subdomain = subdomain.slice(0, -1);

  let fqdn;
  if (!subdomain || subdomain === "@" || subdomain.trim() === "") {
    fqdn = PDNS_ZONE;
  } else {
    fqdn = `${subdomain}.${PDNS_ZONE}`;
  }

  if (!fqdn.endsWith(".")) {
    fqdn += ".";
  }
  return fqdn.toLowerCase();
}

/**
 * Normalize record value (append dots, handle quotes, strip leading zeros from IPs, etc.)
 */
function normalizeContent(type: string, content: string): string {
  const upperType = type.toUpperCase();
  const typesNeedingDot = ["CNAME", "MX", "NS", "SRV", "PTR"];

  if (typesNeedingDot.includes(upperType)) {
    if (!content.endsWith(".")) return content + ".";
  }

  if (upperType === "TXT") {
    let clean = content;
    if (clean.includes(" IN TXT ")) {
      clean = clean.split(" IN TXT ")[1].trim();
    }
    if (clean.startsWith('"') && clean.endsWith('"')) {
      clean = clean.slice(1, -1);
    }
    return `"${clean}"`;
  }

  if (upperType === "A") {
    if (content.includes(".") && content.split(".").length === 4) {
      const parts = content.split(".");
      if (parts.every((p) => /^\d+$/.test(p))) {
        return parts.map((o) => parseInt(o, 10)).join(".");
      }
    }
  }

  return content;
}

// --- PowerDNS Data Fetching ---

/**
 * Fetch current RRSets for a specific subdomain from PowerDNS.
 */
async function getSubdomainRRSets(
  subdomain: string
): Promise<PdnsApiGetRRSet[]> {
  try {
    const response = await pdnsClient.get(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}`
    );
    const allRRSets: PdnsApiGetRRSet[] = response.data.rrsets || [];
    const targetFqdn = subdomainToFqdn(subdomain);

    // Filter to matching FQDN only (excluding SOA and NS)
    return allRRSets.filter(
      (rr) =>
        rr.name.toLowerCase() === targetFqdn &&
        rr.type !== "SOA" &&
        rr.type !== "NS"
    );
  } catch (error) {
    console.error(`Warning: Failed to fetch RRSets for ${subdomain}`);
    return [];
  }
}

/**
 * Fetch the current SOA serial. Returns 0 if not found.
 */
async function getCurrentSoaSerial(): Promise<number> {
  try {
    const response = await pdnsClient.get(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}`
    );
    const rrsets: PdnsApiGetRRSet[] = response.data.rrsets || [];
    // Find SOA record
    const soaRR = rrsets.find((rr) => rr.type === "SOA");

    if (soaRR && soaRR.records.length > 0) {
      const content = soaRR.records[0].content;
      // SOA format: ns1.xxx email.xxx SERIAL refresh retry expire min_ttl
      const parts = content.split(/\s+/);
      if (parts.length >= 3) {
        return parseInt(parts[2], 10);
      }
    }
    return 0;
  } catch (error) {
    console.error("Warning: Failed to fetch SOA Serial");
    return 0;
  }
}

// --- File Loading ---

async function loadRecordFile(filePath: string): Promise<RecordSignature[]> {
  try {
    const fileContent = await fs.readFile(filePath, "utf-8");
    const data: any = JSON.parse(fileContent);

    if (
      !data ||
      typeof data !== "object" ||
      !("record" in data) ||
      !Array.isArray(data.record)
    ) {
      console.warn(`Skipping invalid structure: ${filePath}`);
      return [];
    }

    const subdomain = getSubdomainFromPath(filePath);

    // Subdomain is already lowercased by getSubdomainFromPath

    const signatures: RecordSignature[] = [];
    const ipv4Regex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;

    for (const def of data.record) {
      const type = def.type.toUpperCase();

      // Validate A record
      if (type === "A" && typeof def.value === "string") {
        if (!ipv4Regex.test(def.value)) {
          console.warn(`⚠️ Invalid IP in ${filePath}: ${def.value}`);
          continue;
        }
      }

      if (type === "MX" && isMxRecordValue(def.value)) {
        signatures.push({
          subdomain,
          type,
          content: def.value.exchange,
          priority: def.value.priority,
        });
      } else if (typeof def.value === "string") {
        signatures.push({
          subdomain,
          type,
          content: def.value,
        });
      }
    }
    return signatures;
  } catch (error) {
    console.error(`Error loading file ${filePath}: ${error}`);
    return [];
  }
}

// --- Main Logic ---

async function processChanges(): Promise<void> {
  console.log("=== Starting Incremental DNS Update Process ===");
  console.log(
    `Added: ${ADDED_FILES.length}, Modified: ${MODIFIED_FILES.length}, Deleted: ${DELETED_FILES.length}`
  );

  const patchPayload: PdnsApiPatchRRSet[] = [];
  const processedSubdomains = new Set<string>();

  // 1. Handle DELETEs
  for (const file of DELETED_FILES) {
    const subdomain = getSubdomainFromPath(file);
    if (processedSubdomains.has(subdomain)) continue;

    console.log(`Processing Deletion for: ${subdomain}`);
    // Fetch existing records and create delete requests
    const existingRRSets = await getSubdomainRRSets(subdomain);
    for (const rrset of existingRRSets) {
      patchPayload.push({
        name: rrset.name,
        type: rrset.type,
        ttl: DEFAULT_TTL,
        changetype: "DELETE",
        records: [],
      });
    }
    processedSubdomains.add(subdomain);
  }

  // 2. Handle ADDs / MODIFYs
  const filesToProcess = [...new Set([...ADDED_FILES, ...MODIFIED_FILES])];

  // Query target subdomains on demand rather than fetching everything
  // (full fetch is inefficient for incremental updates)

  for (const file of filesToProcess) {
    const filePath = path.join(WORKSPACE_PATH, file);
    const subdomain = getSubdomainFromPath(file);

    if (processedSubdomains.has(subdomain)) continue;

    const newRecords = await loadRecordFile(filePath);
    if (newRecords.length === 0) continue;

    const fqdn = subdomainToFqdn(subdomain);
    console.log(`Processing Update for: ${fqdn}`);

    // Fetch existing records from PowerDNS (for conflict prevention and ALIAS detection)
    const existingRRSets = await getSubdomainRRSets(subdomain);
    const existingTypes = new Set(existingRRSets.map((r) => r.type));

    // Group records by type
    const recordsByType = new Map<string, RecordSignature[]>();
    for (const r of newRecords) {
      if (!recordsByType.has(r.type)) recordsByType.set(r.type, []);
      recordsByType.get(r.type)!.push(r);
    }

    // Process each type
    for (const [type, records] of recordsByType.entries()) {
      let finalType = type;
      let finalRecords = records;

      // 2-1. CNAME logic
      if (type === "CNAME") {
        // (A) Deduplicate CNAMEs
        if (records.length > 1) {
          console.warn(`⚠️ Multiple CNAMEs for ${fqdn}. Using first.`);
          finalRecords = [records[0]];
        }

        const hasIPInFile = recordsByType.has("A") || recordsByType.has("AAAA");

        // (B) If A records exist in the same file, ignore CNAME (A takes priority)
        if (hasIPInFile) {
          console.warn(`⚠️ Conflict: CNAME & IP in ${file}. Ignoring CNAME.`);
          continue;
        }

        // (C) CNAME -> ALIAS conversion conditions
        // 1. Root domain
        if (subdomain === "@") {
          console.log(`✨ Root CNAME -> ALIAS for ${fqdn}`);
          finalType = "ALIAS";
        }
        // 2. Mixed with other types (TXT, MX, etc.) - check existing PDNS state
        else if (existingTypes.size > 0 && !existingTypes.has("CNAME")) {
          // Other records (A, TXT, etc.) already exist but we're adding a CNAME -> convert to ALIAS for coexistence
          console.log(`✨ CNAME -> ALIAS (Mixed types) for ${fqdn}`);
          finalType = "ALIAS";
        }

        // Stale type cleanup is handled after the type loop below
      }

      patchPayload.push({
        name: fqdn,
        type: finalType,
        ttl: DEFAULT_TTL,
        changetype: "REPLACE",
        records: finalRecords.map((r) => ({
          content: normalizeContent(r.type, r.content),
          disabled: false,
          priority: r.priority,
        })),
      });
    }

    // Delete existing record types that are no longer in the record file
    // This ensures the subdomain is fully synced (e.g., old CNAME removed when switching to A)
    const newTypes = new Set(
      Array.from(recordsByType.keys()).map((t) => {
        // Account for CNAME -> ALIAS conversion
        if (t === "CNAME") {
          const hasIP = recordsByType.has("A") || recordsByType.has("AAAA");
          if (hasIP) return null; // CNAME was ignored
          if (subdomain === "@") return "ALIAS";
        }
        return t;
      }).filter((t): t is string => t !== null)
    );

    for (const existType of existingTypes) {
      if (!newTypes.has(existType)) {
        console.log(`🧹 Cleanup: Deleting stale ${existType} for ${fqdn}`);
        patchPayload.push({
          name: fqdn,
          type: existType,
          ttl: DEFAULT_TTL,
          changetype: "DELETE",
          records: [],
        });
      }
    }

    processedSubdomains.add(subdomain);
  }

  // 3. Merge vendor subdomain files (_{vendor}.{X}.json -> _{vendor}.is-an.ai RRSet)
  mergeVendorEntries(patchPayload);

  // 4. Filter and send
  if (patchPayload.length === 0) {
    console.log("✓ No changes detected.");
    return;
  }

  // [Protection] Infrastructure subdomains that must not be deleted by incremental updates
  const PROTECTED_SUBDOMAINS = new Set([
    "@", "www", "ns1", "ns2", "api", "dashboard",
    "_acme-challenge", "_acme-challenge.api",
    "_vercel", "_domainkey", "_dmarc", "_github-challenge-is-an-ai",
  ]);

  const normName = (n: string) => n.toLowerCase().replace(/\.$/, "");

  const finalPayload = patchPayload.filter((item) => {
    const subdomain = normName(item.name).replace(`.${normName(PDNS_ZONE)}`, "") || "@";
    const isProtected = PROTECTED_SUBDOMAINS.has(subdomain);
    if (isProtected && item.changetype === "DELETE") {
      console.log(`🛡️ Protected record filtered: ${item.name} (${item.type})`);
      return false;
    }
    return true;
  });

  if (finalPayload.length === 0) {
    console.log("✓ No changes after filtering protected domains.");
    return;
  }

  // Sort: DELETEs before REPLACEs to avoid conflicts (e.g., CNAME must be removed before adding A)
  finalPayload.sort((a, b) => {
    if (a.changetype === "DELETE" && b.changetype !== "DELETE") return -1;
    if (a.changetype !== "DELETE" && b.changetype === "DELETE") return 1;
    return 0;
  });

  // 4. [Core] Smart SOA serial update
  // Changes are finalized, so update the SOA.
  console.log("🔄 Calculating new SOA Serial...");

  const currentSerial = await getCurrentSoaSerial();
  const today = new Date();
  const YYYY = today.getFullYear();
  const MM = String(today.getMonth() + 1).padStart(2, "0");
  const DD = String(today.getDate()).padStart(2, "0");
  const todayPrefix = parseInt(`${YYYY}${MM}${DD}`, 10);

  // Parse current serial (assuming YYYYMMDDNN format)
  // e.g., 2026010101 -> prefix: 20260101, suffix: 01
  let newSerial: number;

  const currentSerialStr = String(currentSerial);

  if (
    currentSerialStr.length === 10 &&
    currentSerialStr.startsWith(`${todayPrefix}`)
  ) {
    // Already deployed today -> increment existing value
    newSerial = currentSerial + 1;
    console.log(
      `📆 Updated existing serial for today: ${currentSerial} -> ${newSerial}`
    );
  } else {
    // First deployment today or different format -> today's date + 01
    newSerial = parseInt(`${todayPrefix}01`, 10);
    console.log(`📆 New serial for today: ${newSerial}`);
  }

  // Add SOA record
  finalPayload.push({
    name: PDNS_ZONE + ".",
    type: "SOA",
    ttl: 3600,
    changetype: "REPLACE",
    records: [
      {
        // Note: ns1, hostmaster, etc. should be adjusted to match your environment
        // [Important] The last number (300) is the Negative Cache TTL (keep it short)
        content: `ns1.is-an.ai. hostmaster.is-an.ai. ${newSerial} 10800 3600 604800 ${SOA_MIN_TTL}`,
        disabled: false,
      },
    ],
  });

  // 5. Execute
  const success = await executePdnsPatch(finalPayload);
  if (!success) process.exit(1);

  // 6. Send NOTIFY - trigger immediate zone transfer to secondaries (HE, etc.)
  await sendPdnsNotify();

  console.log("\n✓ Incremental update completed successfully!");
}

/**
 * Send PowerDNS NOTIFY to trigger immediate AXFR on secondary nameservers (HE, etc.).
 * Without NOTIFY, secondaries may wait hours or a full day to pick up SOA serial changes.
 */
async function sendPdnsNotify(): Promise<void> {
  try {
    await pdnsClient.put(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}/notify`
    );
    console.log("✓ NOTIFY sent to secondaries (HE, etc.) - zone propagation triggered");
  } catch (error: any) {
    // NOTIFY failure is non-fatal - secondaries will sync via AXFR later
    console.warn(
      "⚠️ Failed to send NOTIFY (zone is already updated):",
      error.response?.data?.error || error.message
    );
  }
}

async function executePdnsPatch(
  payload: PdnsApiPatchRRSet[]
): Promise<boolean> {
  console.log(`\n=== Executing PowerDNS PATCH (${payload.length} items) ===`);
  try {
    await pdnsClient.patch(`/api/v1/servers/localhost/zones/${PDNS_ZONE}`, {
      rrsets: payload,
    });
    console.log("✓ Update successful!");
    return true;
  } catch (error: any) {
    console.error(
      "✗ PATCH Failed:",
      error.response?.data?.error || error.message
    );
    return false;
  }
}

// --- Vendor Subdomain Merge Logic ---

// Regex to match _{vendor}.{base}.is-an.ai. pattern
const VENDOR_PATTERN = /^_([a-z0-9]+)\..+$/;

/**
 * Merges TXT records from individual _{vendor}.{subdomain} files into per-vendor
 * RRSets. For example, _vercel.myapp and _vercel.other both merge into _vercel.is-an.ai,
 * while _discord.myapp merges into _discord.is-an.ai.
 *
 * For DELETE cases, the full sync will reconcile the vendor RRSets.
 */
function mergeVendorEntries(payload: PdnsApiPatchRRSet[]): void {
  const zoneSuffix = `.${PDNS_ZONE.replace(/\.$/, "")}`;
  const indicesToRemove: number[] = [];
  // vendor name -> { records: PdnsApiPatchRecord[], hasDelete: boolean }
  const vendorMap = new Map<string, { records: PdnsApiPatchRecord[]; hasDelete: boolean }>();

  for (let i = 0; i < payload.length; i++) {
    const item = payload[i];
    const normName = item.name.toLowerCase().replace(/\.$/, "");

    // Extract vendor from names like _vercel.myapp.is-an.ai
    // Skip names that are exactly _{vendor}.is-an.ai (the merge target itself)
    const withoutZone = normName.endsWith(zoneSuffix)
      ? normName.slice(0, -zoneSuffix.length)
      : null;
    if (!withoutZone) continue;

    const vendorMatch = withoutZone.match(VENDOR_PATTERN);
    if (!vendorMatch) continue;

    const vendorName = vendorMatch[1];
    indicesToRemove.push(i);

    if (!vendorMap.has(vendorName)) {
      vendorMap.set(vendorName, { records: [], hasDelete: false });
    }
    const vendor = vendorMap.get(vendorName)!;

    if (item.changetype === "DELETE") {
      vendor.hasDelete = true;
    } else {
      for (const record of item.records) {
        if (!record.disabled) {
          vendor.records.push(record);
        }
      }
    }
  }

  if (indicesToRemove.length === 0) return;

  // Remove individual entries from payload in reverse order
  for (let i = indicesToRemove.length - 1; i >= 0; i--) {
    payload.splice(indicesToRemove[i], 1);
  }

  // Add merged RRSet per vendor
  for (const [vendorName, { records, hasDelete }] of vendorMap) {
    const vendorFqdn = subdomainToFqdn(`_${vendorName}`);

    if (records.length > 0) {
      payload.push({
        name: vendorFqdn,
        type: "TXT",
        ttl: DEFAULT_TTL,
        changetype: "REPLACE",
        records,
      });
      console.log(`✨ Merged ${records.length} _${vendorName} TXT records into ${vendorFqdn}`);
    }

    if (hasDelete) {
      console.log(
        `⚠️ _${vendorName} subdomain deleted. Full sync will reconcile ${vendorFqdn} TXT records.`
      );
    }
  }
}

// --- Run ---
processChanges().catch((err) => {
  console.error(err);
  process.exit(1);
});
