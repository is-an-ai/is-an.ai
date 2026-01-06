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

// Git 저장소에 없더라도 PDNS에서 삭제하지 않고 보호할 하위 도메인
const PROTECTED_SUBDOMAINS = new Set(["@", "www", "ns1", "dev", "blog", "api"]);
const DEFAULT_TTL = 300;

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
  const baseDomainPattern = `.${PDNS_ZONE.slice(0, -1)}`;

  let subdomain = filename;
  if (filename.endsWith(baseDomainPattern)) {
    subdomain = filename.slice(0, -baseDomainPattern.length);
  } else if (filename === PDNS_ZONE.slice(0, -1)) {
    subdomain = "@";
  }
  return punycode.toASCII(subdomain);
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
        console.error("❌ PowerDNS API 요청 타임아웃 (30초 초과)");
      } else if (error.response) {
        console.error("Response status:", error.response.status);
        console.error("Response data:", error.response.data);
      } else if (error.request) {
        console.error("❌ PowerDNS 서버에 연결할 수 없습니다.");
      }
    }
    throw error;
  }
}

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
        console.warn(
          `⛔ Skipping '${file}': Filename contains uppercase letters. strict-lowercase policy.`
        );
        continue;
      }

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
        console.error("❌ PowerDNS API 요청 타임아웃 (30초 초과)");
      } else if (error.response) {
        console.error("Status:", error.response.status);
        console.error("Data:", JSON.stringify(error.response.data, null, 2));
      } else if (error.request) {
        console.error("❌ PowerDNS 서버에 연결할 수 없습니다.");
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

  // 1. 양쪽 상태 로드
  const [pdnsRRSets, repositoryRecordsMap] = await Promise.all([
    fetchAllPdnsRRSets(),
    loadAllRepositoryRecords(),
  ]);

  // 2. PDNS 상태를 비교 가능한 Map으로 변환
  const pdnsSignatures = new Map<string, RecordSignature>();
  for (const rrset of pdnsRRSets) {
    const signatures = convertPdnsRRSetToSignatures(rrset);
    for (const sig of signatures) {
      pdnsSignatures.set(createRecordSignature(sig), sig);
    }
  }

  // 3. Git 저장소 상태 변환 및 변경 키 추적
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

  // 4. 변경점 계산 (Diff)
  const toCreate: RecordSignature[] = [];
  const toDelete: RecordSignature[] = [];
  let protectedCount = 0;

  // 생성 목록
  for (const [key, signature] of repositorySignatures) {
    if (!pdnsSignatures.has(key)) {
      toCreate.push(signature);
    }
  }

  // 삭제 목록
  for (const [key, signature] of pdnsSignatures) {
    if (!repositorySignatures.has(key)) {
      if (PROTECTED_SUBDOMAINS.has(signature.subdomain)) {
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

  // 5. PowerDNS PATCH 페이로드 생성
  const patchPayload: PdnsApiPatchRRSet[] = [];

  for (const { subdomain, type } of changedRrsetKeys.values()) {
    const fqdn = subdomainToFqdn(subdomain);
    let repoRecordsForRrset =
      repositoryRecordsMap.get(subdomain)?.filter((r) => r.type === type) || [];

    if (repoRecordsForRrset.length > 0) {
      // --- REPLACE 로직 ---
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
      // --- DELETE 로직 ---
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
  // [★ 핵심 수정] 페이로드 정렬: DELETE가 REPLACE보다 먼저 오도록 함
  // ---------------------------------------------------------
  patchPayload.sort((a, b) => {
    // DELETE(-1)가 REPLACE(1)보다 앞으로 옴
    if (a.changetype === "DELETE" && b.changetype !== "DELETE") return -1;
    if (a.changetype !== "DELETE" && b.changetype === "DELETE") return 1;
    return 0;
  });

  // 6. 변경 사항 실행 (보호 로직 포함)
  const PROTECTED_DOMAINS = [
    "is-an.ai.",
    "www.is-an.ai.",
    "ns1.is-an.ai.",
    "ns2.is-an.ai.",
    "api.is-an.ai.",
    "docs.is-an.ai.",
    "status.is-an.ai.",
    "dashboard.is-an.ai.",
    "assets.is-an.ai.",
    "_dmarc.is-an.ai.",
    "smtp.is-an.ai.",
    "mail.is-an.ai.",
    "_vercel.is-an.ai.",
    "_domainkey.is-an.ai.",
    "_github-challenge-is-an-ai.is-an.ai.",
  ];

  const finalPayload = patchPayload.filter((item) => {
    const isProtected = PROTECTED_DOMAINS.includes(item.name);
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

  console.log(
    `=== Executing PowerDNS PATCH (${finalPayload.length} changes) ===`
  );
  const success = await executePdnsPatch(finalPayload);

  if (!success) {
    console.error("✗ DNS sync process failed during PowerDNS PATCH.");
    process.exit(1);
  }

  console.log(`\n✓ DNS sync process completed!`);
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
