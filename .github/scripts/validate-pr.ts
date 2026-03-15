import { promises as fs } from "fs";
import path from "path";
import https from "https";

// --- Environment Variables ---

const PR_AUTHOR = process.env.PR_AUTHOR || "";
const PR_AUTHOR_TYPE = process.env.PR_AUTHOR_TYPE || "User";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const WORKSPACE_PATH = process.env.GITHUB_WORKSPACE || process.cwd();

const ADDED_FILES = (process.env.ADDED_FILES || "").split(" ").filter(Boolean);
const MODIFIED_FILES = (process.env.MODIFIED_FILES || "").split(" ").filter(Boolean);
const DELETED_FILES = (process.env.DELETED_FILES || "").split(" ").filter(Boolean);

// --- Constants ---

const BLACKLISTED_SUBDOMAINS = [
  "sync", "blog", "tunnel", "papers", "contact", "scheme",
  "www", "api", "ns1", "ns2", "docs", "status", "dashboard",
  "assets", "smtp", "mail", "dev", "_dmarc", "_github-challenge-is-an-ai",
];

const BOT_AUTHORS = ["is-an-ai-bot[bot]", "is-an-ai[bot]"];
const NOREPLY_PATTERNS = [/@noreply\.com$/i, /@users\.noreply\.github\.com$/i];

const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
const IPV6_REGEX = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^([0-9a-fA-F]{1,4}:){1,7}:|^([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}$|^([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}$|^([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}$|^([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})$|^:((:[0-9a-fA-F]{1,4}){1,7}|:)$/;
const DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const VENDOR_PATTERN = /^_([a-z0-9]+)\.[a-z0-9][a-z0-9.-]*$/;

// --- Types ---

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

interface ValidationError {
  file: string;
  message: string;
}

// --- GitHub API ---

function githubGet(urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: urlPath,
      headers: {
        "User-Agent": "is-an-ai-ci",
        Accept: "application/vnd.github+json",
        ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      },
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
        }
      });
    }).on("error", reject);
  });
}

async function getPrAuthorEmails(): Promise<string[]> {
  if (!PR_AUTHOR) return [];

  const emails: string[] = [];

  try {
    const user = await githubGet(`/users/${PR_AUTHOR}`);
    if (user.email) {
      emails.push(user.email.toLowerCase());
    }
  } catch (e) {
    console.warn(`Warning: Failed to fetch GitHub profile for ${PR_AUTHOR}`);
  }

  // Also collect commit author emails from the PR
  try {
    const commitEmails = (process.env.COMMIT_EMAILS || "").split(" ").filter(Boolean);
    for (const email of commitEmails) {
      const lower = email.toLowerCase();
      if (!isNoreplyEmail(lower) && !emails.includes(lower)) {
        emails.push(lower);
      }
    }
  } catch (e) {
    // Ignore
  }

  return emails;
}

// --- Validation Helpers ---

function isNoreplyEmail(email: string): boolean {
  return NOREPLY_PATTERNS.some((p) => p.test(email));
}

function isBotAuthor(): boolean {
  return PR_AUTHOR_TYPE === "Bot" || BOT_AUTHORS.includes(PR_AUTHOR);
}

function getSubdomainFromFilename(filePath: string): string {
  return path.basename(filePath, ".json");
}

function isVendorSubdomain(name: string): boolean {
  return VENDOR_PATTERN.test(name);
}

function validateSubdomainName(name: string): string | null {
  if (name === "schema") return null; // skip schema.json

  // Vendor subdomain pattern
  if (name.startsWith("_")) {
    if (!isVendorSubdomain(name)) {
      return `Invalid vendor subdomain format. Expected _{vendor}.{subdomain}.`;
    }
    // Validate the base part
    const basePart = name.replace(/^_[a-z0-9]+\./i, "");
    return validateBaseSubdomainName(basePart);
  }

  return validateBaseSubdomainName(name);
}

function validateBaseSubdomainName(name: string): string | null {
  if (name.length < 1) return "Subdomain name is too short";
  if (name.length > 63) return "Subdomain name is too long";
  if (name.includes(" ")) return "Subdomain name cannot contain spaces";
  if (name.startsWith("-") || name.endsWith("-")) return "Cannot start or end with hyphen";
  if (name.startsWith(".") || name.endsWith(".")) return "Cannot start or end with dot";
  if (name.includes("..")) return "Cannot contain consecutive dots";
  if (name.includes("_")) return "Cannot contain underscores";

  const labels = name.split(".");
  const labelRegex = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  for (const label of labels) {
    if (!labelRegex.test(label.toLowerCase())) {
      return `Invalid label "${label}" — only letters, numbers, and hyphens allowed`;
    }
  }

  if (BLACKLISTED_SUBDOMAINS.includes(name.toLowerCase())) {
    return "Subdomain name is reserved";
  }

  return null; // valid
}

