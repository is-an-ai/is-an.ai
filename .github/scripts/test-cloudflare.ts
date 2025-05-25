import { Cloudflare } from "cloudflare";

// Load environment variables
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;

if (!CF_API_TOKEN || !CF_ZONE_ID) {
  console.error(
    "Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID environment variables"
  );
  process.exit(1);
}

const cf = new Cloudflare({ apiToken: CF_API_TOKEN! });

async function testListRecords() {
  try {
    console.log("Testing cf.dns.records.list...");

    // Test 1: List all records
    console.log("\n1. Listing all DNS records:");
    const allRecords = await cf.dns.records.list({
      zone_id: CF_ZONE_ID!,
    });
    console.log(`Found ${allRecords.result.length} total records`);

    // Test 2: List records with specific name filter
    console.log("\n2. Testing name filter (looking for 'docs'):");
    const docsRecords = await cf.dns.records.list({
      zone_id: CF_ZONE_ID!,
      name: {
        exact: "docs.is-an.ai",
      },
    });
    console.log(
      `Found ${docsRecords.result.length} records for 'docs.is-an.ai'`
    );

    // Test 3: List records by type
    console.log("\n3. Testing type filter (CNAME records):");
    const cnameRecords = await cf.dns.records.list({
      zone_id: CF_ZONE_ID!,
      type: "CNAME",
    });
    console.log(`Found ${cnameRecords.result.length} CNAME records`);

    // Test 4: Show detailed info for first few records
    console.log("\n4. Sample record details:");
    allRecords.result.slice(0, 3).forEach((record, index) => {
      console.log(`Record ${index + 1}:`);
      console.log(`  ID: ${record.id}`);
      console.log(`  Name: ${record.name}`);
      console.log(`  Type: ${record.type}`);
      console.log(`  Content: ${record.content}`);
      console.log(`  TTL: ${record.ttl}`);
      if (record.type === "MX") {
        console.log(`  Priority: ${record.priority}`);
      }
      console.log("");
    });
  } catch (error) {
    console.error("Error testing Cloudflare API:", error);
    if (error instanceof Error) {
      console.error("Stack:", error.stack);
    }
  }
}

testListRecords();
