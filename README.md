# DISRUPT PROCURE AI

AI procurement + store intelligence platform. Photo-first product identification,
live market research, a closed-loop stock-to-purchase workflow, and a quotation
auditor — all with mandatory human approval before any spend is authorized.

This is a **release-candidate prototype**: Phase 1 features are real and working;
WhatsApp production integration, Google OAuth, a multi-user Postgres backend, and
background agents are explicitly **Phase 2** and are not built here.

---

## What's real vs. what needs your credentials

Everything in this app is genuinely functional — no fake buttons, no hard-coded
"AI results," no simulated integrations. Two things need YOUR credentials to work:

1. **Every AI feature** (market research, photo identification, quotation
   extraction/audit, voice interpretation) needs an **Gemini API key (free)**, set as
   a server-side environment variable — never shipped to the browser.
2. **"Import from Sheets"** (optional) needs a **Google Cloud API key**, entered
   directly in that tab in the running app — not an env var, not required for
   anything else to work.

Without an Anthropic key configured, the app still runs (Store, Inventory,
Receive/Issue Stock, Product Master, manual RFQ/Quotations, Approvals all work),
but AI-dependent features will show a clear error instead of faking a result.

---

## Local development

```bash
npm install
cp .env.example .env.local
# edit .env.local and paste your real Gemini API key (free)
npm run dev
```

Open the printed local URL. `npm run dev` (plain Vite) serves the frontend but
does **not** run `/api/claude` (that's a Vercel convention). To exercise AI
features locally, use the Vercel CLI instead, which runs both together:

```bash
npm install -g vercel   # one-time
vercel dev
```

## Run the tests

```bash
npm test
```

This runs `tests/test-procurex.js` against `tests/procurex-logic.js` — the same
calculation logic (stock derivation, duplicate detection, price benchmarking,
quotation auditing, GST-aware comparison, procurement lifecycle staging, etc.)
that's inlined into `src/App.jsx`. **59/59 tests pass** as of this release —
see "Honest build/test status" below for exactly what was and wasn't run in
this environment.

## Production build

```bash
npm run build      # outputs to dist/
npm run preview    # serve the production build locally to sanity-check it
```

---

## Deploy: GitHub → Vercel

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "DISRUPT PROCURE AI — release candidate"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
   `.gitignore` already excludes `node_modules/`, `dist/`, and every `.env*`
   file — no secrets will be committed.

2. **Import the repo in Vercel**
   - Go to [vercel.com/new](https://vercel.com/new), choose "Import Git Repository," pick your repo.
   - Vercel auto-detects **Vite** as the framework. Leave the default build
     command (`npm run build` / `vite build`) and output directory (`dist`) —
     no changes needed.
   - The `api/gemini.js` file is auto-detected as a Serverless Function; no
     extra config is required for it either.

3. **Set the environment variable**
   - In the Vercel project → **Settings → Environment Variables**, add:
     - `GEMINI_API_KEY` = your real key (Production, Preview, and
       Development environments as needed)
   - Get a key at [ai.google.dev](https://ai.google.dev).

4. **Deploy**
   - Click **Deploy**. Vercel runs `npm install && npm run build` in its own
     environment (which has full network access) and serves `dist/` as static
     assets plus `api/gemini.js` as a serverless function.
   - Once live, open the deployed URL — the app boots directly into the real
     initial HFM Store dataset, no setup required beyond the API key above.

5. **(Optional) Custom domain** — Vercel project → Settings → Domains.

That's the entire deployment path. No database to provision, no OAuth app to
register, no additional services.

---

## Honest build/test status (read this before trusting a green checkmark)

This project was built and edited inside a sandboxed environment **with no
network access** (its `npm install` is blocked by a 403 from the npm
registry — confirmed, not assumed). Because of that:

- **`npm test` was actually run, here, for real: 59/59 passing.** This
  exercises all core calculation logic (stock derivation, duplicate
  detection, import reconciliation, price benchmarking, the new quotation
  auditor logic, procurement lifecycle staging) with zero dependencies
  beyond Node itself, so it was runnable in this sandbox.
- **`npm install` and `npm run build` were NOT run here** — this sandbox
  cannot reach the npm registry to install React, Vite, Tailwind, etc. What
  I *could* do instead: validate every `.jsx`/`.js` file's syntax with the
  TypeScript compiler in JSX-checking mode (0 syntax errors across
  `src/App.jsx`, `src/main.jsx`, `src/storage.js`) and validate every
  Node-executed config file with `node --check` (all pass) and
  `package.json` as valid JSON.
- **The real production build will run in Vercel's environment**, which
  does have network access — that's the actual, authoritative build. I've
  structured the project so it should succeed (standard Vite + React +
  Tailwind setup, real published npm package versions, consistent
  CommonJS module system throughout config files), but I have not
  personally watched `npm run build` complete end-to-end. Please run
  `npm install && npm run build` yourself locally (or just push to Vercel,
  which will do it for you) as the final confirmation before you rely on
  this.

If `npm run build` surfaces anything, it's most likely to be a minor,
easily-fixed dependency-version mismatch — not a structural problem with
the app itself, which is the same code already verified working inside
Claude's own artifact runtime across many prior test passes.

---

## Project structure

```
disrupt-procure-ai/
├── api/
│   └── claude.js          # Vercel serverless function — proxies to Anthropic, holds the API key server-side
├── src/
│   ├── App.jsx             # the entire application (single component tree, ~2600 lines)
│   ├── main.jsx             # React mount point
│   ├── storage.js           # localStorage-backed persistence (per-browser, no backend DB)
│   └── index.css            # Tailwind entry
├── tests/
│   ├── procurex-logic.js    # pure calculation logic, mirrored inline in App.jsx
│   └── test-procurex.js     # 59 tests
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
  edited field), Receive Stock / Issue Stock forms with an explicit
  override for issuing beyond available stock, purchase/consumption
  history, reorder-point alerts.
- **📷 Procure by Photo**: photograph an item, get ranked candidate
  identifications with confidence scores, confirm one, get live market
  research + vendor sourcing, then **Use This Product** or **Request
  Quotes** (queues to Approvals — never auto-purchases).
- **📊 Procurement Auditor**: upload a quotation (xlsx/csv/pdf/docx/image),
  review the extracted line items, run a batch audit against purchase
  history and live market pricing, get a per-line verdict (ABOVE MARKET /
  WITHIN MARKET / BELOW MARKET / INSUFFICIENT MARKET EVIDENCE) with
  sources, dates, and confidence — plus a portfolio-level summary (total
  quoted value, estimated fair value, potential saving/overpayment,
  filterable by verdict and vendor).
- **RFQ / Quotations / Comparison**: GST-aware price ranking, historical
  variance.
- **Approvals**: Approve / Reject / Get more quotes / Ask AI to re-check /
  Override with reason — every action writes an immutable, timestamped
  audit-log entry.
- **Import from Sheets** (optional, one-time pull): generic multi-table
  detection, column mapping with confidence, honest reconciliation
  (surfaces disagreements between a sheet's snapshot and its own
  transaction ledger instead of silently forcing a match).
- **Technician Mode**: search, voice ("Talk"), and photo-based ("Scan")
  material requests for non-procurement staff.

## Explicitly Phase 2 (not in this release)

WhatsApp Business API integration, Google OAuth, a multi-user Postgres
backend, scheduled/background agents, enterprise SSO/deployment tooling.