function validateRecord(record: RecordDefinition, isVendor: boolean): string | null {
  if (!record.type || !record.value) {
    return "Record must have type and value";
  }

  const type = record.type.toUpperCase();
  const validTypes = ["A", "AAAA", "CNAME", "MX", "TXT"];
  if (!validTypes.includes(type)) {
    return `Unsupported record type: ${type}`;
  }

  // Vendor subdomains only allow TXT
  if (isVendor && type !== "TXT") {
    return `Vendor verification subdomains only support TXT records, got ${type}`;
  }

  if (type === "MX") {
    if (typeof record.value !== "object" || !("priority" in record.value) || !("exchange" in record.value)) {
      return "MX record must have priority and exchange fields";
    }
    const mx = record.value as MxRecordValue;
    if (typeof mx.priority !== "number" || mx.priority < 0 || mx.priority > 65535) {
      return "MX priority must be 0-65535";
    }
    if (!DOMAIN_REGEX.test(mx.exchange)) {
      return "MX exchange must be a valid domain";
    }
    return null;
  }

  if (typeof record.value !== "string") {
    return `${type} record value must be a string`;
  }

  switch (type) {
    case "A":
      if (!IPV4_REGEX.test(record.value)) return "A record must be a valid IPv4 address";
      break;
    case "AAAA":
      if (!IPV6_REGEX.test(record.value)) return "AAAA record must be a valid IPv6 address";
      break;
    case "CNAME":
      if (!DOMAIN_REGEX.test(record.value)) return "CNAME record must be a valid domain";
      break;
    case "TXT":
      if (record.value.length > 255) return "TXT record value cannot exceed 255 characters";
      break;
  }

  return null;
}

function validateFileContent(content: RecordFileContent, filePath: string): string[] {
  const errors: string[] = [];
  const subdomain = getSubdomainFromFilename(filePath);
  const isVendor = isVendorSubdomain(subdomain);

  // Validate subdomain name
  const nameError = validateSubdomainName(subdomain);
  if (nameError) {
    errors.push(`Subdomain name "${subdomain}": ${nameError}`);
  }

  // Validate owner
  if (!content.owner) {
    errors.push("Missing owner field");
    return errors;
  }
  if (!content.owner.email) {
    errors.push("Missing owner.email");
  } else if (isNoreplyEmail(content.owner.email)) {
    errors.push(
      `owner.email "${content.owner.email}" is a noreply address. ` +
      `Please use a real email address. We may contact you about domain maintenance.`
    );
  }

  // Validate description
  if (content.description !== undefined && typeof content.description === "string" && content.description.length > 100) {
    errors.push("Description exceeds 100 characters");
  }

  // Validate records
  if (!content.record || !Array.isArray(content.record)) {
    errors.push("Missing or invalid record array");
    return errors;
  }
  if (content.record.length === 0) {
    errors.push("At least one record is required");
  }
  if (content.record.length > 10) {
    errors.push("Maximum 10 records allowed");
  }

  for (let i = 0; i < content.record.length; i++) {
    const recordError = validateRecord(content.record[i], isVendor);
    if (recordError) {
      errors.push(`Record ${i + 1}: ${recordError}`);
    }
  }

  return errors;
}

// --- File Loading ---

