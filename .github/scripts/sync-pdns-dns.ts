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

const PDNS_API_KEY: string = getEnvVariable("PDNS_API_KEY");
const PDNS_API_URL: string = getEnvVariable("PDNS_API_URL");
const PDNS_ZONE: string = getEnvVariable("PDNS_ZONE");
const WORKSPACE_PATH: string = getEnvVariable("GITHUB_WORKSPACE");
const DRY_RUN: boolean = process.env.DRY_RUN === "true";

// Infrastructure records managed in code, always REPLACE'd during sync.
// These are NOT in the records/ directory — they are system-owned.
const INFRA_RECORDS: { subdomain: string; type: string; content: string; ttl?: number }[] = [
  // Root domain (Cloudflare Pages)
  { subdomain: "@", type: "A", content: "172.67.69.118" },
  { subdomain: "@", type: "A", content: "104.26.0.194" },
  { subdomain: "@", type: "A", content: "104.26.1.194" },
  // www -> root
  { subdomain: "www", type: "CNAME", content: "is-an.ai." },
  // API (Cloudflare Workers)
  { subdomain: "api", type: "CNAME", content: "is-an-ai-worker-production.doridori.workers.dev." },
  // Dashboard
  { subdomain: "dashboard", type: "A", content: "211.41.195.15" },
  // ACME challenge for Cloudflare Advanced Certificate (*.is-an.ai, api.is-an.ai, is-an.ai)
  { subdomain: "_acme-challenge", type: "TXT", content: "LKLOgAdulsnmWEEBI2P16PavXOwUW9kiSei3VWwr-EY" },
  { subdomain: "_acme-challenge.api", type: "TXT", content: "g5MmzXYz494cUXh9hMXhpkbq-h9k22qN6i3DgD7ndWs" },
  { subdomain: "_acme-challenge.api", type: "TXT", content: "_2Zmb5xDRilYX5fHQ4EemA4sxab9LRyAujOS4VZ78Uk" },
];

const INFRA_SUBDOMAINS = new Set(INFRA_RECORDS.map((r) => r.subdomain));

const DEFAULT_TTL = 300; // Default TTL for PDNS records
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

