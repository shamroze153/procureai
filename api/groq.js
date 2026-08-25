// Vercel serverless function (Node.js runtime) — Groq adapter.
//
// This is the ONE place Groq's API is spoken. The frontend never sees a
// Groq-specific request/response shape and never sees GROQ_API_KEY — it
// sends a provider-neutral shape (system, messages with text/image/
// document content blocks, optional tools=[...] to request web search,
// optional responseSchema for structured output) to POST /api/groq, and
// gets back { content: [{ type: "text", text }] } regardless of which
// provider is actually behind this file. Swapping providers again later
// means writing one new adapter file — no frontend changes.
//
// Built against official Groq documentation (console.groq.com), verified
// before writing this file, not guessed:
//   - Base URL: https://api.groq.com/openai/v1 (OpenAI-compatible)
//   - Auth: Authorization: Bearer $GROQ_API_KEY
//   - /chat/completions — standard OpenAI-compatible messages array.
//   - Groq's capabilities are split across models — there is no one
//     model that does vision + structured output + web search. See
//     chooseGroqModel() below for the confirmed routing, mirrored from
//     tests/procurex-logic.js where it's unit tested.
//
// UNCONFIRMED / gaps found while researching (not silently assumed):
//   - PDF/document input: Groq's vision docs describe image_url input
//     (max 5 images, 20MB) — no documented PDF/document attachment
//     support. A PDF sent to this adapter becomes a visible placeholder
//     text block (see toOpenAIContent below) rather than pretending
//     extraction happened.
//   - Strict json_schema structured output on the vision model
//     (qwen/qwen3.6-27b) is NOT confirmed — only the looser json_object
//     mode is documented for it. Vision calls that need JSON use
//     json_object instead of json_schema; the frontend's hardened
//     extractJSON (control-character repair, truncation-aware errors)
//     is the safety net for the less-constrained output.
//   - Combining response_format with groq/compound's automatic web
//     search tool use is not confirmed — the web-search call requests
//     no structured output at all, relying on prompt-based JSON + the
//     same hardened parser.
//   - Exact free-tier rate limits per model are not enumerated in what
//     I could access — check https://console.groq.com for your account's
//     actual current limits rather than assuming a number.

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

function toOpenAIContent(content) {
  if (typeof content === "string") return content;
  return (content || []).map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") return { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
    if (block.type === "document") return { type: "text", text: "[A document/PDF was attached here. PDF input is not confirmed-supported by the Groq API — this placeholder is a visible signal that extraction from this file may not have actually reached the model. Verify against a real request before trusting results from PDF uploads.]" };
    return { type: "text", text: "" };
  });
}

function buildJsonSchemaResponseFormat(schema, name) {
  return { type: "json_schema", json_schema: { name: name || "response", strict: true, schema } };
}

// Confirmed model routing — see file header for the evidence behind each choice.
// groq/compound had a documented, reported bug independent of request
// size/content (other developers hit "Request Entity Too Large" on small,
// ordinary requests) — using groq/compound-mini instead, Groq's documented
// lighter alternative with the same web-search capability.
function chooseGroqModel({ hasImage, useWebSearch, hasSchema }) {
  if (useWebSearch) return { model: "groq/compound-mini", responseFormatMode: "none" };
  if (hasImage) return { model: "qwen/qwen3.6-27b", responseFormatMode: hasSchema ? "json_object" : "none" };
  return { model: "openai/gpt-oss-20b", responseFormatMode: hasSchema ? "json_schema" : "none" };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "Server is not configured: GROQ_API_KEY environment variable is not set in this Vercel project. Add it in Settings -> Environment Variables, then redeploy (env var changes do NOT apply to deployments that already exist).",
    });
    return;
  }

  try {
    const { system, messages = [], max_tokens, tools, responseSchema, responseSchemaName } = req.body || {};
    const userMessage = messages.find((m) => m.role === "user") || messages[0];
    const useWebSearch = Array.isArray(tools) && tools.length > 0;
    const rawContent = userMessage?.content;
    const hasImage = Array.isArray(rawContent) && rawContent.some((b) => b.type === "image");

    const { model, responseFormatMode } = chooseGroqModel({ hasImage, useWebSearch, hasSchema: !!responseSchema });

    const chatMessages = [];
    if (system) chatMessages.push({ role: "system", content: system });
    chatMessages.push({ role: "user", content: toOpenAIContent(rawContent) });

    const body = { model, messages: chatMessages, max_tokens: max_tokens || 1500, stream: false };
    if (responseFormatMode === "json_schema") body.response_format = buildJsonSchemaResponseFormat(responseSchema, responseSchemaName);
    else if (responseFormatMode === "json_object") body.response_format = { type: "json_object" };

    const upstream = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();

    if (!upstream.ok) {
      const detail = data?.error?.message || JSON.stringify(data?.error) || "request failed";
      if (upstream.status === 429) {
        res.status(429).json({ error: `Groq rate limit or quota reached (model: ${model}). Wait and retry, or check usage/limits at https://console.groq.com.` });
        return;
      }
      res.status(upstream.status).json({ error: `Groq API error (model: ${model}): ${detail}` });
      return;
    }

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      const reason = data.choices?.[0]?.finish_reason || "unknown reason";
      res.status(502).json({ error: `Groq (model: ${model}) returned no usable text (finish reason: ${reason}).` });
      return;
    }

    res.status(200).json({ content: [{ type: "text", text }] });
  } catch (err) {
    res.status(502).json({ error: "Failed to reach the Groq API: " + err.message });
  }
};
