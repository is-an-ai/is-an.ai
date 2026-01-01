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

const DEFAULT_TTL = 300; // 기본 TTL
const SOA_MIN_TTL = 300; // Negative Cache TTL (5분)

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
 * 파일 경로에서 서브도메인 추출 (punycode 변환 포함)
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
 * 서브도메인을 FQDN으로 변환 (끝에 점 추가, 중복 점 제거)
 */
function subdomainToFqdn(subdomain: string): string {
  // 앞뒤 점 제거
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
 * 레코드 값 정규화 (점 추가, 따옴표 처리, IP 0 제거 등)
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
 * PowerDNS에서 특정 서브도메인의 현재 RRSet들을 가져옵니다.
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

    // 해당 FQDN과 일치하는 것만 필터링 (SOA, NS 제외)
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
 * 현재 SOA Serial을 가져옵니다. (없으면 0 반환)
 */
async function getCurrentSoaSerial(): Promise<number> {
  try {
    const response = await pdnsClient.get(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}`
    );
    const rrsets: PdnsApiGetRRSet[] = response.data.rrsets || [];
    // SOA 레코드 찾기
    const soaRR = rrsets.find((rr) => rr.type === "SOA");

    if (soaRR && soaRR.records.length > 0) {
      const content = soaRR.records[0].content;
      // SOA 포맷: ns1.xxx email.xxx SERIAL refresh retry expire min_ttl
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

    // [보호 로직] 대문자 파일명 거부
    if (subdomain !== subdomain.toLowerCase()) {
      console.warn(`⛔ Skipping '${filePath}': Contains uppercase letters.`);
      return [];
    }

    const signatures: RecordSignature[] = [];
    const ipv4Regex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;

    for (const def of data.record) {
      const type = def.type.toUpperCase();

      // A 레코드 유효성 검사
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

  // 1. DELETE 처리
  for (const file of DELETED_FILES) {
    const subdomain = getSubdomainFromPath(file);
    if (processedSubdomains.has(subdomain)) continue;

    console.log(`Processing Deletion for: ${subdomain}`);
    // 기존에 존재하던 레코드들을 조회해서 삭제 요청 생성
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

  // 2. ADD / MODIFY 처리
  const filesToProcess = [...new Set([...ADDED_FILES, ...MODIFIED_FILES])];

  // PowerDNS에 현재 존재하는 타입들을 파악하기 위해 미리 조회하는 Map
  // (증분 업데이트라 전체 조회는 비효율적이니, 대상 서브도메인만 그때그때 조회함)

  for (const file of filesToProcess) {
    const filePath = path.join(WORKSPACE_PATH, file);
    const subdomain = getSubdomainFromPath(file);

    if (processedSubdomains.has(subdomain)) continue;

    const newRecords = await loadRecordFile(filePath);
    if (newRecords.length === 0) continue;

    const fqdn = subdomainToFqdn(subdomain);
    console.log(`Processing Update for: ${fqdn}`);

    // 현재 PowerDNS에 살아있는 레코드 조회 (충돌 방지 및 ALIAS 판단용)
    const existingRRSets = await getSubdomainRRSets(subdomain);
    const existingTypes = new Set(existingRRSets.map((r) => r.type));

    // 파일 내 레코드들을 타입별로 그룹화
    const recordsByType = new Map<string, RecordSignature[]>();
    for (const r of newRecords) {
      if (!recordsByType.has(r.type)) recordsByType.set(r.type, []);
      recordsByType.get(r.type)!.push(r);
    }

    // 각 타입별 처리
    for (const [type, records] of recordsByType.entries()) {
      let finalType = type;
      let finalRecords = records;

      // 2-1. CNAME 로직
      if (type === "CNAME") {
        // (A) CNAME 중복 제거
        if (records.length > 1) {
          console.warn(`⚠️ Multiple CNAMEs for ${fqdn}. Using first.`);
          finalRecords = [records[0]];
        }

        const hasIPInFile = recordsByType.has("A") || recordsByType.has("AAAA");

        // (B) 같은 파일 내에 A 레코드가 있으면 CNAME 무시 (A 우선)
        if (hasIPInFile) {
          console.warn(`⚠️ Conflict: CNAME & IP in ${file}. Ignoring CNAME.`);
          continue;
        }

        // (C) CNAME -> ALIAS 변환 조건
        // 1. 루트 도메인
        if (subdomain === "@") {
          console.log(`✨ Root CNAME -> ALIAS for ${fqdn}`);
          finalType = "ALIAS";
        }
        // 2. 다른 타입(TXT, MX)과 섞여 있는 경우 (기존 PDNS 상태 확인)
        else if (existingTypes.size > 0 && !existingTypes.has("CNAME")) {
          // 기존에 A나 TXT 등이 있는데 CNAME을 넣으려 함 -> ALIAS로 공존 시도
          // 단, 기존이 A라면 덮어써야 할 수도 있지만, 안전하게 ALIAS로 변환
          console.log(`✨ CNAME -> ALIAS (Mixed types) for ${fqdn}`);
          finalType = "ALIAS";
        }

        // (D) 충돌 정리: CNAME(또는 ALIAS)을 생성하려면, 기존의 다른 레코드는 지워야 함
        // 예: 기존 A 레코드가 있는데 CNAME으로 덮어쓰려면 A를 DELETE 해야 함
        // (PowerDNS는 CNAME과 다른 레코드가 공존하면 에러를 뱉음 - ALIAS 제외)
        if (finalType === "CNAME") {
          for (const existType of existingTypes) {
            if (existType !== "CNAME") {
              console.log(
                `🧹 Cleanup: Deleting conflicting ${existType} for CNAME on ${fqdn}`
              );
              patchPayload.push({
                name: fqdn,
                type: existType,
                ttl: DEFAULT_TTL,
                changetype: "DELETE",
                records: [],
              });
            }
          }
        }
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

    processedSubdomains.add(subdomain);
  }

  // 3. 필터링 및 전송
  if (patchPayload.length === 0) {
    console.log("✓ No changes detected.");
    return;
  }

  // [보호 로직]
  const PROTECTED_DOMAINS = [
    "is-an.ai",
    "www.is-an.ai",
    "ns1.is-an.ai",
    "ns2.is-an.ai",
    "api.is-an.ai",
    "docs.is-an.ai",
    "status.is-an.ai",
    "_dmarc.is-an.ai",
    "_vercel.is-an.ai",
  ];

  // 이름 비교 정규화 함수 (점 제거, 소문자)
  const normName = (n: string) => n.toLowerCase().replace(/\.$/, "");

  const finalPayload = patchPayload.filter((item) => {
    // 보호 도메인 && DELETE 요청이면 필터링
    const isProtected = PROTECTED_DOMAINS.some(
      (p) => normName(p) === normName(item.name)
    );
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

  // 4. [★ 핵심] SOA Serial 스마트 업데이트
  // 변경 사항이 확정되었으므로 SOA를 갱신합니다.
  console.log("🔄 Calculating new SOA Serial...");

  const currentSerial = await getCurrentSoaSerial();
  const today = new Date();
  const YYYY = today.getFullYear();
  const MM = String(today.getMonth() + 1).padStart(2, "0");
  const DD = String(today.getDate()).padStart(2, "0");
  const todayPrefix = parseInt(`${YYYY}${MM}${DD}`, 10);

  // 현재 Serial 분석 (YYYYMMDDNN 형식 가정)
  // 예: 2026010101 -> prefix: 20260101, suffix: 01
  let newSerial: number;

  const currentSerialStr = String(currentSerial);

  if (
    currentSerialStr.length === 10 &&
    currentSerialStr.startsWith(`${todayPrefix}`)
  ) {
    // 오늘 이미 배포된 적이 있음 -> 기존 값 + 1
    newSerial = currentSerial + 1;
    console.log(
      `📆 Updated existing serial for today: ${currentSerial} -> ${newSerial}`
    );
  } else {
    // 오늘 첫 배포이거나, 형식이 다름 -> 오늘날짜 + 01
    newSerial = parseInt(`${todayPrefix}01`, 10);
    console.log(`📆 New serial for today: ${newSerial}`);
  }

  // SOA 레코드 추가
  finalPayload.push({
    name: PDNS_ZONE + ".",
    type: "SOA",
    ttl: 3600,
    changetype: "REPLACE",
    records: [
      {
        // 주의: ns1, hostmaster 등은 실제 환경에 맞게 수정 필요
        // [중요] 맨 마지막 숫자 300은 Negative Cache TTL (짧게 유지 추천)
        content: `ns1.is-an.ai. hostmaster.is-an.ai. ${newSerial} 10800 3600 604800 ${SOA_MIN_TTL}`,
        disabled: false,
      },
    ],
  });

  // 5. 실행
  const success = await executePdnsPatch(finalPayload);
  if (!success) process.exit(1);

  console.log("\n✓ Incremental update completed successfully!");
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

// --- Run ---
processChanges().catch((err) => {
  console.error(err);
  process.exit(1);
});
