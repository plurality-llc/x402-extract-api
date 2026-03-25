import * as cheerio from "cheerio";
import { chromium } from "playwright";
import Database from "better-sqlite3";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Model routing — Haiku for structured extraction, Sonnet for analytical work
// ---------------------------------------------------------------------------
const MODELS = {
  fast: "claude-haiku-4-5-20251001",
  smart: "claude-sonnet-4-20250514",
};

const SONNET_INTENTS = new Set(["article_summary", "reviews"]);

function getModel(intent) {
  if (intent === "custom") return MODELS.smart;
  return SONNET_INTENTS.has(intent) ? MODELS.smart : MODELS.fast;
}

// ---------------------------------------------------------------------------
// Cache — SQLite, keyed on url+intent+schema, 6-hour TTL
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));

const CACHE_TTL = {
  company_info:     24 * 60 * 60 * 1000,
  article_summary:  24 * 60 * 60 * 1000,
  reviews:          12 * 60 * 60 * 1000,
  product_specs:     6 * 60 * 60 * 1000,
  pricing:           2 * 60 * 60 * 1000,
  job_listing:       2 * 60 * 60 * 1000,
  contact_extraction: 24 * 60 * 60 * 1000,
  structured_table:  12 * 60 * 60 * 1000,
  social_profile:    12 * 60 * 60 * 1000,
  custom:             1 * 60 * 60 * 1000,
};
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

const db = new Database(join(__dirname, "..", "cache.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    intent TEXT NOT NULL,
    data TEXT NOT NULL,
    usage TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

const cacheGet = db.prepare("SELECT intent, data, usage, created_at FROM cache WHERE key = ?");
const cacheSet = db.prepare("INSERT OR REPLACE INTO cache (key, intent, data, usage, created_at) VALUES (?, ?, ?, ?, ?)");
const cachePurge = db.prepare("DELETE FROM cache WHERE created_at < ?");

// Purge oldest possible entries on startup and every hour
cachePurge.run(Date.now() - 24 * 60 * 60 * 1000);
setInterval(() => cachePurge.run(Date.now() - 24 * 60 * 60 * 1000), 60 * 60 * 1000);

function cacheKey(url, intent, schema) {
  const raw = JSON.stringify({ url, intent, schema: schema || null });
  return createHash("sha256").update(raw).digest("hex");
}

function getCached(url, intent, schema) {
  const row = cacheGet.get(cacheKey(url, intent, schema));
  if (!row) return null;
  const ttl = CACHE_TTL[intent] || DEFAULT_TTL_MS;
  if (Date.now() - row.created_at > ttl) return null;
  return { data: JSON.parse(row.data), usage: { ...JSON.parse(row.usage), cached: true } };
}

function setCache(url, intent, schema, data, usage) {
  const key = cacheKey(url, intent, schema);
  cacheSet.run(key, intent, JSON.stringify(data), JSON.stringify(usage), Date.now());
}

// ---------------------------------------------------------------------------
// Playwright — lazy-launched, reused across requests
// ---------------------------------------------------------------------------
const MIN_CONTENT_LENGTH = 500;
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless: true });
  }
  return browserInstance;
}

// Clean up on exit
process.on("exit", () => browserInstance?.close().catch(() => {}));
process.on("SIGINT", () => { browserInstance?.close().catch(() => {}); process.exit(); });
process.on("SIGTERM", () => { browserInstance?.close().catch(() => {}); process.exit(); });

