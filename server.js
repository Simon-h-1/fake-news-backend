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

// ------------------------
// OPENAI SETUP
// ------------------------
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Optional simple test route
app.get("/test-openai", async (req, res) => {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Say hi in one short sentence." }],
    });

    res.json({
      ok: true,
      output: r.choices[0].message.content,
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

  return JSON.parse(response.choices[0].message.content);
}

// ===============================================================
// 2) SERPAPI SEARCH FOR CLAIM VERIFICATION
// ===============================================================
async function searchWebForClaim(claimText) {
  if (!process.env.SERPAPI_API_KEY) return [];

  const params = {
    api_key: process.env.SERPAPI_API_KEY,
    engine: "google",
    q: claimText,
    hl: "en",
    gl: "us",
    num: 5,
  };

  const url = "https://serpapi.com/search";
  const res = await axios.get(url, { params });

  const organic = res.data.organic_results || [];
  return organic.slice(0, 5).map((r) => ({
    title: r.title,
    snippet: r.snippet || "",
    url: r.link,
  }));
}

// ===============================================================
// 3) VERIFY CLAIM WITH SOURCES — GPT-4o
// ===============================================================
async function verifyClaimWithSources(claimText, sources) {
  const systemPrompt = `
You are a fact-checking assistant.

You get:
- a claim
- web search results (titles, snippets, URLs)

Your job:
- Decide if the claim is likely true, likely false, misleading, or uncertain.
- Cite the relevant sources (by title or URL).
- Base your reasoning ONLY on the provided snippets.
- Output JSON.

{
  "claim": "...",
  "assessment": "...",
  "confidence": 0-1,
  "reasoning": [...],
  "sources_used": [...]
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

  return JSON.parse(response.choices[0].message.content);
}

// ===============================================================
// 4) MAIN ARTICLE ROUTE — /check (TEXT ONLY)
// ===============================================================
app.post("/check", async (req, res) => {
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
            reasoning: ["No search results returned"],
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
// START SERVER
// ===============================================================
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`🚀 Fake-news backend (text-only) running at http://localhost:${port}`);
});


