// backend/server.js

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ===============================================================
// SIMPLE DAILY RATE LIMIT (IN-MEMORY)
// ===============================================================
const DAILY_LIMIT = 50;
// key: "<clientId>:YYYY-MM-DD" -> count
const usageCounters = {};

// Try to identify a client (per-IP, works behind common proxies)
function getClientId(req) {
  const xfwd = req.headers["x-forwarded-for"];
  if (xfwd) {
    // first IP in X-Forwarded-For
    return xfwd.split(",")[0].trim();
  }
  return (
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function rateLimit(req, res, next) {
  const clientId = getClientId(req);
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const key = `${clientId}:${today}`;

  const current = usageCounters[key] || 0;

  if (current >= DAILY_LIMIT) {
    return res.status(429).json({
      error: "Daily analysis limit reached",
      limit: DAILY_LIMIT,
      reset: "Resets at midnight (UTC)",
    });
  }

  usageCounters[key] = current + 1;
  next();
}

// ------------------------
// OPENAI SETUP
// ------------------------
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Optional simple test route (not rate-limited)
app.get("/test-openai", async (req, res) => {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Say hi in one short sentence." }],
      response_format: { type: "text" },
    });

    res.json({
      ok: true,
      output: r.choices?.[0]?.message?.content ?? "",
    });
  } catch (err) {
    console.error("Error in /test-openai:", err);
    res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

// ------------------------
// SERPAPI CHECK
// ------------------------
if (!process.env.SERPAPI_API_KEY) {
  console.warn("⚠ Missing SERPAPI_API_KEY (claim verification disabled)");
}

// ------------------------
// HEALTH CHECK
// ------------------------
app.get("/", (req, res) => {
  res.send("Fake-news backend running (text-only, GPT-4o)");
});

// ===============================================================
// 1) TEXT ANALYZER — GPT-4o
// ===============================================================
async function checkNewsWithChatGPT(articleText) {
  if (!articleText || typeof articleText !== "string") {
    throw new Error("articleText must be a non-empty string");
  }

  const systemPrompt = `
You are a careful misinformation and fake-news analyzer.

Provide TWO outputs:
1) OVERALL ARTICLE VERDICT:
   - "likely reliable"
   - "questionable"
   - "very likely misinformation"
   - "uncertain"
   Include 2–5 reasons why.

2) CLAIM-BY-CLAIM ANALYSIS:
   Extract 2–6 key factual claims.
   For each:
     - claim (short)
     - assessment ("likely true" / "likely false" / "misleading" / "uncertain")
     - confidence (0–1)
     - reasons (1–3)
     - suggested_evidence (what type of source would verify it)

Respond ONLY in JSON:
{
  "verdict": "...",
  "confidence": 0-1,
  "explanation": [...],
  "warnings": [...],
  "claims": [
    {
      "claim": "...",
      "assessment": "...",
      "confidence": 0-1,
      "reasons": [...],
      "suggested_evidence": [...]
    }
  ]
}
  `.trim();

  const userPrompt = `
TEXT TO ANALYZE:

"""${articleText.slice(0, 8000)}"""
  `.trim();

  const response = await openai.chat.completions.create({
    model: "gpt-4o", // ⭐ TEXT MODEL
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from OpenAI in checkNewsWithChatGPT");
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    console.error(
      "Failed to parse JSON from OpenAI (checkNewsWithChatGPT):",
      content
    );
    throw new Error("Invalid JSON from OpenAI in checkNewsWithChatGPT");
  }
}

// ===============================================================
// 2) SERPAPI SEARCH FOR CLAIM VERIFICATION
// ===============================================================
async function searchWebForClaim(claimText) {
  const apiKey = process.env.SERPAPI_API_KEY;

  if (!apiKey) {
    console.warn("[SerpAPI] Missing SERPAPI_API_KEY, skipping search");
    return [];
  }

  const params = {
    api_key: apiKey,
    engine: "google",
    q: claimText,
    hl: "en",
    gl: "us",
    num: 5,
  };

  const url = "https://serpapi.com/search";

  try {
    const res = await axios.get(url, { params });
    const organic = res.data?.organic_results || [];

    return organic.slice(0, 5).map((r) => ({
      title: r.title ?? "",
      snippet: r.snippet ?? "",
      url: r.link ?? "",
    }));
  } catch (err) {
    console.error(
      "[SerpAPI] Request failed:",
      err?.response?.data || err.message || String(err)
    );
    return [];
  }
}

// ===============================================================
// 3) VERIFY CLAIM WITH SOURCES — GPT-4o
// ===============================================================
async function verifyClaimWithSources(claimText, sources) {
  const systemPrompt = `
You are a fact-checking assistant.

You get:
- a claim
- web search results (titles, snippets, URLs) about that claim

Your job:
- Decide if the claim is likely true, likely false, misleading, or uncertain.
- Cite only independent sources. Do NOT treat the article being checked itself as a source.
- Base your reasoning ONLY on the provided snippets.
- When listing sources_used, ONLY use URLs and titles that appear in the SEARCH RESULTS.
- Output strict JSON with this shape (no extra keys):

{
  "claim": "...",
  "assessment": "likely true" | "likely false" | "misleading" | "uncertain",
  "confidence": 0-1,
  "reasoning": ["...", "..."],
  "sources_used": [
    {
      "title": "Short name, preferably news org + article title (e.g. 'BBC – Article about X')",
      "url": "https://example.com/article",
      "note": "Optional short note on how this source was used"
    }
  ]
}
  `.trim();

  const userPrompt = `
CLAIM TO VERIFY:
"${claimText}"

SEARCH RESULTS:
${sources
  .map(
    (s, i) => `
[${i + 1}]
Title: ${s.title}
URL: ${s.url}
Snippet: ${s.snippet}
`
  )
  .join("\n")}
  `.trim();

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from OpenAI in verifyClaimWithSources");
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    console.error(
      "Failed to parse JSON from OpenAI (verifyClaimWithSources):",
      content
    );
    throw new Error("Invalid JSON from OpenAI in verifyClaimWithSources");
  }
}

// ===============================================================
// 4) MAIN ARTICLE ROUTE — /check (TEXT ONLY)
// ===============================================================
app.post("/check", rateLimit, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "No text provided" });
    }

    // 1) Base analysis
    const overall = await checkNewsWithChatGPT(text);
    const claims = Array.isArray(overall.claims) ? overall.claims : [];
    const claimsToVerify = claims.slice(0, 3);

    const verifiedClaims = [];

    for (const c of claimsToVerify) {
      try {
        const sources = await searchWebForClaim(c.claim);

        if (!sources.length) {
          verifiedClaims.push({
            claim: c.claim,
            assessment: "uncertain",
            confidence: 0,
            reasoning: ["No search results returned or search failed"],
            sources_used: [],
          });
          continue;
        }

        const verified = await verifyClaimWithSources(c.claim, sources);
        verifiedClaims.push(verified);
      } catch (err) {
        console.error("Claim verification error:", err);
        verifiedClaims.push({
          claim: c.claim,
          assessment: "uncertain",
          confidence: 0,
          reasoning: ["Error during verification"],
          sources_used: [],
        });
      }
    }

    res.json({
      ...overall,
      verifiedClaims,
    });
  } catch (err) {
    console.error("Error in /check:", err);
    res.status(500).json({ error: "Failed to analyze article" });
  }
});

// ===============================================================
// 5) HIGHLIGHTED CLAIM ROUTE — /verify-claim
// ===============================================================
app.post("/verify-claim", rateLimit, async (req, res) => {
  try {
    const { claim } = req.body;

    if (!claim || typeof claim !== "string") {
      return res.status(400).json({ error: "No claim provided" });
    }

    const sources = await searchWebForClaim(claim);

    if (!sources.length) {
      return res.json({
        claim,
        assessment: "uncertain",
        confidence: 0,
        reasoning: ["No search results returned or search failed"],
        sources_used: [],
      });
    }

    const verified = await verifyClaimWithSources(claim, sources);
    res.json(verified);
  } catch (err) {
    console.error("Error in /verify-claim:", err);
    res.status(500).json({ error: "Failed to verify claim" });
  }
});

// ===============================================================
// START SERVER
// ===============================================================
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(
    `🚀 Fake-news backend (text-only) running at http://localhost:${port}`
  );
});
