import axios, { AxiosInstance } from "axios";

// --- PowerDNS API 5.0 Interfaces ---

interface PdnsApiGetRecord {
  content: string;
  disabled: boolean;
}

interface PdnsApiGetRRSet {
  name: string; // FQDN (e.g., "test.grrr.site.")
  type: string; // "A", "MX", etc.
  ttl: number;
  records: PdnsApiGetRecord[];
}

interface PdnsZoneInfo {
  id: string;
  name: string;
  type: string;
  url: string;
  kind: string;
  rrsets: PdnsApiGetRRSet[];
  serial: number;
  notified_serial: number;
  masters: string[];
  dnssec: boolean;
  nsec3param: string;
  nsec3narrow: boolean;
  presigned: boolean;
  soa_edit: string;
  soa_edit_api: string;
  api_rectify: boolean;
  zone: string;
  account: string;
  nameservers: string[];
  master_tsig_key_ids: string[];
  slave_tsig_key_ids: string[];
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

function getEnvVariableOptional(
  name: string,
  defaultValue: string = ""
): string {
  return process.env[name] || defaultValue;
}

const PDNS_API_KEY: string = getEnvVariable("PDNS_API_KEY");
const PDNS_API_URL: string = getEnvVariable("PDNS_API_URL");
const PDNS_ZONE: string = getEnvVariableOptional("PDNS_ZONE");

// --- PowerDNS API Client ---
const pdnsClient: AxiosInstance = axios.create({
  baseURL: PDNS_API_URL,
  headers: {
    "X-API-Key": PDNS_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 30000, // 30초 타임아웃 (무한 대기 방지)
});

// --- Helper Functions ---

/**
 * FQDN을 하위 도메인으로 변환합니다.
 */
function fqdnToSubdomain(fqdn: string, zone: string): string {
  if (fqdn === zone) {
    return "@";
  }
  return fqdn.replace(`.${zone}`, "");
}

/**
 * 모든 존 목록을 가져옵니다.
 */
async function getAllZones(): Promise<string[]> {
  try {
    const response = await pdnsClient.get("/api/v1/servers/localhost/zones");
    const zones: PdnsZoneInfo[] = response.data;
    return zones.map((zone) => zone.name);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching zones:", message);
    if (
      error &&
      typeof error === "object" &&
      axios.isAxiosError(error) &&
      error.response
    ) {
      console.error("Response data:", error.response.data);
    }
    throw error;
  }
}

/**
 * 특정 존의 모든 RRSet을 가져옵니다.
 */
async function getZoneRRSets(zone: string): Promise<PdnsApiGetRRSet[]> {
  try {
    const response = await pdnsClient.get(
      `/api/v1/servers/localhost/zones/${zone}`
    );
    const zoneInfo: PdnsZoneInfo = response.data;
    return zoneInfo.rrsets || [];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error fetching zone ${zone}:`, message);
    if (
      error &&
      typeof error === "object" &&
      axios.isAxiosError(error) &&
      error.response
    ) {
      console.error("Response data:", error.response.data);
    }
    throw error;
  }
}

/**
 * 특정 레코드를 검색합니다.
 */
function findRecord(
  rrsets: PdnsApiGetRRSet[],
  subdomain: string,
  type: string,
  zone: string
): PdnsApiGetRRSet | null {
  const fqdn = subdomain === "@" ? zone : `${subdomain}.${zone}`;
  return (
    rrsets.find(
      (rrset) =>
        rrset.name === fqdn && rrset.type.toUpperCase() === type.toUpperCase()
    ) || null
  );
}

/**
 * 통계 정보를 출력합니다.
 */
function printStatistics(rrsets: PdnsApiGetRRSet[], zone: string): void {
  console.log("\n=== DNS 레코드 통계 ===");

  // 타입별 통계
  const typeCount = new Map<string, number>();
  const subdomainSet = new Set<string>();

  for (const rrset of rrsets) {
    // SOA, NS는 제외
    if (rrset.type === "SOA" || rrset.type === "NS") {
      continue;
    }

    const type = rrset.type.toUpperCase();
    typeCount.set(type, (typeCount.get(type) || 0) + rrset.records.length);

    const subdomain = fqdnToSubdomain(rrset.name, zone);
    subdomainSet.add(subdomain);
  }

  console.log(`\n총 하위 도메인 수: ${subdomainSet.size}`);
  console.log(
    `총 RRSet 수: ${
      rrsets.filter((r) => r.type !== "SOA" && r.type !== "NS").length
    }`
  );

  console.log("\n레코드 타입별 개수:");
  const sortedTypes = Array.from(typeCount.entries()).sort(
    (a, b) => b[1] - a[1]
  );
  for (const [type, count] of sortedTypes) {
    console.log(`  ${type}: ${count}개`);
  }

  // 총 레코드 개수
  const totalRecords = Array.from(typeCount.values()).reduce(
    (a, b) => a + b,
    0
  );
  console.log(`\n총 레코드 개수: ${totalRecords}개`);
}

/**
 * 특정 레코드 상세 정보를 출력합니다.
 */
function printRecordDetails(
  rrset: PdnsApiGetRRSet | null,
  subdomain: string,
  type: string
): void {
  console.log(`\n=== 레코드 조회: ${subdomain} ${type} ===`);

  if (!rrset) {
    console.log("❌ 레코드를 찾을 수 없습니다.");
    return;
  }

  console.log(`FQDN: ${rrset.name}`);
  console.log(`타입: ${rrset.type}`);
  console.log(`TTL: ${rrset.ttl}`);
  console.log(`레코드 개수: ${rrset.records.length}`);

  console.log("\n레코드 내용:");
  for (let i = 0; i < rrset.records.length; i++) {
    const record = rrset.records[i];
    const status = record.disabled ? "❌ 비활성화" : "✅ 활성화";
    console.log(`  [${i + 1}] ${record.content} ${status}`);
  }
}

// --- Main Test Functions ---

/**
 * 모든 존의 총 도메인 개수를 출력합니다.
 */
async function testTotalDomains(): Promise<void> {
  console.log("=== 테스트 1: 전체 존 및 도메인 개수 ===");
  try {
    const zones = await getAllZones();
    console.log(`\n총 존(Zone) 개수: ${zones.length}개`);
    console.log("\n존 목록:");
    for (const zone of zones) {
      console.log(`  - ${zone}`);
    }

    // 각 존별 레코드 통계
    for (const zone of zones) {
      console.log(`\n--- ${zone} ---`);
      const rrsets = await getZoneRRSets(zone);
      printStatistics(rrsets, zone);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("테스트 실패:", message);
    process.exit(1);
  }
}

/**
 * 특정 존의 레코드를 테스트합니다.
 */
async function testSpecificZone(zone: string): Promise<void> {
  console.log(`=== 테스트 2: ${zone} 존 상세 정보 ===`);
  try {
    const rrsets = await getZoneRRSets(zone);
    printStatistics(rrsets, zone);

    // 샘플 레코드 몇 개 출력
    const sampleRRSets = rrsets
      .filter((r) => r.type !== "SOA" && r.type !== "NS")
      .slice(0, 5);

    if (sampleRRSets.length > 0) {
      console.log("\n=== 샘플 레코드 (최대 5개) ===");
      for (const rrset of sampleRRSets) {
        const subdomain = fqdnToSubdomain(rrset.name, zone);
        printRecordDetails(rrset, subdomain, rrset.type);
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("테스트 실패:", message);
    process.exit(1);
  }
}

/**
 * 특정 레코드를 조회합니다.
 */
async function testSpecificRecord(
  zone: string,
  subdomain: string,
  type: string
): Promise<void> {
  console.log(`=== 테스트 3: 특정 레코드 조회 ===`);
  try {
    const rrsets = await getZoneRRSets(zone);
    const rrset = findRecord(rrsets, subdomain, type, zone);
    printRecordDetails(rrset, subdomain, type);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("테스트 실패:", message);
    process.exit(1);
  }
}

// --- Main Execution ---

async function main(): Promise<void> {
  console.log("PowerDNS 테스트 스크립트\n");
  console.log(`API URL: ${PDNS_API_URL}`);
  console.log(`Zone: ${PDNS_ZONE || "(지정되지 않음)"}\n`);

  // 커맨드라인 인자 파싱
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    if (command === "list" || !command) {
      // 기본: 모든 존의 통계 출력
      await testTotalDomains();
    } else if (command === "zone" && args[1]) {
      // 특정 존 조회: node test-pdns.js zone grrr.site.
      await testSpecificZone(args[1]);
    } else if (command === "record" && args[1] && args[2] && args[3]) {
      // 특정 레코드 조회: node test-pdns.js record grrr.site. @ A
      // 또는: node test-pdns.js record grrr.site. test A
      const zone = args[1];
      const subdomain = args[2];
      const type = args[3];
      await testSpecificRecord(zone, subdomain, type);
    } else if (command === "record" && PDNS_ZONE && args[1] && args[2]) {
      // PDNS_ZONE이 설정되어 있으면 생략 가능
      // node test-pdns.js record @ A
      const subdomain = args[1];
      const type = args[2];
      await testSpecificRecord(PDNS_ZONE, subdomain, type);
    } else {
      console.log("사용법:");
      console.log("  node test-pdns.js                    # 모든 존 통계 출력");
      console.log("  node test-pdns.js list               # 모든 존 통계 출력");
      console.log("  node test-pdns.js zone <zone>        # 특정 존 상세 정보");
      console.log(
        "  node test-pdns.js record <zone> <subdomain> <type>  # 특정 레코드 조회"
      );
      console.log(
        "  node test-pdns.js record <subdomain> <type>         # PDNS_ZONE 사용"
      );
      console.log("\n예시:");
      console.log("  node test-pdns.js");
      console.log("  node test-pdns.js zone grrr.site.");
      console.log("  node test-pdns.js record grrr.site. @ A");
      console.log("  node test-pdns.js record grrr.site. test A");
      console.log("  node test-pdns.js record @ A  # PDNS_ZONE 환경변수 필요");
      process.exit(1);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("실행 중 오류 발생:", message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("예상치 못한 오류:", message);
  process.exit(1);
});
