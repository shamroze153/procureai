// Vercel serverless function (Node.js runtime) — Gemini adapter.
//
// This is the ONE place Gemini's API is spoken. The frontend never sees
// a Gemini-specific request/response shape and never sees GEMINI_API_KEY
// — it sends a provider-neutral shape (system, messages with text/image/
// document content blocks, optional tools=[...] to request web search,
// optional responseSchema in standard JSON Schema for structured output)
// to POST /api/gemini, and gets back { content: [{ type: "text", text }] }
// regardless of which provider is actually behind this file.
//
// Uses the official @google/genai SDK, per prior confirmed-working setup.
// Model: gemini-2.5-flash-lite by default (cheapest current multimodal
// model with Google Search grounding support and the most generous
// free-tier rate limits of Google's current lineup) — override with
// GEMINI_MODEL if Google deprecates it.
//
// IMPORTANT CAVEAT (carried over from when this was last built, still
// unconfirmed as of this writing): combining native structured output
// (responseSchema) with Google Search grounding is only confirmed for
// the Gemini 3.x family in Google's docs, not gemini-2.5-flash-lite. So
// the one call that needs grounding (Market Research) does NOT request
// structured output — it relies on prompt-based JSON plus the frontend's
// hardened extractJSON (truncation-aware, control-character repair)
// instead. Every other call gets real native structured output.

const { GoogleGenAI } = require("@google/genai");

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

function toGeminiParts(content) {
  if (typeof content === "string") return [{ text: content }];
  return (content || []).map((block) => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "image") return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
    if (block.type === "document") return { inlineData: { mimeType: block.source.media_type || "application/pdf", data: block.source.data } };
    return { text: "" };
  });
}

// Converts the app's neutral JSON Schema (lowercase types, ["type","null"]
// unions) into Gemini's own Schema format (uppercase Type strings, a
// separate "nullable" boolean). additionalProperties (a Groq/OpenAI
// strict-mode requirement) is dropped — Gemini doesn't use it.
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  let type = schema.type;
  let nullable = false;
  if (Array.isArray(type)) {
    nullable = type.includes("null");
    type = type.find((t) => t !== "null");
  }
  const out = { ...schema };
  if (type) out.type = type.toUpperCase();
  if (nullable) out.nullable = true;
  if (out.properties) {
    const newProps = {};
    for (const [k, v] of Object.entries(out.properties)) newProps[k] = toGeminiSchema(v);
    out.properties = newProps;
  }
  if (out.items) out.items = toGeminiSchema(out.items);
  delete out.additionalProperties;
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "Server is not configured: GEMINI_API_KEY environment variable is not set in this Vercel project. Add it in Settings -> Environment Variables, then redeploy (env var changes do NOT apply to deployments that already exist).",
    });
    return;
  }

  let ai;
  try {
    ai = new GoogleGenAI({ apiKey });
  } catch (err) {
    res.status(500).json({ error: "Failed to initialize the Gemini SDK: " + err.message });
    return;
  }

  try {
    const { system, messages = [], max_tokens, tools, responseSchema } = req.body || {};
    const userMessage = messages.find((m) => m.role === "user") || messages[0];
    const parts = toGeminiParts(userMessage?.content);
    const useWebSearch = Array.isArray(tools) && tools.length > 0;

    const config = { maxOutputTokens: max_tokens || 1500 };
    if (system) config.systemInstruction = system;
    if (useWebSearch) config.tools = [{ googleSearch: {} }];
    if (responseSchema && !useWebSearch) {
      config.responseMimeType = "application/json";
      config.responseSchema = toGeminiSchema(responseSchema);
    }

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts }],
      config,
    });

    let text = response.text;
    if (!text) {
      const candidate = response.candidates && response.candidates[0];
      text = candidate?.content?.parts?.map((p) => p.text || "").join("\n").trim();
      if (!text) {
        const reason = candidate?.finishReason || "unknown reason";
        res.status(502).json({ error: `Gemini (model: ${MODEL}) returned no usable text (finish reason: ${reason}). This can happen if safety filters blocked the response, or the prompt/response was empty.` });
        return;
      }
    }

    res.status(200).json({ content: [{ type: "text", text }] });
  } catch (err) {
    const status = err?.status || err?.response?.status || 502;
    const detail = err?.message || err?.response?.statusText || String(err);
    if (status === 429 || /RESOURCE_EXHAUSTED/i.test(detail)) {
      res.status(429).json({
        error: `Gemini free-tier quota reached (model: ${MODEL}). This is a rate limit from Google, not a bug — wait a minute and try again, or enable billing on your Google AI Studio project for higher limits (still very cheap; see ai.google.dev/gemini-api/docs/rate-limits).`,
      });
      return;
    }
    res.status(typeof status === "number" ? status : 502).json({ error: `Gemini API error (model: ${MODEL}): ${detail}` });
  }
};