async function fetchWithPlaywright(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Intent → prompt mapping
// ---------------------------------------------------------------------------
const INTENT_PROMPTS = {
  product_specs: `Extract structured product information from this web page content.
Return a JSON object with these fields (omit any that aren't found):
- name: string (product name)
- brand: string
- price: { amount: number, currency: string }
- description: string (1-2 sentences)
- specs: object (key-value pairs of all technical specifications)
- images: string[] (image URLs if found)
- availability: "in_stock" | "out_of_stock" | "pre_order" | "unknown"
- category: string
- sku: string
- rating: { score: number, count: number }
- url: string (canonical product URL if different from input)`,

  company_info: `Extract structured company information from this web page content.
Return a JSON object with these fields (omit any that aren't found):
- name: string
- description: string (1-2 sentences)
- industry: string
- founded: string (year or date)
- headquarters: string
- team: [ { name: string, role: string } ] (key people, max 10)
- employee_count: string (estimate if exact not available)
- funding: string (total raised if available)
- contact: { email: string, phone: string, address: string }
- social: { twitter: string, linkedin: string, github: string }
- products: string[] (main products or services)
- tech_stack: string[] (if detectable)`,

  article_summary: `Extract structured article information from this web page content.
Return a JSON object with these fields (omit any that aren't found):
- title: string
- author: string
- published_date: string (ISO format if possible)
- source: string (publication name)
- summary: string (3-5 sentences capturing the key points)
- key_points: string[] (3-7 bullet points)
- entities: [ { name: string, type: "person" | "company" | "place" | "concept" } ]
- topics: string[] (main topics/tags)
- sentiment: "positive" | "negative" | "neutral" | "mixed"
- word_count: number (estimate)`,

  pricing: `Extract structured pricing information from this web page content.
Return a JSON object with these fields (omit any that aren't found):
- product_name: string
- plans: [
    {
      name: string,
      price: { amount: number, currency: string, period: "monthly" | "yearly" | "one_time" },
      features: string[],
      limits: object,
      highlighted: boolean (if marked as recommended/popular)
    }
  ]
- free_tier: boolean
- enterprise_pricing: boolean (custom/contact sales)
- discounts: string[] (annual discount, student, etc.)
- currency_options: string[]`,

  job_listing: `Extract structured job listing information from this web page content.
Return a JSON object with these fields (omit any that aren't found):
- title: string
- company: string
- location: string
- remote: "remote" | "hybrid" | "onsite" | "unknown"
- salary: { min: number, max: number, currency: string, period: "yearly" | "monthly" | "hourly" }
- experience_level: "entry" | "mid" | "senior" | "lead" | "executive"
- employment_type: "full_time" | "part_time" | "contract" | "internship"
- description: string (2-3 sentences)
- requirements: string[] (key requirements)
- nice_to_have: string[] (preferred qualifications)
- benefits: string[]
- tech_stack: string[] (if applicable)
- posted_date: string
- apply_url: string`,

  reviews: `Extract structured review/rating information from this web page content.
Return a JSON object with these fields (omit any that aren't found):
- product_name: string
- overall_rating: { score: number, max: number, count: number }
- rating_distribution: { "5": number, "4": number, "3": number, "2": number, "1": number }
- pros: string[] (common positive themes, max 7)
- cons: string[] (common negative themes, max 7)
- recent_reviews: [
    { rating: number, title: string, snippet: string, date: string, verified: boolean }
  ] (max 5 most recent/helpful)
- recommendation_rate: number (percentage who recommend, if available)
- comparison_mentions: string[] (other products frequently compared to)`,

  contact_extraction: `Extract all contact information and outreach channels from this web page content.
Return a JSON object with these fields (omit any that aren't found):
- company_name: string
- emails: [ { address: string, label: string } ] (e.g. label: "sales", "support", "general")
- phones: [ { number: string, label: string } ]
- addresses: [ { full: string, city: string, state: string, country: string, postal_code: string } ]
- social: { twitter: string, linkedin: string, github: string, facebook: string, instagram: string, youtube: string }
- contact_form_url: string
- chat_available: boolean
- key_people: [ { name: string, role: string, email: string, linkedin: string } ] (max 10)
- hours: string (business hours if listed)`,

  structured_table: `Extract all data tables from this web page content into structured JSON.
Return a JSON object with these fields:
- tables: [
    {
      title: string (table heading or caption if found, otherwise infer from context),
      headers: string[] (column names),
      rows: object[] (each row as key-value pairs using headers as keys),
      row_count: number
    }
  ]
If only one table is found, still wrap it in the tables array.
Preserve the original data types where possible (numbers as numbers, dates as strings, booleans as booleans).
If the page has no tables but has list-like structured data (definition lists, spec sheets, key-value pairs), extract those as a single-column table.`,

  social_profile: `Extract structured profile information from this social media or professional profile page.
Return a JSON object with these fields (omit any that aren't found):
- platform: string (e.g. "linkedin", "twitter", "github", "personal_site")
- name: string
- headline: string (bio, tagline, or professional headline)
- location: string
- avatar_url: string
- profile_url: string (canonical URL)
- current_role: { title: string, company: string, start_date: string }
- experience: [ { title: string, company: string, duration: string } ] (max 5 most recent)
- education: [ { school: string, degree: string, field: string } ]
- skills: string[] (max 15)
- followers: number
- connections: number
- posts_count: number
- websites: string[]
- languages: string[]
- open_to: string[] (e.g. "hiring", "freelance", "collaborations")`,
};

export const VALID_INTENTS = [...Object.keys(INTENT_PROMPTS), "custom"];

// ---------------------------------------------------------------------------
// Fetch + clean page content (Cheerio first, Playwright fallback)
// ---------------------------------------------------------------------------
function parseHtml(html) {
  const $ = cheerio.load(html);

  $("script, style, noscript, iframe, svg, nav, footer, header").remove();
  $("[aria-hidden=true]").remove();

  const title = $("title").text().trim();
  const metaDescription = $('meta[name="description"]').attr("content") || "";
  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const ogDescription = $('meta[property="og:description"]').attr("content") || "";

  const mainContent =
    $("main").text() || $("article").text() || $('[role="main"]').text() || $("body").text();

  const cleanText = mainContent.replace(/\s+/g, " ").trim();
  const truncated = cleanText.slice(0, 12000);

  return {
    title,
    metaDescription,
    ogTitle,
    ogDescription,
    content: truncated,
    fullLength: cleanText.length,
    truncated: cleanText.length > 12000,
  };
}

export async function fetchPageContent(url) {
  // Stage 1: Cheerio (fast, lightweight)
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; x402-extract-api/1.0; +https://github.com/plurality-llc/x402-extract-api)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: HTTP ${response.status}`);
  }

  const html = await response.text();
  const page = parseHtml(html);

  // Stage 2: If Cheerio got insufficient content, retry with Playwright
  if (page.content.length < MIN_CONTENT_LENGTH) {
    console.log(`Cheerio got ${page.content.length} chars for ${url}, falling back to Playwright`);
    try {
      const renderedHtml = await fetchWithPlaywright(url);
      const rendered = parseHtml(renderedHtml);
      rendered.renderer = "playwright";
      return rendered;
    } catch (err) {
      console.error(`Playwright fallback failed for ${url}: ${err.message}`);
      // Return Cheerio result anyway — might still be usable
      page.renderer = "cheerio";
      return page;
    }
  }

  page.renderer = "cheerio";
  return page;
}