async function loadJsonFile(filePath: string): Promise<RecordFileContent | null> {
  try {
    const fullPath = path.join(WORKSPACE_PATH, filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    return JSON.parse(content) as RecordFileContent;
  } catch (e) {
    return null;
  }
}

async function loadBaseFile(filePath: string): Promise<RecordFileContent | null> {
  try {
    const { execSync } = await import("child_process");
    const content = execSync(`git show origin/main:${filePath}`, {
      encoding: "utf-8",
      cwd: WORKSPACE_PATH,
    });
    return JSON.parse(content) as RecordFileContent;
  } catch (e) {
    return null;
  }
}

// --- Main Validation Logic ---

async function validatePR(): Promise<void> {
  console.log("=== PR Validation ===");
  console.log(`PR Author: ${PR_AUTHOR} (${PR_AUTHOR_TYPE})`);
  console.log(`Added: ${ADDED_FILES.length}, Modified: ${MODIFIED_FILES.length}, Deleted: ${DELETED_FILES.length}`);

  const errors: ValidationError[] = [];
  const skipEmailCheck = isBotAuthor();

  if (skipEmailCheck) {
    console.log("Bot author detected — skipping email ownership checks");
  }

  // Get PR author's verified emails
  let authorEmails: string[] = [];
  if (!skipEmailCheck) {
    authorEmails = await getPrAuthorEmails();
    console.log(`PR author emails: ${authorEmails.length > 0 ? authorEmails.join(", ") : "(none found)"}`);
  }

  // Validate ADDED files
  for (const file of ADDED_FILES) {
    const content = await loadJsonFile(file);
    if (!content) {
      errors.push({ file, message: "Failed to parse JSON" });
      continue;
    }

    const contentErrors = validateFileContent(content, file);
    for (const err of contentErrors) {
      errors.push({ file, message: err });
    }

    // Email ownership check
    if (!skipEmailCheck && content.owner?.email) {
      const ownerEmail = content.owner.email.toLowerCase();
      if (authorEmails.length === 0) {
        errors.push({
          file,
          message:
            `Cannot verify email ownership: no public email found for @${PR_AUTHOR}. ` +
            `Set your public email at https://github.com/settings/profile or use the website at https://is-an.ai`,
        });
      } else if (!authorEmails.includes(ownerEmail)) {
        errors.push({
          file,
          message:
            `owner.email "${content.owner.email}" does not match PR author @${PR_AUTHOR}'s email. ` +
            `Expected one of: ${authorEmails.join(", ")}`,
        });
      }
    }
  }

  // Validate MODIFIED files
  for (const file of MODIFIED_FILES) {
    const content = await loadJsonFile(file);
    if (!content) {
      errors.push({ file, message: "Failed to parse JSON" });
      continue;
    }

    const contentErrors = validateFileContent(content, file);
    for (const err of contentErrors) {
      errors.push({ file, message: err });
    }

    // Load base version to check ownership
    const baseContent = await loadBaseFile(file);

    if (!skipEmailCheck && baseContent?.owner?.email) {
      // Prevent changing owner.email (domain theft prevention)
      if (content.owner?.email && content.owner.email.toLowerCase() !== baseContent.owner.email.toLowerCase()) {
        errors.push({
          file,
          message: `owner.email cannot be changed. Original: "${baseContent.owner.email}", new: "${content.owner.email}"`,
        });
      }

      // Verify PR author owns this domain
      const ownerEmail = baseContent.owner.email.toLowerCase();
      if (authorEmails.length > 0 && !authorEmails.includes(ownerEmail)) {
        errors.push({
          file,
          message:
            `You don't have permission to modify this domain. ` +
            `owner.email "${baseContent.owner.email}" does not match @${PR_AUTHOR}'s email.`,
        });
      } else if (authorEmails.length === 0) {
        errors.push({
          file,
          message:
            `Cannot verify ownership: no public email found for @${PR_AUTHOR}. ` +
            `Set your public email at https://github.com/settings/profile or use the website.`,
        });
      }
    }
  }

  // Validate DELETED files
  for (const file of DELETED_FILES) {
    if (!skipEmailCheck) {
      const baseContent = await loadBaseFile(file);
      if (baseContent?.owner?.email) {
        const ownerEmail = baseContent.owner.email.toLowerCase();
        if (authorEmails.length > 0 && !authorEmails.includes(ownerEmail)) {
          errors.push({
            file,
            message:
              `You don't have permission to delete this domain. ` +
              `owner.email "${baseContent.owner.email}" does not match @${PR_AUTHOR}'s email.`,
          });
        } else if (authorEmails.length === 0) {
          errors.push({
            file,
            message:
              `Cannot verify ownership: no public email found for @${PR_AUTHOR}. ` +
              `Set your public email at https://github.com/settings/profile or use the website.`,
          });
        }
      }
    }
  }

  // Report results
  if (errors.length === 0) {
    console.log("\n✓ All validations passed!");
    return;
  }

  console.log(`\n✗ ${errors.length} validation error(s) found:\n`);
  for (const { file, message } of errors) {
    // GitHub Actions annotation format
    console.log(`::error file=${file}::${message}`);
    console.log(`  ${file}: ${message}`);
  }

  process.exit(1);
}

// --- Run ---
validatePR().catch((err) => {
  console.error("Unexpected error during validation:", err);
  process.exit(1);
});
