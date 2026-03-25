import * as cheerio from "cheerio";
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
  if (intent === "custom") return MODELS.fast;
  return SONNET_INTENTS.has(intent) ? MODELS.smart : MODELS.fast;
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
};

export const VALID_INTENTS = [...Object.keys(INTENT_PROMPTS), "custom"];

// ---------------------------------------------------------------------------
// Fetch + clean page content
// ---------------------------------------------------------------------------
export async function fetchPageContent(url) {
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
  const $ = cheerio.load(html);

  // Remove noise
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
// Single URL extraction
// ---------------------------------------------------------------------------
export async function extract(url, intent, customSchema = null) {
  const prompt = buildPrompt(intent, customSchema);
  const model = getModel(intent);
  const page = await fetchPageContent(url);

  if (!page.content || page.content.length < 50) {
    throw new Error("Page returned insufficient content for extraction");
  }

  return runExtraction(page, prompt, model);
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

  // Fetch all pages in parallel
  const pageResults = await Promise.allSettled(urls.map((u) => fetchPageContent(u)));

  // Extract from each successfully fetched page in parallel
  const extractionPromises = pageResults.map(async (result, i) => {
    if (result.status === "rejected") {
      return { url: urls[i], success: false, error: result.reason.message, data: null, usage: null };
    }
    const page = result.value;
    if (!page.content || page.content.length < 50) {
      return { url: urls[i], success: false, error: "Insufficient content", data: null, usage: null };
    }
    try {
      const { data, usage } = await runExtraction(page, prompt, model);
      return { url: urls[i], success: true, error: null, data, usage };
    } catch (err) {
      return { url: urls[i], success: false, error: err.message, data: null, usage: null };
    }
  });

  return Promise.all(extractionPromises);
}
