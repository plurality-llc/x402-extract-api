import "dotenv/config";
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";
import { extract, extractBatch, VALID_INTENTS } from "./extract.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "4021");
const PAY_TO = process.env.PAY_TO_ADDRESS;
const NETWORK = process.env.NETWORK || "base-sepolia";

const NETWORK_MAP = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
};
const networkId = NETWORK_MAP[NETWORK] || NETWORK;

if (!PAY_TO) {
  console.error("PAY_TO_ADDRESS is required in .env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Facilitator setup
// ---------------------------------------------------------------------------
const isMainnet = NETWORK === "base";
const facilitatorUrl = isMainnet
  ? "https://api.cdp.coinbase.com/platform/v2/x402"
  : "https://x402.org/facilitator";

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

if (isMainnet && process.env.CDP_API_KEY_ID) {
  console.log("Using CDP facilitator with authentication");
}

// ---------------------------------------------------------------------------
// x402 Resource Server + Bazaar
// ---------------------------------------------------------------------------
const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register(networkId, new ExactEvmScheme());
resourceServer.registerExtension(bazaarResourceServerExtension);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "16kb" })); // small limit — we only accept schemas, not uploads

// ---------------------------------------------------------------------------
// x402 payment middleware — paid routes + Bazaar discovery
// ---------------------------------------------------------------------------
const accepts = {
  scheme: "exact",
  network: networkId,
  payTo: PAY_TO,
};

const routes = {
  // Single URL extraction via GET (preset intents)
  "GET /extract": {
    accepts: { ...accepts, price: "$0.02" },
    description:
      "Extract structured data from any URL. Pass ?url=...&intent=... with intent being one of: product_specs, company_info, article_summary, pricing, job_listing, reviews.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        input: {
          url: "https://example.com/product",
          intent: "product_specs",
        },
        inputSchema: {
          properties: {
            url: {
              type: "string",
              description: "Publicly accessible URL to extract data from.",
            },
            intent: {
              type: "string",
              description:
                "Extraction type: product_specs, company_info, article_summary, pricing, job_listing, or reviews.",
              enum: [
                "product_specs",
                "company_info",
                "article_summary",
                "pricing",
                "job_listing",
                "reviews",
              ],
            },
          },
          required: ["url", "intent"],
        },
        output: {
          example: {
            success: true,
            intent: "product_specs",
            url: "https://example.com/product",
            data: {
              name: "Example Product",
              brand: "Acme",
              price: { amount: 29.99, currency: "USD" },
              availability: "in_stock",
            },
            usage: { model: "claude-haiku-4-5-20251001", input_tokens: 1200, output_tokens: 350 },
            extracted_at: "2026-03-24T12:00:00Z",
          },
        },
      }),
    },
  },

  // Custom schema + batch extraction via POST
  "POST /extract": {
    accepts: { ...accepts, price: "$0.10" },
    description:
      "Advanced extraction. Send a JSON body with: url (string) or urls (string[], max 10), intent (string, or 'custom'), and optional schema (object, your own JSON schema). Supports batch extraction across multiple URLs in one call.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        bodyType: "json",
        input: {
          urls: ["https://example.com/pricing", "https://other.com/pricing"],
          intent: "custom",
          schema: {
            name: "string",
            monthly_price: "number",
            has_free_tier: "boolean",
          },
        },
        inputSchema: {
          properties: {
            url: { type: "string", description: "Single URL to extract from." },
            urls: {
              type: "array",
              items: { type: "string" },
              description: "Multiple URLs (max 10). Use this OR url, not both.",
            },
            intent: {
              type: "string",
              description:
                "Extraction intent. Use a preset (product_specs, company_info, etc.) or 'custom' with a schema.",
            },
            schema: {
              type: "object",
              description:
                "Your custom JSON schema. Required when intent is 'custom'. Describe the shape of data you want extracted. Max 3000 chars serialized.",
            },
          },
          required: ["intent"],
        },
        output: {
          example: {
            success: true,
            intent: "custom",
            results: [
              {
                url: "https://example.com/pricing",
                success: true,
                data: { name: "Acme Pro", monthly_price: 29, has_free_tier: true },
              },
            ],
            extracted_at: "2026-03-24T12:00:00Z",
          },
        },
      }),
    },
  },
};

