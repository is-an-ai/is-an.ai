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
const DEFAULT_TTL = 300; // PDNS에 설정할 기본 TTL
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

// --- Helper Functions ---
function getSubdomainFromPath(filePath: string): string {
  const filename = path.basename(filePath, ".json");
  const baseDomain = PDNS_ZONE.replace(/\.$/, ""); // trailing dot 제거
  const baseDomainPattern = `.${baseDomain}`; // ".is-an.ai"

  let subdomain = filename;
  if (filename.endsWith(baseDomainPattern)) {
    subdomain = filename.slice(0, -baseDomainPattern.length);
  } else if (filename === baseDomain) {
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

/**
 * 현재 SOA Serial을 가져옵니다. (없으면 0 반환)
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
      // SOA 포맷: ns1.xxx email.xxx SERIAL refresh retry expire min_ttl
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

  // [★ 핵심] SOA Serial 스마트 업데이트 - 변경 사항이 있으므로 SOA를 갱신합니다.
  // PowerDNS가 zone PATCH 시 SOA를 자동으로 올려주는지에 의존하지 않고,
  // update-pdns-dns.ts와 동일한 로직으로 명시적으로 갱신합니다.
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
        content: `ns1.is-an.ai. hostmaster.is-an.ai. ${newSerial} 10800 3600 604800 ${SOA_MIN_TTL}`,
        disabled: false,
      },
    ],
  });

  console.log(
    `=== Executing PowerDNS PATCH (${finalPayload.length} changes) ===`
  );

  // [중요] patchPayload 대신, 필터링된 finalPayload + SOA를 실행 함수에 넘깁니다.
  const success = await executePdnsPatch(finalPayload);

  if (!success) {
    console.error("✗ DNS sync process failed during PowerDNS PATCH.");
    process.exit(1);
  }

  // NOTIFY 전송 - secondary(HE 등)에 즉시 zone transfer 요청
  await sendPdnsNotify();

  console.log(`\n✓ DNS sync process completed!`);
}

/**
 * PowerDNS NOTIFY 전송 - secondary nameserver(HE 등)에 즉시 AXFR 요청을 트리거합니다.
 */
async function sendPdnsNotify(): Promise<void> {
  try {
    await pdnsClient.put(
      `/api/v1/servers/localhost/zones/${PDNS_ZONE}/notify`
    );
    console.log("✓ NOTIFY sent to secondaries (HE 등) - zone 전파 트리거됨");
  } catch (error: unknown) {
    console.warn(
      "⚠️ NOTIFY 전송 실패 (zone은 이미 업데이트됨):",
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
