import { promises as fs } from "fs";
import path from "path";
import axios, { AxiosInstance } from "axios";

// --- PowerDNS API 5.0 Interfaces ---
// (Based on https://doc.powerdns.com/authoritative/http-api/index.html)

/**
 * PDNS API GET /zones/{zone_id} 응답의 RRSet 내 Record 객체
 * (GET 응답에서는 priority가 content에 포함됩니다)
 */
interface PdnsApiGetRecord {
  content: string;
  disabled: boolean;
}

/**
 * PDNS API GET /zones/{zone_id} 응답의 RRSet 객체
 */
interface PdnsApiGetRRSet {
  name: string; // FQDN (e.g., "test.grrr.site.")
  type: string; // "A", "MX", etc.
  ttl: number;
  records: PdnsApiGetRecord[];
}

/**
 * PDNS API PATCH /zones/{zone_id} 요청의 Record 객체
 * (PATCH 요청에서는 priority가 별도 필드입니다)
 */
interface PdnsApiPatchRecord {
  content: string;
  disabled: boolean;
  priority?: number; // For MX/SRV records
}

/**
 * PDNS API PATCH /zones/{zone_id} 요청의 RRSet 객체
 */
interface PdnsApiPatchRRSet {
  name: string; // FQDN (e.g., "test.grrr.site.")
  type: string;
  ttl: number; // TTL (e.g., 300)
  changetype: "REPLACE" | "DELETE";
  records: PdnsApiPatchRecord[];
}

// --- Repository Record Interfaces (Original) ---
// Git 저장소의 JSON 파일 구조를 정의합니다. (유지)

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

/**
 * 스크립트 내부에서 상태 비교를 위해 사용하는 표준 형식
 */