// --- Helper Functions ---
function getSubdomainFromPath(filePath: string): string {
  const filename = path.basename(filePath, ".json");
  const baseDomain = PDNS_ZONE.replace(/\.$/, ""); // Remove trailing dot
  const baseDomainPattern = `.${baseDomain}`; // ".is-an.ai"

  let subdomain = filename;
  if (filename.endsWith(baseDomainPattern)) {
    subdomain = filename.slice(0, -baseDomainPattern.length);
  } else if (filename === baseDomain) {
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

function createRecordSignature(record: RecordSignature): string {
  const { subdomain, type, content, priority } = record;
  return priority !== undefined
    ? `${subdomain}:${type}:${content}:${priority}`
    : `${subdomain}:${type}:${content}`;
}

function fqdnToSubdomain(fqdn: string): string {
  if (fqdn === PDNS_ZONE) {
    return "@";
  }
  return fqdn.replace(`.${PDNS_ZONE}`, "");
}

function subdomainToFqdn(subdomain: string): string {
  while (subdomain.startsWith(".")) {
    subdomain = subdomain.slice(1);
  }
  while (subdomain.endsWith(".")) {
    subdomain = subdomain.slice(0, -1);
  }

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

function normalizeContent(type: string, content: string): string {
  const typesNeedingDot = ["CNAME", "MX", "NS", "SRV", "PTR"];
  const upperType = type.toUpperCase();

  if (typesNeedingDot.includes(type.toUpperCase())) {
    if (!content.endsWith(".")) {
      return content + ".";
    }
  }
  if (upperType === "TXT") {
    let cleanContent = content;
    if (cleanContent.includes(" IN TXT ")) {
      const parts = cleanContent.split(" IN TXT ");
      if (parts.length > 1) {
        cleanContent = parts[1].trim();
      }
    }
    if (cleanContent.startsWith('"') && cleanContent.endsWith('"')) {
      cleanContent = cleanContent.slice(1, -1);
    }
    return `"${cleanContent}"`;
  }
  if (upperType === "A") {
    if (content.includes(".") && content.split(".").length === 4) {
      return content
        .split(".")
        .map((octet) => parseInt(octet, 10))
        .join(".");
    }
  }
  return content;
}

// --- PowerDNS API Functions ---

async function fetchAllPdnsRRSets(): Promise<PdnsApiGetRRSet[]> {
  console.log("Fetching all DNS RRSet from PowerDNS...");
  try {
    const response = await pdnsClient.get(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}`
    );
    const rrsets: PdnsApiGetRRSet[] = response.data.rrsets || [];
    const managedRRSets = rrsets.filter(
      (rr) => rr.type !== "SOA" && rr.type !== "NS"
    );
    console.log(`Found ${managedRRSets.length} managed RRSets in PowerDNS`);
    return managedRRSets;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching PowerDNS RRSet:", message);
    if (error && typeof error === "object" && axios.isAxiosError(error)) {
      if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
        console.error("❌ PowerDNS API request timed out (exceeded 30s)");
      } else if (error.response) {
        console.error("Response status:", error.response.status);
        console.error("Response data:", error.response.data);
      } else if (error.request) {
        console.error("❌ Unable to connect to PowerDNS server.");
      }
    }
    throw error;
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
  } catch (error: unknown) {
    console.error("Warning: Failed to fetch SOA Serial");
    return 0;
  }
}

/**
 * Convert a PDNS API (GET) response RRSet into internal RecordSignature array.
 * (Replaces convertCloudflareToSignature)
 */
function convertPdnsRRSetToSignatures(
  rrset: PdnsApiGetRRSet
): RecordSignature[] {
  const signatures: RecordSignature[] = [];
  const subdomain = fqdnToSubdomain(rrset.name);

  for (const record of rrset.records) {
    let content = record.content;
    let priority: number | undefined;

    if (rrset.type === "MX" && record.content) {
      const parts = record.content.split(" ");
      if (parts.length === 2) {
        priority = parseInt(parts[0], 10);
        content = parts[1];
      }
    }
    signatures.push({
      subdomain,
      type: rrset.type,
      content,
      priority,
    });
  }
  return signatures;
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

      if (!subdomain) {
        console.warn(`Could not determine subdomain for file ${file}, skipping`);
        continue;
      }
      if (subdomain !== subdomain.toLowerCase()) {
        console.log(
          `🔡 '${file}': Converting subdomain to lowercase: ${subdomain} → ${subdomain.toLowerCase()}`
        );
      }

      // _{vendor}.{X} files are mapped to "_{vendor}" subdomain
      // e.g., _vercel.myapp -> _vercel, _discord.myapp -> _discord
      const vendorMatch = subdomain.match(/^(_[a-z0-9]+)\..+$/);
      const effectiveSubdomain = vendorMatch ? vendorMatch[1] : subdomain;

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
          const ipv4Regex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;

          if (type === "A" && typeof recordDef.value === "string") {
            if (!ipv4Regex.test(recordDef.value)) {
              console.warn(
                `⚠️ Skipping invalid A record in '${file}': Value '${recordDef.value}' is not a valid IPv4 address.`
              );
              continue;
            }
          }
          if (type === "MX" && isMxRecordValue(recordDef.value)) {
            signatures.push({
              subdomain: effectiveSubdomain,
              type,
              content: recordDef.value.exchange,
              priority: recordDef.value.priority,
            });
          } else if (typeof recordDef.value === "string") {
            signatures.push({
              subdomain: effectiveSubdomain,
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
        // Append to existing entries (multiple _{vendor}.* files merge into "_{vendor}")
        const existing = recordMap.get(effectiveSubdomain) || [];
        recordMap.set(effectiveSubdomain, [...existing, ...signatures]);
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

async function executePdnsPatch(
  payload: PdnsApiPatchRRSet[]
): Promise<boolean> {
  console.log(`\n=== Executing PowerDNS PATCH ===`);
  console.log(`Sending ${payload.length} RRSet changes...`);

  if (DRY_RUN) {
    console.log("[DRY RUN] Would send the following PATCH payload:");
    console.log(JSON.stringify({ rrsets: payload }, null, 2));
    return true;
  }

  try {
    await pdnsClient.patch(`/api/v1/servers/localhost/zones/${PDNS_ZONE}`, {
      rrsets: payload,
    });
    console.log("✓ PowerDNS update successful!");
    return true;
  } catch (error: unknown) {
    console.error("✗ Failed to execute PowerDNS PATCH:");
    if (error && typeof error === "object" && axios.isAxiosError(error)) {
      if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
        console.error("❌ PowerDNS API request timed out (exceeded 30s)");
      } else if (error.response) {
        console.error("Status:", error.response.status);
        console.error("Data:", JSON.stringify(error.response.data, null, 2));
      } else if (error.request) {
        console.error("❌ Unable to connect to PowerDNS server.");
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error:", message);
    }
    return false;
  }
}

// --- Main Sync Logic (Fixed Order) ---

async function syncDNSRecords(): Promise<void> {
  console.log("=== Starting DNS Sync Process for PowerDNS ===");

  // 1. Load state from both sides
  const [pdnsRRSets, repositoryRecordsMap] = await Promise.all([
    fetchAllPdnsRRSets(),
    loadAllRepositoryRecords(),
  ]);

  // 1.5. Inject infrastructure records into the repository map
  for (const infra of INFRA_RECORDS) {
    const existing = repositoryRecordsMap.get(infra.subdomain) || [];
    existing.push({
      subdomain: infra.subdomain,
      type: infra.type,
      content: infra.content,
    });
    repositoryRecordsMap.set(infra.subdomain, existing);
  }
  console.log(`Injected ${INFRA_RECORDS.length} infrastructure records`);

  // 2. Convert PDNS state into a comparable Map
  const pdnsSignatures = new Map<string, RecordSignature>();
  for (const rrset of pdnsRRSets) {
    const signatures = convertPdnsRRSetToSignatures(rrset);
    for (const sig of signatures) {
      pdnsSignatures.set(createRecordSignature(sig), sig);
    }
  }

  // 3. Convert Git repository state and track changed keys
  const repositorySignatures = new Map<string, RecordSignature>();
  const changedRrsetKeys = new Map<
    string,
    { subdomain: string; type: string }
  >();

  for (const [subdomain, records] of repositoryRecordsMap.entries()) {
    for (const record of records) {
      repositorySignatures.set(createRecordSignature(record), record);
      const rrsetKey = `${subdomain}:${record.type}`;
      if (!changedRrsetKeys.has(rrsetKey)) {
        changedRrsetKeys.set(rrsetKey, { subdomain, type: record.type });
      }
    }
  }

  console.log(`Repository records (flattened): ${repositorySignatures.size}`);
  console.log(`PowerDNS records (flattened): ${pdnsSignatures.size}`);

  // 4. Calculate diff
  const toCreate: RecordSignature[] = [];
  const toDelete: RecordSignature[] = [];
  let protectedCount = 0;

  // Records to create
  for (const [key, signature] of repositorySignatures) {
    if (!pdnsSignatures.has(key)) {
      toCreate.push(signature);
    }
  }

  // Records to delete
  for (const [key, signature] of pdnsSignatures) {
    if (!repositorySignatures.has(key)) {
      if (INFRA_SUBDOMAINS.has(signature.subdomain)) {
        console.log(
          `🛡️ Protecting system subdomain: ${signature.subdomain} (${signature.type})`
        );
        protectedCount++;
        continue;
      }
      toDelete.push(signature);

      const rrsetKey = `${signature.subdomain}:${signature.type}`;
      if (!changedRrsetKeys.has(rrsetKey)) {
        changedRrsetKeys.set(rrsetKey, {
          subdomain: signature.subdomain,
          type: signature.type,
        });
      }
    }
  }

  console.log(`\n=== Sync Summary ===`);
  console.log(`Individual records to create: ${toCreate.length}`);
  console.log(`Individual records to delete: ${toDelete.length}`);
  if (protectedCount > 0) {
    console.log(`Protected system records (ignored): ${protectedCount}`);
  }

  // 5. Build PowerDNS PATCH payload
  const patchPayload: PdnsApiPatchRRSet[] = [];

  for (const { subdomain, type } of changedRrsetKeys.values()) {
    const fqdn = subdomainToFqdn(subdomain);
    let repoRecordsForRrset =
      repositoryRecordsMap.get(subdomain)?.filter((r) => r.type === type) || [];

    if (repoRecordsForRrset.length > 0) {
      // --- REPLACE logic ---
      if (type === "CNAME" && repoRecordsForRrset.length > 1) {
        console.warn(
          `⚠️ Warning: Multiple CNAMEs found for ${fqdn}. Using only the first one.`
        );
        repoRecordsForRrset = [repoRecordsForRrset[0]];
      }

      let finalType = type;
      if (type === "CNAME") {
        const allRecords = repositoryRecordsMap.get(subdomain) || [];
        const hasIPRecords = allRecords.some(
          (r) => r.type === "A" || r.type === "AAAA"
        );

        if (hasIPRecords) {
          console.warn(
            `⚠️ Conflict: CNAME cannot coexist with A/AAAA. Ignoring CNAME.`
          );
          continue;
        }
        if (fqdn === PDNS_ZONE + "." || fqdn === PDNS_ZONE) finalType = "ALIAS";
        const hasOtherTypes = allRecords.some((r) => r.type !== "CNAME");
        if (hasOtherTypes && finalType === "CNAME") finalType = "ALIAS";
        if (finalType === "CNAME" && subdomain !== "@") {
          const hasChildren = Array.from(repositoryRecordsMap.keys()).some(
            (otherKey) => otherKey.endsWith("." + subdomain)
          );
          if (hasChildren) finalType = "ALIAS";
        }
      }

      patchPayload.push({
        name: fqdn,
        type: finalType,
        ttl: DEFAULT_TTL,
        changetype: "REPLACE",
        records: repoRecordsForRrset.map((r) => ({
          content: normalizeContent(r.type, r.content),
          disabled: false,
          priority: r.priority,
        })),
      });
    } else {
      // --- DELETE logic ---
      patchPayload.push({
        name: fqdn,
        type: type,
        ttl: DEFAULT_TTL,
        changetype: "DELETE",
        records: [],
      });
    }
  }

  if (patchPayload.length === 0) {
    console.log("✓ DNS records are already in sync!");
    return;
  }

  // ---------------------------------------------------------
  // [Core fix] Sort payload: DELETEs must come before REPLACEs
  // ---------------------------------------------------------
  patchPayload.sort((a, b) => {
    // DELETE(-1) comes before REPLACE(1)
    if (a.changetype === "DELETE" && b.changetype !== "DELETE") return -1;
    if (a.changetype !== "DELETE" && b.changetype === "DELETE") return 1;
    return 0;
  });

  // 6. Execute changes (with protection logic)
  // Auto-generate protected FQDNs from INFRA_RECORDS + additional system domains
  const EXTRA_PROTECTED = ["ns1", "ns2", "_vercel", "_domainkey", "_github-challenge-is-an-ai"];
  const PROTECTED_FQDNS = new Set([
    ...Array.from(INFRA_SUBDOMAINS).map((s) => subdomainToFqdn(s)),
    ...EXTRA_PROTECTED.map((s) => subdomainToFqdn(s)),
  ]);

  const finalPayload = patchPayload.filter((item) => {
    const isProtected = PROTECTED_FQDNS.has(item.name);
    if (isProtected && item.changetype === "DELETE") {
      console.log(
        `🛡️ Protected record detected. Skipping deletion for: ${item.name}`
      );
      return false;
    }
    return true;
  });

  if (finalPayload.length === 0) {
    console.log(
      "✓ DNS records are already in sync (Protected records were skipped)."
    );
    return;
  }

  // [Core] Smart SOA serial update - changes exist, so update the SOA.
  // Do not rely on PowerDNS auto-incrementing SOA on zone PATCH;
  // explicitly update using the same logic as update-pdns-dns.ts.
  console.log("🔄 Calculating new SOA Serial...");

  const currentSerial = await getCurrentSoaSerial();
  const today = new Date();
  const YYYY = today.getFullYear();
  const MM = String(today.getMonth() + 1).padStart(2, "0");
  const DD = String(today.getDate()).padStart(2, "0");
  const todayPrefix = parseInt(`${YYYY}${MM}${DD}`, 10);

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
        content: `ns1.is-an.ai. hostmaster.is-an.ai. ${newSerial} 10800 3600 604800 ${SOA_MIN_TTL}`,
        disabled: false,
      },
    ],
  });

  console.log(
    `=== Executing PowerDNS PATCH (${finalPayload.length} changes) ===`
  );

  // [Important] Pass the filtered finalPayload + SOA to the execution function, not patchPayload.
  const success = await executePdnsPatch(finalPayload);

  if (!success) {
    console.error("✗ DNS sync process failed during PowerDNS PATCH.");
    process.exit(1);
  }

  // Send NOTIFY - trigger immediate zone transfer to secondaries (HE, etc.)
  await sendPdnsNotify();

  console.log(`\n✓ DNS sync process completed!`);
}

/**
 * Send PowerDNS NOTIFY to trigger immediate AXFR on secondary nameservers (HE, etc.).
 */
async function sendPdnsNotify(): Promise<void> {
  try {
    await pdnsClient.put(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}/notify`
    );
    console.log("✓ NOTIFY sent to secondaries (HE, etc.) - zone propagation triggered");
  } catch (error: unknown) {
    console.warn(
      "⚠️ Failed to send NOTIFY (zone is already updated):",
      error && typeof error === "object" && "message" in error
        ? (error as Error).message
        : String(error)
    );
  }
}

// --- Main Execution ---
syncDNSRecords()
  .then(() => {
    console.log("\n✓ Script completed successfully");
    process.exit(0);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("\n✗ Unhandled error during DNS sync process:", message);
    if (err instanceof Error && err.stack) {
      console.error("Stack trace:", err.stack);
    }
    process.exit(1);
  });