// ---------------------------------------------------------------------------
// Build prompt from intent or custom schema
// ---------------------------------------------------------------------------
function buildPrompt(intent, customSchema) {
  if (intent === "custom") {
    if (!customSchema) {
      throw new Error("intent=custom requires a 'schema' object in the request body");
    }
    const schemaStr = typeof customSchema === "string" ? customSchema : JSON.stringify(customSchema);
    if (schemaStr.length > 3000) {
      throw new Error("Custom schema too large (max 3000 chars when serialized)");
    }
    return `Extract data from this web page according to the following JSON schema.
Return a JSON object conforming to this schema. Omit fields where data isn't found.

SCHEMA:
${schemaStr}`;
  }

  const prompt = INTENT_PROMPTS[intent];
  if (!prompt) throw new Error(`Unknown intent: ${intent}`);
  return prompt;
}

// ---------------------------------------------------------------------------
// Core extraction — run page content through Claude, return { data, usage }
// ---------------------------------------------------------------------------
async function runExtraction(page, prompt, model) {
  const message = await anthropic.messages.create({
    model,
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `${prompt}

---

PAGE METADATA:
Title: ${page.title}
Meta Description: ${page.metaDescription}
OG Title: ${page.ogTitle}
OG Description: ${page.ogDescription}

PAGE CONTENT:
${page.content}

---

Return ONLY valid JSON. No markdown, no backticks, no explanation. Just the JSON object.`,
      },
    ],
  });

  const responseText = message.content[0].text.trim();
  const cleaned = responseText.replace(/^```json?\n?/, "").replace(/\n?```$/, "");

  try {
    return {
      data: JSON.parse(cleaned),
      usage: {
        model,
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      },
    };
  } catch (parseErr) {
    throw new Error(`Failed to parse extraction result as JSON: ${parseErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// Single URL extraction (with cache)
// ---------------------------------------------------------------------------
export async function extract(url, intent, customSchema = null) {
  const cached = getCached(url, intent, customSchema);
  if (cached) return cached;

  const prompt = buildPrompt(intent, customSchema);
  const model = getModel(intent);
  const page = await fetchPageContent(url);

  if (!page.content || page.content.length < 50) {
    throw new Error("Page returned insufficient content for extraction");
  }

  const result = await runExtraction(page, prompt, model);
  result.usage.renderer = page.renderer;
  setCache(url, intent, customSchema, result.data, result.usage);
  return result;
}

// ---------------------------------------------------------------------------
// Batch extraction — same intent across multiple URLs (max 10)
// ---------------------------------------------------------------------------
export async function extractBatch(urls, intent, customSchema = null) {
  if (urls.length > 10) {
    throw new Error("Batch limited to 10 URLs per request");
  }

  const prompt = buildPrompt(intent, customSchema);
  const model = getModel(intent);

  const extractionPromises = urls.map(async (url) => {
    // Check cache per URL
    const cached = getCached(url, intent, customSchema);
    if (cached) return { url, success: true, error: null, ...cached };

    try {
      const page = await fetchPageContent(url);
      if (!page.content || page.content.length < 50) {
        return { url, success: false, error: "Insufficient content", data: null, usage: null };
      }
      const { data, usage } = await runExtraction(page, prompt, model);
      usage.renderer = page.renderer;
      setCache(url, intent, customSchema, data, usage);
      return { url, success: true, error: null, data, usage };
    } catch (err) {
      return { url, success: false, error: err.message, data: null, usage: null };
    }
  });

  return Promise.all(extractionPromises);
}
