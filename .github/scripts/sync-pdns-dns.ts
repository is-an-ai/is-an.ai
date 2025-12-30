import { promises as fs } from "fs";
import path from "path";
import axios, { AxiosInstance } from "axios";
import punycode from "punycode";

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
 * 하위 도메인을 FQDN(Canonical)으로 변환합니다.
 * 끝에 반드시 점(.)을 붙여 PowerDNS 에러를 방지합니다.
 */
function subdomainToFqdn(subdomain: string): string {
  while (subdomain.startsWith(".")) {
    subdomain = subdomain.slice(1);
  }
  while (subdomain.endsWith(".")) {
    subdomain = subdomain.slice(0, -1);
  }

  let fqdn;
  if (!subdomain || subdomain === "@" || subdomain.trim() === "") {
    fqdn = PDNS_ZONE; // 예: "grrr.site"
  } else {
    // 3. 내용이 있을 때만 점을 찍고 연결
    fqdn = `${subdomain}.${PDNS_ZONE}`; // 예: "test.grrr.site"
  }

  // ★ 핵심 수정 1: PowerDNS 요구사항에 맞춰 끝에 점(.)이 없으면 붙임
  if (!fqdn.endsWith(".")) {
    fqdn += ".";
  }

  // ★ 핵심 수정 2: DNS는 대소문자 구분 없음 -> 소문자로 통일
  return fqdn.toLowerCase();
}

/**
 * 레코드 내용(Content)을 PowerDNS가 원하는 표준 형식으로 변환합니다.
 * CNAME, MX, NS 등의 경우 값(Value) 끝에 점(.)이 있어야 합니다.
 */
function normalizeContent(type: string, content: string): string {
  // 1. 점(.)을 붙여야 하는 타입들 (CNAME, MX, NS, SRV 등)
  // A, AAAA (IP주소)나 TXT는 점을 붙이면 안 됩니다!
  const typesNeedingDot = ["CNAME", "MX", "NS", "SRV", "PTR"];
  const upperType = type.toUpperCase();

  if (typesNeedingDot.includes(type.toUpperCase())) {
    // 2. 이미 점으로 끝나지 않는다면 점 추가
    if (!content.endsWith(".")) {
      return content + ".";
    }
  }
  if (upperType === "TXT") {
    let cleanContent = content;

    // 만약 "IN TXT" 라는 글자가 포함되어 있다면, 그 뒤에 있는 진짜 내용만 가져옵니다.
    // 예: "example 3600 IN TXT "value"" -> "value"
    if (cleanContent.includes(" IN TXT ")) {
      const parts = cleanContent.split(" IN TXT ");
      if (parts.length > 1) {
        cleanContent = parts[1].trim();
      }
    }

    // 이미 따옴표로 감싸져 있다면, 일단 벗겨냅니다 (중복 따옴표 방지)
    if (cleanContent.startsWith('"') && cleanContent.endsWith('"')) {
      cleanContent = cleanContent.slice(1, -1);
    }

    // 최종적으로 깨끗한 따옴표를 입혀서 반환
    return `"${cleanContent}"`;
  }
  if (upperType === "A") {
    // 점(.)으로 쪼개서 각 숫자를 정수(Integer)로 변환했다가 다시 합칩니다.
    // "02" -> 2, "010" -> 10 으로 바뀝니다.
    // (IPv4 형식인 경우에만 시도)
    if (content.includes(".") && content.split(".").length === 4) {
      return content
        .split(".")
        .map((octet) => parseInt(octet, 10))
        .join(".");
    }
  }
  return content;
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
      if (subdomain !== subdomain.toLowerCase()) {
        console.warn(
          `⛔ Skipping '${file}': Filename contains uppercase letters. strict-lowercase policy.`
        );
        continue; // 과감하게 무시하고 다음 파일로 넘어갑니다.
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
              continue; // 이 레코드는 무시하고 다음으로 넘어감
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

    // 이 RRSet에 대해 Git 저장소에 정의된 레코드 목록
    let repoRecordsForRrset =
      repositoryRecordsMap.get(subdomain)?.filter((r) => r.type === type) || [];

    if (repoRecordsForRrset.length > 0) {
      // 1. CNAME 중복 방지 (첫 번째만 남김)
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
            `⚠️ Conflict detected for ${fqdn}: CNAME cannot coexist with A/AAAA records. Ignoring CNAME, keeping A/AAAA.`
          );
          // 이 CNAME RRSet은 처리하지 않고 건너뜀 (continue)
          continue;
        }

        if (fqdn === PDNS_ZONE + "." || fqdn === PDNS_ZONE) {
          console.log(`✨ Converting Root CNAME to ALIAS for: ${fqdn}`);
          finalType = "ALIAS";
        }

        // 다른 레코드(TXT, MX 등)와 섞여있는 CNAME -> ALIAS
        const hasOtherTypes = allRecords.some((r) => r.type !== "CNAME");
        if (hasOtherTypes && finalType === "CNAME") {
          console.log(
            `✨ Converting CNAME to ALIAS for ${fqdn} to coexist with TXT/MX.`
          );
          finalType = "ALIAS";
        }
        if (finalType === "CNAME" && subdomain !== "@") {
          // 현재 도메인(subdomain)을 접미사로 가지는 다른 키가 있는지 검사
          // 예: subdomain="a" 일 때, "b.a", "c.a", "a.a" 등이 있는지 확인
          const hasChildren = Array.from(repositoryRecordsMap.keys()).some(
            (otherKey) => otherKey.endsWith("." + subdomain)
          );

          if (hasChildren) {
            console.log(
              `✨ Converting Parent CNAME to ALIAS for ${fqdn} because it has child records.`
            );
            finalType = "ALIAS";
          }
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
