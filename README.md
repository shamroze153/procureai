# DISRUPT PROCURE AI

AI procurement + store intelligence platform. Photo-first product identification,
live market research, a closed-loop stock-to-purchase workflow, and a quotation
auditor — all with mandatory human approval before any spend is authorized.

This is a **release-candidate prototype**: Phase 1 features are real and working;
WhatsApp production integration, Google OAuth, a multi-user Postgres backend, and
background agents are explicitly **Phase 2** and are not built here.

---

## AI provider: Gemini

The app's AI backend is **Google Gemini** (ai.google.dev), reached only through a
server-side Vercel function (`api/gemini.js`) — the frontend never sees or sends
your API key.

- **Model**: `gemini-2.5-flash-lite` by default — the cheapest current Gemini
  model that's still genuinely multimodal (text/image/PDF) and supports Google
  Search grounding, with the most generous free-tier rate limits in Google's
  current lineup. Override with the `GEMINI_MODEL` env var if Google deprecates
  it — no code change needed.
- **Structured JSON output**: used for every AI call except one (see below) —
  native `responseSchema` constrained decoding, not fragile text parsing.
- **Web search**: Google Search grounding, used for Market Research.

**One known caveat, found while researching (not silently assumed):**
combining native structured output (`responseSchema`) with Google Search
grounding is only confirmed for the Gemini 3.x family in Google's docs — not
`gemini-2.5-flash-lite`. So Market Research (the one call that needs grounding)
relies on prompt-based JSON instead of a schema, backed by the frontend's
hardened `extractJSON` parser, which repairs the two real failure modes already
found in production use: responses truncated mid-JSON (raised the token budget)
and literal unescaped control characters inside a JSON string value (auto-repaired).

## Getting a Gemini API key

1. Go to [ai.google.dev](https://ai.google.dev) → "Get API key"
2. Sign in with a Google account (phone verification unlocks ~$5 free trial
   credit; the ongoing free tier itself needs no card)
3. Create a key and copy it

## Environment variables

```
GEMINI_API_KEY=
```

That's the only required one. See `.env.example` (includes an optional
`GEMINI_MODEL` override).

## Local development

```bash
npm install
cp .env.example .env.local
# edit .env.local and paste your real Gemini API key
npm run dev
```

`npm run dev` (plain Vite) serves the frontend but does **not** run
`/api/gemini` (that's a Vercel convention). To exercise AI features locally,
use the Vercel CLI instead, which runs both together:

```bash
npm install -g vercel   # one-time
vercel dev
```

## Run the tests

```bash
npm test
```

Runs `tests/test-procurex.js` against `tests/procurex-logic.js` — the same
calculation logic (stock derivation, duplicate detection, price benchmarking,
quotation auditing, document classification, and the Gemini schema-conversion
logic) that's inlined into `src/App.jsx`. **96/96 tests pass** as of this release.

## Production build

```bash
npm run build      # outputs to dist/
npm run preview    # serve the production build locally to sanity-check it
```

---

## Deploy: GitHub → Vercel

1. **Push to GitHub** — `.gitignore` already excludes `node_modules/`, `dist/`,
   and every `.env*` file, so no secrets get committed.
2. **Import the repo in Vercel** ([vercel.com/new](https://vercel.com/new)) —
   Vercel auto-detects Vite; leave the default build command/output directory.
   `api/gemini.js` is auto-detected as a Serverless Function, no extra config.
3. **Set the environment variable** — Project → Settings → Environment
   Variables → add `GEMINI_API_KEY` = your real key (Production + Preview).
4. **Deploy** — Vercel runs `npm install && npm run build` in its own
   environment.
5. **Redeploy after any env var change** — adding or changing an environment
   variable never applies to deployments that already exist; you must trigger
   a new deployment (Deployments tab → latest → ⋯ → Redeploy) after saving it.

## Testing the live app after deploying

1. **Settings → Run connection test** — one minimal real request; should show
   `Connection: CONNECTED` and the model actually used.
2. **Market Research** — type a real product, confirm it returns sourced
   findings (or an honest "insufficient evidence" — never a fabricated price).
3. **Procurement Auditor** — upload a real Excel/CSV quotation.
4. **Procure by Photo** — upload a real product photo.

If any of these fail, the app shows the real error text from Gemini (rate
limit, invalid key, model error, etc.) instead of a generic failure — read it,
it usually tells you exactly what's wrong. A `429`/quota message is Google's
free-tier rate limit, not a bug — wait a bit or enable billing for higher limits.

---

## Honest build/test status

This project was built and edited inside a sandboxed environment **with no
network access** — its `npm install` is blocked by the npm registry (confirmed,
not assumed). Because of that:

- **`npm test` was actually run, here, for real: 96/96 passing.** Zero
  dependencies beyond Node itself, so it was runnable in this sandbox.
- **`npm install` and `npm run build` were NOT run here** — this sandbox
  cannot reach the npm registry. Every `.jsx`/`.js` file's syntax was validated
  instead (0 errors).
- **This exact Gemini setup was previously live-tested** earlier in this
  project's development (real 429 quota responses and a real malformed-JSON
  response were both observed and fixed against actual Gemini API traffic) —
  but the schema-conversion logic (`toGeminiSchema`) is new since then, added
  to match how the frontend's schemas changed during an interim provider
  experiment. That specific conversion is unit-tested (see `test-procurex.js`)
  but not yet exercised against a live Gemini request — verify with the
  Settings connection test after deploying.

## Project structure

```
disrupt-procure-ai/
├── api/
│   └── gemini.js            # Vercel serverless function — the ONLY place Gemini's API is spoken; holds the key server-side
├── src/
│   ├── App.jsx               # the entire application (single component tree)
│   ├── main.jsx               # React mount point
│   ├── storage.js             # localStorage-backed persistence (per-browser, no backend DB)
│   └── index.css              # Tailwind entry
├── tests/
│   ├── procurex-logic.js      # pure calculation + provider-adapter logic, mirrored inline in App.jsx
│   └── test-procurex.js       # 96 tests
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .env.example
└── .gitignore
```

## Feature summary (this release)

- **Store**: Product Master, derived-only current stock (never a manually
  edited field), Receive Stock / Issue Stock forms with an explicit override
  for issuing beyond available stock, purchase/consumption history, reorder
  point alerts.
- **📷 Procure by Photo**: photograph an item, get ranked candidate
  identifications with confidence scores, confirm one, get live market
  research + vendor sourcing, then **Use This Product** or **Request Quotes**
  (queues to Approvals — never auto-purchases).
- **📊 Procurement Auditor**: upload a quotation (xlsx/csv/pdf/docx/image) —
  the file is classified first (Vendor Quotation vs. Internal Demand vs. Price
  List vs. Store/Inventory) so an internal request list is never treated as a
  real quotation. Genuine quotations get a batch audit against purchase
  history and live market pricing, with a per-line verdict, sources, dates,
  and confidence.
- **RFQ / Quotations / Comparison**: GST-aware price ranking, historical
  variance.
- **Approvals**: Approve / Reject / Get more quotes / Ask AI to re-check /
  Override with reason — every action writes an immutable, timestamped
  audit-log entry.
- **Import from Sheets** (optional, one-time pull): generic multi-table
  detection, column mapping with confidence, honest reconciliation.
- **Technician Mode**: search, voice, and photo-based material requests.
- **⚙️ Settings**: AI connection test — one real request, shows provider,
  model, and connection status.

## Explicitly Phase 2 (not in this release)

WhatsApp Business API integration, Google OAuth, a multi-user Postgres
backend, scheduled/background agents, enterprise SSO/deployment tooling.