interface RecordSignature {
  subdomain: string; // "@", "test", "www"
  type: string; // "A", "MX"
  content: string; // "1.2.3.4", "mail.example.com."
  priority?: number; // 10
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

// Git 저장소에 없더라도 PDNS에서 삭제하지 않고 보호할 하위 도메인 (유지)
const PROTECTED_SUBDOMAINS = new Set(["@", "www", "ns1", "dev", "blog", "api"]);
const DEFAULT_TTL = 300; // PDNS에 설정할 기본 TTL

// --- PowerDNS API Client (신규) ---
const pdnsClient: AxiosInstance = axios.create({
  baseURL: PDNS_API_URL,
  headers: {
    "X-API-Key": PDNS_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 30000, // 30초 타임아웃 (무한 대기 방지)
});

// --- Helper Functions (대부분 유지) ---

/**
 * 파일 경로에서 하위 도메인을 추출합니다.
 * "test.grrr.site.json" -> "test"
 * "grrr.site.json" -> "@"
 */
function getSubdomainFromPath(filePath: string): string {
  const filename = path.basename(filePath, ".json");
  const baseDomainPattern = `.${PDNS_ZONE.slice(0, -1)}`; // ".grrr.site"

  if (filename.endsWith(baseDomainPattern)) {
    return filename.slice(0, -baseDomainPattern.length);
  }

  // Apex/Root domain (e.g., "grrr.site.json")
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

/**
 * 레코드 비교를 위한 고유 시그니처(키)를 생성합니다. (유지)
 */
function createRecordSignature(record: RecordSignature): string {
  const { subdomain, type, content, priority } = record;
  return priority !== undefined
    ? `${subdomain}:${type}:${content}:${priority}`
    : `${subdomain}:${type}:${content}`;
}

/**
 * FQDN을 하위 도메인으로 변환합니다.
 * "test.grrr.site." -> "test"
 * "grrr.site." -> "@"
 */
function fqdnToSubdomain(fqdn: string): string {
  if (fqdn === PDNS_ZONE) {
    return "@";
  }
  return fqdn.replace(`.${PDNS_ZONE}`, "");
}

/**
 * 하위 도메인을 FQDN으로 변환합니다.
 * "test" -> "test.grrr.site."
 * "@" -> "grrr.site."
 */
function subdomainToFqdn(subdomain: string): string {
  if (subdomain === "@") {
    return PDNS_ZONE;
  }
  return `${subdomain}.${PDNS_ZONE}`;
}

// --- PowerDNS API Functions (신규 / 대체) ---

/**
 * PDNS API에서 모든 RRSet을 가져옵니다.
 * (fetchAllCloudflareRecords 대체)
 */
async function fetchAllPdnsRRSets(): Promise<PdnsApiGetRRSet[]> {
  console.log("Fetching all DNS RRSet from PowerDNS...");
  try {
    // PDNS 5.0 API: /api/v1/servers/{server_id}/zones/{zone_id}
    const response = await pdnsClient.get(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}`
    );

    // API 응답에서 rrsets 배열만 반환
    const rrsets: PdnsApiGetRRSet[] = response.data.rrsets || [];

    // SOA, NS 레코드는 이 스크립트로 관리하지 않도록 제외
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
        console.error("   네트워크 연결 또는 PowerDNS 서버 상태를 확인하세요.");
      } else if (error.response) {
        console.error("Response status:", error.response.status);
        console.error("Response data:", error.response.data);
      } else if (error.request) {
        console.error("❌ PowerDNS 서버에 연결할 수 없습니다.");
        console.error("   서버가 실행 중인지, 네트워크 연결을 확인하세요.");
      }
    }
    throw error;
  }
}

/**
 * PDNS API (GET) 응답 RRSet을 내부 RecordSignature 배열로 변환합니다.
 * (convertCloudflareToSignature 대체)
 */
function convertPdnsRRSetToSignatures(
  rrset: PdnsApiGetRRSet
): RecordSignature[] {
  const signatures: RecordSignature[] = [];
  const subdomain = fqdnToSubdomain(rrset.name);

  for (const record of rrset.records) {
    let content = record.content;
    let priority: number | undefined;

    // PDNS (GET)의 MX 레코드는 "10 mail.example.com." 형식입니다.
    // 이를 파싱하여 priority와 content로 분리합니다.
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

/**
 * Git 저장소의 JSON 파일들을 읽어 Map으로 반환합니다. (유지)
 */
async function loadAllRepositoryRecords(): Promise<
  Map<string, RecordSignature[]>
> {
  console.log("Loading all repository records...");

  const recordsDir = path.join(WORKSPACE_PATH, "records");
  // Map<subdomain, RecordSignature[]>
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
        console.warn(
          `Could not determine subdomain for file ${file}, skipping`
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

/**
 * 계산된 변경 사항(RRSet 페이로드)을 PDNS API에 PATCH 요청으로 전송합니다.
 * (createDNSRecord, deleteDNSRecord 대체)
 */
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
    // PDNS 5.0 API: PATCH /api/v1/servers/{server_id}/zones/{zone_id}
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
        console.error("   네트워크 연결 또는 PowerDNS 서버 상태를 확인하세요.");
      } else if (error.response) {
        console.error("Status:", error.response.status);
        console.error("Data:", JSON.stringify(error.response.data, null, 2));
      } else if (error.request) {
        console.error("❌ PowerDNS 서버에 연결할 수 없습니다.");
        console.error("   서버가 실행 중인지, 네트워크 연결을 확인하세요.");
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error:", message);
    }
    return false;
  }
}

// --- Main Sync Logic (수정) ---

async function syncDNSRecords(): Promise<void> {
  console.log("=== Starting DNS Sync Process for PowerDNS ===");

  // 1. 양쪽 상태 로드
  const [pdnsRRSets, repositoryRecordsMap] = await Promise.all([
    fetchAllPdnsRRSets(),
    loadAllRepositoryRecords(), // Map<subdomain, RecordSignature[]>
  ]);

  // 2. PDNS 상태를 비교 가능한 Map으로 변환
  // Map<signatureKey, RecordSignature>
  const pdnsSignatures = new Map<string, RecordSignature>();
  for (const rrset of pdnsRRSets) {
    const signatures = convertPdnsRRSetToSignatures(rrset);
    for (const sig of signatures) {
      pdnsSignatures.set(createRecordSignature(sig), sig);
    }
  }

  // 3. Git 저장소 상태를 비교 가능한 Map으로 변환
  // Map<signatureKey, RecordSignature>
  const repositorySignatures = new Map<string, RecordSignature>();
  // Map<"subdomain:type", boolean> (변경이 필요한 RRSet을 추적)
  const changedRrsetKeys = new Map<
    string,
    { subdomain: string; type: string }
  >();

  for (const [subdomain, records] of repositoryRecordsMap.entries()) {
    for (const record of records) {
      // 레코드 유효성 검사 (원본 함수 재사용)
      // const validationError = validateRecordContent(record); // validateRecordContent 함수를 위쪽에 복붙했다면 사용
      // if (validationError) { ... }

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

  // 생성: Git에는 있지만 PDNS에는 없는 레코드
  for (const [key, signature] of repositorySignatures) {
    if (!pdnsSignatures.has(key)) {
      toCreate.push(signature);
    }
  }

  // 삭제: PDNS에는 있지만 Git에는 없는 레코드
  for (const [key, signature] of pdnsSignatures) {
    if (!repositorySignatures.has(key)) {
      // 보호된 하위 도메인인지 확인
      if (PROTECTED_SUBDOMAINS.has(signature.subdomain)) {
        console.log(
          `🛡️ Protecting system subdomain: ${signature.subdomain} (${signature.type})`
        );
        protectedCount++;
        continue;
      }
      toDelete.push(signature);
      // 삭제할 레코드가 속한 RRSet도 변경 목록에 추가
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
  // PDNS는 RRSet 단위로만 작동하므로,
  // toCreate/toDelete에 레코드가 *하나라도* 포함된 RRSet은
  // Git 저장소의 상태로 *통째로* 덮어써야(REPLACE) 합니다.

  const patchPayload: PdnsApiPatchRRSet[] = [];

  for (const { subdomain, type } of changedRrsetKeys.values()) {
    const fqdn = subdomainToFqdn(subdomain);

    // 이 RRSet에 대해 Git 저장소에 정의된 최종 레코드 목록
    const repoRecordsForRrset =
      repositoryRecordsMap.get(subdomain)?.filter((r) => r.type === type) || [];

    if (repoRecordsForRrset.length > 0) {
      // Git 저장소에 레코드가 1개 이상 존재: REPLACE
      // (기존 레코드를 모두 지우고 새 레코드로 교체)
      patchPayload.push({
        name: fqdn,
        type: type,
        ttl: DEFAULT_TTL,
        changetype: "REPLACE",
        // PDNS API (PATCH) 형식에 맞게 변환
        records: repoRecordsForRrset.map((r) => ({
          content: r.content,
          disabled: false,
          priority: r.priority, // MX 레코드의 경우 priority 포함
        })),
      });
    } else {
      // Git 저장소에 해당 RRSet 정의가 없음: DELETE
      // (해당 RRSet 전체 삭제)
      patchPayload.push({
        name: fqdn,
        type: type,
        ttl: DEFAULT_TTL,
        changetype: "DELETE",
        records: [], // DELETE 시 records는 비어 있어야 함
      });
    }
  }

  if (patchPayload.length === 0) {
    console.log("✓ DNS records are already in sync!");
    return;
  }

  // 6. 변경 사항 실행
  const success = await executePdnsPatch(patchPayload);

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
    // 에러 발생 시에도 정상적으로 종료 (exit code 1)
    process.exit(1);
  });