app.use(paymentMiddleware(routes, resourceServer));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check (free)
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "x402-extract-api",
    version: "1.1.0",
    network: NETWORK,
    endpoints: {
      "GET /extract": { price: "$0.02", description: "Single URL, preset intent" },
      "POST /extract": {
        price: "$0.10",
        description: "Custom schema, batch (up to 10 URLs), or single URL",
      },
      "POST /valuate": { price: "$0.05", status: "coming_soon" },
    },
    valid_intents: VALID_INTENTS,
  });
});

// GET /extract — single URL, preset intent
app.get("/extract", async (req, res) => {
  const { url, intent } = req.query;

  if (!url || !intent) {
    return res.status(400).json({
      error: "Missing required query params: url, intent",
      valid_intents: VALID_INTENTS.filter((i) => i !== "custom"),
    });
  }

  if (intent === "custom") {
    return res.status(400).json({
      error: "intent=custom requires POST /extract with a schema in the body",
    });
  }

  if (!VALID_INTENTS.includes(intent)) {
    return res.status(400).json({
      error: `Invalid intent: "${intent}"`,
      valid_intents: VALID_INTENTS,
    });
  }

  try {
    const { data, usage } = await extract(url, intent);
    res.json({ success: true, intent, url, data, usage, extracted_at: new Date().toISOString() });
  } catch (err) {
    console.error(`Extraction failed for ${url}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /extract — custom schema, batch, or single URL with body
app.post("/extract", async (req, res) => {
  const { url, urls, intent, schema } = req.body;

  if (!intent) {
    return res.status(400).json({
      error: "Missing required field: intent",
      valid_intents: VALID_INTENTS,
    });
  }

  if (!VALID_INTENTS.includes(intent)) {
    return res.status(400).json({ error: `Invalid intent: "${intent}"`, valid_intents: VALID_INTENTS });
  }

  if (intent === "custom" && !schema) {
    return res.status(400).json({
      error: "intent=custom requires a 'schema' object describing the data shape you want extracted",
      example: { schema: { company_name: "string", employee_count: "number", remote_friendly: "boolean" } },
    });
  }

  // Batch mode
  if (urls && Array.isArray(urls)) {
    if (urls.length > 10) {
      return res.status(400).json({ error: "Batch limited to 10 URLs per request" });
    }
    if (urls.length === 0) {
      return res.status(400).json({ error: "urls array is empty" });
    }

    try {
      const results = await extractBatch(urls, intent, schema || null);
      const totalUsage = results.reduce(
        (acc, r) => {
          if (r.usage) {
            acc.input_tokens += r.usage.input_tokens;
            acc.output_tokens += r.usage.output_tokens;
          }
          return acc;
        },
        { input_tokens: 0, output_tokens: 0 }
      );

      res.json({
        success: true,
        intent,
        batch: true,
        count: urls.length,
        succeeded: results.filter((r) => r.success).length,
        results: results.map(({ url, success, error, data }) => ({ url, success, error, data })),
        usage: { ...totalUsage, model: results.find((r) => r.usage)?.usage?.model || "unknown" },
        extracted_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error("Batch extraction failed:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
    return;
  }

  // Single URL mode (POST)
  if (!url) {
    return res.status(400).json({ error: "Provide either 'url' (string) or 'urls' (array) in the body" });
  }

  try {
    const { data, usage } = await extract(url, intent, schema || null);
    res.json({ success: true, intent, url, data, usage, extracted_at: new Date().toISOString() });
  } catch (err) {
    console.error(`Extraction failed for ${url}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n🔒 x402 Extract API running on http://localhost:${PORT}`);
  console.log(`   Network: ${NETWORK} (${networkId})`);
  console.log(`   Pay to:  ${PAY_TO}`);
  console.log(`   Facilitator: ${facilitatorUrl}`);
  console.log(`\n   Endpoints:`);
  console.log(`     GET  /health   — free`);
  console.log(`     GET  /extract  — $0.02 (preset intent, single URL)`);
  console.log(`     POST /extract  — $0.10 (custom schema, batch up to 10 URLs)`);
  console.log(`     POST /valuate  — $0.05 (coming soon)\n`);
});
