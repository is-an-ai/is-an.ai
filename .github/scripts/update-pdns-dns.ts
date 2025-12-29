import { promises as fs } from "fs";
import path from "path";
import axios, { AxiosInstance } from "axios";

// --- PowerDNS API 5.0 Interfaces ---

interface PdnsApiGetRecord {
  content: string;
  disabled: boolean;
}

interface PdnsApiGetRRSet {
  name: string; // FQDN (e.g., "test.is-an.ai.")
  type: string; // "A", "MX", etc.
  ttl: number;
  records: PdnsApiGetRecord[];
}

interface PdnsApiPatchRecord {
  content: string;
  disabled: boolean;
  priority?: number; // For MX/SRV records
}

interface PdnsApiPatchRRSet {
  name: string; // FQDN (e.g., "test.is-an.ai.")
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
const PDNS_ZONE: string = getEnvVariable("PDNS_ZONE");
const WORKSPACE_PATH: string = getEnvVariable("GITHUB_WORKSPACE");

const ADDED_FILES: string[] = getEnvList("ADDED_FILES");
const MODIFIED_FILES: string[] = getEnvList("MODIFIED_FILES");
const DELETED_FILES: string[] = getEnvList("DELETED_FILES");

const DEFAULT_TTL = 300; // PDNS에 설정할 기본 TTL

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
  const baseDomainPattern = `.${PDNS_ZONE.slice(0, -1)}`; // Remove trailing dot

  if (filename.endsWith(baseDomainPattern)) {
    return filename.slice(0, -baseDomainPattern.length);
  }

  if (filename === PDNS_ZONE.slice(0, -1)) {
    return "@";
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

function subdomainToFqdn(subdomain: string): string {
  if (subdomain === "@") {
    return PDNS_ZONE;
  }
  return `${subdomain}.${PDNS_ZONE}`;
}

/**
 * 특정 서브도메인의 모든 RRSet을 가져옵니다.
 */
async function getSubdomainRRSets(
  subdomain: string
): Promise<PdnsApiGetRRSet[]> {
  try {
    const response = await pdnsClient.get(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}`
    );
    const allRRSets: PdnsApiGetRRSet[] = response.data.rrsets || [];
    const fqdn = subdomainToFqdn(subdomain);

    // 해당 서브도메인의 RRSet만 필터링 (SOA, NS 제외)
    return allRRSets.filter(
      (rr) => rr.name === fqdn && rr.type !== "SOA" && rr.type !== "NS"
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error fetching RRSet for ${subdomain}:`, message);
    return [];
  }
}

/**
 * 파일에서 레코드를 읽어 RecordSignature 배열로 변환합니다.
 */
async function loadRecordFile(filePath: string): Promise<RecordSignature[]> {
  try {
    const fileContent = await fs.readFile(filePath, "utf-8");
    const data: unknown = JSON.parse(fileContent);

    if (
      !data ||
      typeof data !== "object" ||
      !("record" in data) ||
      !Array.isArray((data as RecordFileContent).record)
    ) {
      console.error(`Invalid record structure in file ${filePath}`);
      return [];
    }

    const fileData = data as RecordFileContent;
    const subdomain = getSubdomainFromPath(filePath);
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
      }
    }

    return signatures;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error loading file ${filePath}:`, message);
    return [];
  }
}

/**
 * PowerDNS PATCH 요청을 실행합니다.
 */
async function executePdnsPatch(
  payload: PdnsApiPatchRRSet[]
): Promise<boolean> {
  if (payload.length === 0) {
    console.log("No changes to apply");
    return true;
  }

  console.log(`\n=== Executing PowerDNS PATCH ===`);
  console.log(`Sending ${payload.length} RRSet changes...`);

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

// --- Main Logic ---

async function processChanges(): Promise<void> {
  console.log("=== Starting Incremental DNS Update Process ===");
  console.log(`Added files: ${ADDED_FILES.length}`);
  console.log(`Modified files: ${MODIFIED_FILES.length}`);
  console.log(`Deleted files: ${DELETED_FILES.length}`);

  const patchPayload: PdnsApiPatchRRSet[] = [];
  const processedSubdomains = new Set<string>();

  // 1. 삭제된 파일 처리
  console.log("\n--- Processing Deletions ---");
  for (const file of DELETED_FILES) {
    const subdomain = getSubdomainFromPath(file);
    if (processedSubdomains.has(subdomain)) continue;

    console.log(`Deleting all records for subdomain: ${subdomain}`);
    const existingRRSets = await getSubdomainRRSets(subdomain);

    // 각 RRSet 타입별로 DELETE 요청 생성
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

  // 2. 추가/수정된 파일 처리
  console.log("\n--- Processing Additions/Modifications ---");
  const filesToProcess = [...new Set([...ADDED_FILES, ...MODIFIED_FILES])];

  for (const file of filesToProcess) {
    const filePath = path.join(WORKSPACE_PATH, file);
    const subdomain = getSubdomainFromPath(file);

    if (processedSubdomains.has(subdomain)) {
      console.log(
        `⚠️ Subdomain ${subdomain} already processed, skipping ${file}`
      );
      continue;
    }

    console.log(`Processing ${file} for subdomain: ${subdomain}`);

    // 파일에서 레코드 읽기
    const desiredRecords = await loadRecordFile(filePath);
    if (desiredRecords.length === 0) {
      console.log(`  No valid records in ${file}, skipping`);
      continue;
    }

    // 타입별로 그룹화
    const recordsByType = new Map<string, RecordSignature[]>();
    for (const record of desiredRecords) {
      if (!recordsByType.has(record.type)) {
        recordsByType.set(record.type, []);
      }
      recordsByType.get(record.type)!.push(record);
    }

    // 각 타입별로 RRSet 생성/교체
    for (const [type, records] of recordsByType.entries()) {
      const fqdn = subdomainToFqdn(subdomain);
      patchPayload.push({
        name: fqdn,
        type: type,
        ttl: DEFAULT_TTL,
        changetype: "REPLACE",
        records: records.map((r) => ({
          content: r.content,
          disabled: false,
          priority: r.priority,
        })),
      });
    }

    processedSubdomains.add(subdomain);
  }

  // 3. 변경 사항 적용
  if (patchPayload.length > 0) {
    const success = await executePdnsPatch(patchPayload);
    if (!success) {
      console.error("✗ DNS update process failed");
      process.exit(1);
    }
  } else {
    console.log("\n✓ No changes to apply");
  }

  console.log("\n✓ Incremental DNS update process completed!");
}

// --- Main Execution ---
processChanges()
  .then(() => {
    console.log("\n✓ Script completed successfully");
    process.exit(0);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("\n✗ Unhandled error during DNS update process:", message);
    if (err instanceof Error && err.stack) {
      console.error("Stack trace:", err.stack);
    }
    process.exit(1);
  });
