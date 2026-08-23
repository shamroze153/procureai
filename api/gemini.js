// Vercel serverless function (Node.js runtime) — Gemini adapter.
//
// The frontend (src/App.jsx) was written against Claude's request/response
// shape and is left completely unchanged. This function accepts that same
// shape, calls the REAL Gemini API using the official @google/genai SDK
// with GEMINI_API_KEY (server-side only, never sent to the browser, never
// included in any response), and translates Gemini's response back into
// the shape the frontend already knows how to read.
//
// Get a free key (no credit card) at https://ai.google.dev -> Get API key.
//
// --- ROOT CAUSE OF THE "AI request failed (404)" BUG, for the record ---
// The model ID this file used to call ("gemini-2.5-flash") is deprecated.
// Google's own documentation states that requests to deprecated model IDs
// return HTTP 404 — that 404 was coming from Google's API, not from a
// missing file, a wrong folder, or a bad API key. It only looked like a
// deployment problem because the generic frontend error message didn't
// show the real reason. Both are fixed below: a current model ID, and
// the actual upstream error message is now shown instead of just a
// status code.

const { GoogleGenAI } = require("@google/genai");

// Override with a GEMINI_MODEL env var if Google deprecates this one too —
// no code change needed, just update the env var and redeploy.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

function toGeminiParts(content) {
  if (typeof content === "string") return [{ text: content }];
  return (content || []).map((block) => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "image") return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
    if (block.type === "document") return { inlineData: { mimeType: block.source.media_type || "application/pdf", data: block.source.data } };
    return { text: "" };
  });
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
    const { system, messages = [], max_tokens, tools } = req.body || {};
    const userMessage = messages.find((m) => m.role === "user") || messages[0];
    const parts = toGeminiParts(userMessage?.content);
    const useWebSearch = Array.isArray(tools) && tools.length > 0;

    const config = { maxOutputTokens: max_tokens || 1500 };
    if (system) config.systemInstruction = system;
    if (useWebSearch) config.tools = [{ googleSearch: {} }];

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts }],
      config,
    });

    // response.text is the SDK's own convenience accessor that concatenates
    // every text part; fall back to walking candidates manually in case a
    // future SDK version changes that shape.
    let text = response.text;
    if (!text) {
      const candidate = response.candidates && response.candidates[0];
      text = candidate?.content?.parts?.map((p) => p.text || "").join("\n").trim();
      if (!text) {
        const reason = candidate?.finishReason || "unknown reason";
        res.status(502).json({ error: `Gemini (model: ${MODEL}) returned no usable text (finish reason: ${reason}). This can happen if the safety filters blocked the response, or the prompt/response was empty.` });
        return;
      }
    }

    // translate back into the Claude-shaped response the frontend already parses
    res.status(200).json({ content: [{ type: "text", text }] });
  } catch (err) {
    // The SDK throws on non-2xx responses; surface exactly what Google said,
    // including the model name, so a deprecated/invalid model ID (or any
    // other real cause) is immediately visible instead of a bare status code.
    const status = err?.status || err?.response?.status || 502;
    const detail = err?.message || err?.response?.statusText || String(err);
    res.status(typeof status === "number" ? status : 502).json({
      error: `Gemini API error (model: ${MODEL}): ${detail}`,
    });
  }
};
