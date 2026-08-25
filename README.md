# DISRUPT PROCURE AI

AI procurement + store intelligence platform. Photo-first product identification,
live market research, a closed-loop stock-to-purchase workflow, and a quotation
auditor — all with mandatory human approval before any spend is authorized.

This is a **release-candidate prototype**: Phase 1 features are real and working;
WhatsApp production integration, Google OAuth, a multi-user Postgres backend, and
background agents are explicitly **Phase 2** and are not built here.

---

## AI provider: Groq

The app's AI backend is **Groq** (console.groq.com), reached only through a
server-side Vercel function (`api/groq.js`) — the frontend never sees or sends
your API key. Groq's capabilities are split across models (there's no single
Groq model that does vision + structured JSON + web search all at once), so
`api/groq.js` picks the right model per request automatically:

| Request needs | Model used | Why |
|---|---|---|
| Live web search (Market Research) | `groq/compound` | Groq's agentic system with built-in, auto-activating web search |
| Image input (Procure by Photo, Technician Scan) | `qwen/qwen3.6-27b` | Confirmed vision support in Groq's docs; JSON requests to this model use the looser `json_object` mode, not strict schema (see note below) |
| Everything else needing structured JSON | `openai/gpt-oss-20b` | Confirmed strict `json_schema` structured-output support in Groq's own docs |

**Known gaps, found while researching (not silently assumed to work):**
- **PDF/document input is not confirmed-supported** by Groq's API — only image
  input is documented. A PDF sent to the AI becomes a visible placeholder text
  block instead of pretending extraction happened. If you rely on Procurement
  Auditor's PDF upload path, test it specifically — it may not work until Groq
  documents PDF support.
- **Strict JSON-schema structured output on the vision model is unconfirmed** —
  only the looser `json_object` mode is documented for `qwen/qwen3.6-27b`. Image
  requests get less-constrained JSON than text-only requests; the frontend's
  `extractJSON` parser (with truncation/control-character repair already built
  in) is the safety net.
- **Exact free-tier rate limits per model** aren't enumerated anywhere I could
  access — check your actual limits at console.groq.com rather than assuming a
  number.

## Getting a Groq API key

1. Go to [console.groq.com](https://console.groq.com) → sign up / log in
2. **API Keys** in the sidebar → **Create API Key**
3. Copy it — you won't be able to see it again after leaving the page

## Environment variable

```
GROQ_API_KEY=
```

That's the only required one. See `.env.example`.

## Local development

```bash
npm install
cp .env.example .env.local
# edit .env.local and paste your real Groq API key
npm run dev
```

`npm run dev` (plain Vite) serves the frontend but does **not** run
`/api/groq` (that's a Vercel convention). To exercise AI features locally,
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
quotation auditing, document classification, and the Groq model-routing logic)
that's inlined into `src/App.jsx`. **86/86 tests pass** as of this release.

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
   `api/groq.js` is auto-detected as a Serverless Function, no extra config.
3. **Set the environment variable** — Project → Settings → Environment
   Variables → add `GROQ_API_KEY` = your real key (Production + Preview).
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

If any of these fail, the app shows the real error text from Groq (rate limit,
invalid key, model error, etc.) instead of a generic failure — read it, it
usually tells you exactly what's wrong.

---

## Honest build/test status

This project was built and edited inside a sandboxed environment **with no
network access** — its `npm install` is blocked by the npm registry (confirmed,
not assumed). Because of that:

- **`npm test` was actually run, here, for real: 86/86 passing.** Zero
  dependencies beyond Node itself, so it was runnable in this sandbox.
- **`npm install` and `npm run build` were NOT run here** — this sandbox
  cannot reach the npm registry. Every `.jsx`/`.js` file's syntax was validated
  instead (0 errors), and every Node-executed config file passes `node --check`.
- **No live Groq API request has been made from this code** — I don't have a
  Groq key and this sandbox has no network access to test one anyway. Every
  endpoint, auth header, request/response shape, and model choice was verified
  against Groq's own documentation (console.groq.com) before being written —
  not guessed — but the actual live request/response cycle is genuinely
  **UNTESTED** until you run the Settings connection test after deploying.

## Project structure

```
disrupt-procure-ai/
├── api/
│   └── groq.js             # Vercel serverless function — the ONLY place Groq's API is spoken; holds the key server-side
├── src/
│   ├── App.jsx              # the entire application (single component tree)
│   ├── main.jsx              # React mount point
│   ├── storage.js            # localStorage-backed persistence (per-browser, no backend DB)
│   └── index.css             # Tailwind entry
├── tests/
│   ├── procurex-logic.js     # pure calculation + provider-adapter logic, mirrored inline in App.jsx
│   └── test-procurex.js      # 86 tests
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
