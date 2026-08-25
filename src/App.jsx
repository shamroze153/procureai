import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import { storage as localStorageAdapter } from "./storage.js";

// Standalone deployment: no window.storage host API exists outside the
// Claude artifact runtime, so provide the same shape backed by
// localStorage. Every existing window.storage.get/set call in this file
// is untouched — this just makes that API real in a browser.
if (typeof window !== "undefined" && !window.storage) window.storage = localStorageAdapter;

/* ============================================================
   DISRUPT PROCURE AI — AI Procurement + Store Intelligence Platform
   Working MVP. Every calculation below runs on real data you
   feed it. AI calls hit the real Groq API (web search enabled via
   groq/compound for market research) via a server-side proxy
   (/api/groq) so no API key is ever exposed to the browser.
   Nothing here fakes a result — if there isn't enough evidence,
   the UI says so instead of inventing one.
   ============================================================ */

// ---------- fonts / tokens ----------
const FontStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
    :root{
      --void:#12151B; --panel:#191D25; --panel2:#1F2430; --border:#2B3140;
      --amber:#F0A83A; --amber-dim:#8A6526; --cyan:#4FD1C5; --cyan-dim:#1E4A47;
      --text:#E7EAEF; --muted:#8B93A5; --danger:#E5484D; --success:#3DD68C; --warn:#F0A83A;
    }
    .px-font-display{font-family:'Space Grotesk',sans-serif;}
    .px-font-body{font-family:'Inter',sans-serif;}
    .px-font-mono{font-family:'JetBrains Mono',monospace;}
    .px-scroll::-webkit-scrollbar{width:8px;height:8px;}
    .px-scroll::-webkit-scrollbar-thumb{background:#2B3140;border-radius:8px;}
    .px-gauge-ring{transition:stroke-dashoffset .6s ease;}
  `}</style>
);

// ---------- helpers: fuzzy matching / normalization ----------
// NOTE: this block mirrors /home/claude/procurex-logic.js exactly, which
// carries 32 passing automated tests (see PROCUREX_TEST_REPORT.md). Keep
// the two byte-for-byte in sync if either changes — this is the single
// source of truth for every number on screen.
const SCHEMA_SYNONYMS = {
  product_name: ["item", "product", "material", "description", "item name", "item description", "product name"],
  category: ["category", "cat", "item type"],
  current_stock: ["current stock", "current qty", "closing stock"],
  txn_quantity: ["qty", "quantity"],
  min_stock: ["minimum stock", "min stock", "reorder level", "min qty", "minimum"],
  unit_price: ["unit price", "unit cost", "rate", "purchase price"],
  avg_cost_snapshot: ["average unit cost", "avg unit cost"],
  total_value: ["total value", "total cost", "amount"],
  vendor: ["vendor", "supplier", "vendor name"],
  transaction_type: ["transaction type", "type", "in out"],
  transaction_date: ["date", "transaction date"],
  person: ["person", "issued by", "received by"],
  reason: ["reason", "purpose"],
  remarks: ["remarks", "notes"],
  location: ["location", "store", "warehouse"],
  rating: ["rating", "score"],
  total_in: ["total in"],
  total_out: ["total out"],
  stock_status_source: ["stock status", "status"],
};

// current_stock (item-level snapshot) and txn_quantity (per-transaction
// movement) are DELIBERATELY separate fields. The client's real HFM sheet
// has both "Current Stock" and "Quantity" as distinct columns — an earlier
// build conflated them into one field, which silently corrupted stock
// levels on any transaction-log-style sheet.
function normalizeToken(s) {
  // Replace punctuation with a SPACE (not delete), so "Reason/Purpose"
  // tokenizes as {reason, purpose} instead of gluing into "reasonpurpose".
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(s) {
  return new Set(normalizeToken(s).split(" ").filter(Boolean));
}

function jaccard(a, b) {
  const A = tokenSet(a), B = tokenSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach((t) => { if (B.has(t)) inter++; });
  const union = new Set([...A, ...B]).size;
  return inter / union;
}

// spec-carrying tokens: 32a, 2p, 45uf, 400v, m10 — used to stop
// duplicate-detection from merging genuinely different specs
function specTokens(s) {
  return new Set([...tokenSet(s)].filter((t) => /^[a-z]*\d+[a-z]*$/.test(t)));
}
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// robust number parsing: "4,650" / "Rs. 4,650.50" / "PKR 200" / "-5" / ""
function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === "") return null;
  s = s.replace(/,/g, "");
  s = s.replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === ".") return null;
  const parts = s.split(".");
  if (parts.length > 2) s = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function mapColumn(header) {
  const h = normalizeToken(header);
  let best = { field: null, confidence: 0 };
  for (const [field, synonyms] of Object.entries(SCHEMA_SYNONYMS)) {
    for (const syn of synonyms) {
      const synN = normalizeToken(syn);
      const sim = jaccard(h, synN) * 0.6 + (h === synN ? 0.4 : 0) + (h.includes(synN) || synN.includes(h) ? 0.25 : 0);
      const capped = Math.min(0.99, sim);
      if (capped > best.confidence) best = { field, confidence: capped };
    }
  }
  if (best.confidence < 0.35) return { field: null, confidence: 0 };
  return { field: best.field, confidence: Math.round(best.confidence * 100) };
}

// flags >1 source column mapped to the same target field — these
// silently overwrote each other (last-wins) before this was added
function findMappingCollisions(headers, mapping) {
  const byField = {};
  headers.forEach((h) => {
    const f = mapping[h]?.field;
    if (!f) return;
    (byField[f] = byField[f] || []).push(h);
  });
  return Object.entries(byField).filter(([, hs]) => hs.length > 1);
}

function computeStockHealth(current, min, monthlyConsumption) {
  const cur = toNumber(current);
  const minS = toNumber(min) || 0;
  const cons = toNumber(monthlyConsumption) || 0;
  if (cur === null) return { state: "UNKNOWN", coverageMonths: null };
  if (cur < 0) return { state: "DATA ERROR", coverageMonths: null };
  if (cur === 0) return { state: "CRITICAL", coverageMonths: 0 };
  if (minS > 0 && cur < minS * 0.5) return { state: "CRITICAL", coverageMonths: cons > 0 ? +(cur / cons).toFixed(1) : null };
  if (minS > 0 && cur < minS) return { state: "LOW", coverageMonths: cons > 0 ? +(cur / cons).toFixed(1) : null };
  if (minS > 0 && cur < minS * 1.25) return { state: "REORDER SOON", coverageMonths: cons > 0 ? +(cur / cons).toFixed(1) : null };
  if (cons > 0) {
    const coverage = cur / cons;
    if (coverage > 18) return { state: "DEAD STOCK", coverageMonths: +coverage.toFixed(1) };
    if (coverage > 9) return { state: "OVERSTOCK", coverageMonths: +coverage.toFixed(1) };
    return { state: "HEALTHY", coverageMonths: +coverage.toFixed(1) };
  }
  return { state: minS > 0 && cur > minS * 3 ? "OVERSTOCK" : "HEALTHY", coverageMonths: null };
}

function reorderQty(current, min, monthlyConsumption, leadTimeDays = 7) {
  const cur = toNumber(current) || 0, minS = toNumber(min) || 0, cons = toNumber(monthlyConsumption) || 0;
  const leadConsumption = cons * (leadTimeDays / 30);
  const target = minS * 1.5 + leadConsumption;
  return Math.max(0, Math.round(target - cur));
}

function vendorScore(v) {
  const w = { reliability: 0.3, delivery: 0.25, quality: 0.25, price: 0.2 };
  return Math.round(
    (v.reliability || 0) * w.reliability +
    (v.delivery || 0) * w.delivery +
    (v.quality || 0) * w.quality +
    (v.priceCompetitiveness || 0) * w.price
  );
}

// Name similarity ALONE is not sufficient (spec explicitly warns against
// this). Two products with high name overlap but differing spec tokens
// (32A vs 16A, 1P vs 2P) or differing unit-of-measure are genuinely
// different products and must not be flagged as duplicates.
function isDuplicateCandidate(a, b) {
  if (a.category && b.category && a.category !== b.category) return { dup: false };
  const nameSim = jaccard(a.name, b.name);
  if (nameSim < 0.55) return { dup: false };
  const specA = specTokens(a.name), specB = specTokens(b.name);
  if (specA.size && specB.size && !setsEqual(specA, specB)) return { dup: false };
  if (a.uom && b.uom && a.uom !== b.uom) return { dup: false };
  return { dup: true, similarity: Math.round(nameSim * 100) };
}

// Takes raw parsed rows + confirmed mapping + products already in state
// and returns NEW products/transactions arrays (no mutation of inputs).
// Repeated rows for the same item (a real transaction ledger) merge into
// ONE product instead of creating a duplicate per row.
// parses a star-rating cell ("⭐⭐⭐⭐⭐") or a plain number; null if neither
function parseRating(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const stars = (s.match(/⭐|★/g) || []).length;
  if (stars > 0) return stars;
  return toNumber(v);
}
// flags vendor names that look like unfilled placeholder text ("Vendor A")
function looksLikePlaceholderVendor(name) {
  return /^vendor\s*[a-z0-9]{1,3}$/i.test(String(name || "").trim());
}

// ---------- current stock: ALWAYS derived, never a stored/editable field ----------
function computeCurrentStock(productId, transactions) {
  const relevant = transactions.filter((t) => t.productId === productId && ["IN", "OUT", "ADJUSTMENT"].includes(t.type));
  if (!relevant.length) return null;
  let total = 0;
  relevant.forEach((t) => { const q = Number(t.qty) || 0; total += t.type === "OUT" ? -q : q; });
  return total;
}

// pure decision function — does not mutate; the UI decides what to do with it
function validateIssueQuantity(productId, transactions, requestedQty) {
  const available = computeCurrentStock(productId, transactions);
  const qty = Number(requestedQty) || 0;
  if (available === null) return { available: null, wouldGoNegative: true, resultingStock: -qty, allowedWithoutOverride: false };
  const resultingStock = available - qty;
  return { available, wouldGoNegative: resultingStock < 0, resultingStock, allowedWithoutOverride: resultingStock >= 0 };
}

// procurement lifecycle stage — derived from the request object + real
// quotation count, never a separately stored/driftable field
function computeProcurementStage(rfq, quotationsCount = 0) {
  if (!rfq) return "Stock Alert";
  if (rfq.audit) return "Audited";
  if (rfq.receivedTransactionId) return "Received";
  if (rfq.purchase) return "Purchased";
  if (rfq.status === "APPROVED" || rfq.status === "APPROVED (OVERRIDE)") return "Approved";
  if (rfq.status === "CLOSED" || rfq.status === "REJECTED") return "Manager Approval";
  if (rfq.benchmark) return "AI Recommendation";
  if (quotationsCount > 1) return "Comparison";
  if (quotationsCount === 1) return "Quotations";
  if (rfq.message) return "RFQ";
  if (rfq.marketEvidence) return "AI Research";
  return "Stock Alert";
}
const PROCUREMENT_STAGES = ["Stock Alert", "AI Research", "RFQ", "Quotations", "Comparison", "AI Recommendation", "Approved", "Purchased", "Received", "Audited"];

function buildImportPlan(headers, rows, mapping, existingProducts, existingTransactions, sourceLabel) {
  const productIndex = new Map();
  existingProducts.forEach((p) => productIndex.set(normalizeToken(p.name), { ...p }));
  const newTransactions = [];
  const warnings = [];
  const declaredStock = new Map(); // productId -> last non-blank "current stock" value seen in THIS import
  let skippedBlank = 0, skippedNoName = 0, txCreated = 0;

  rows.forEach((row, rowIdx) => {
    const allBlank = headers.every((h) => String(row[h] ?? "").trim() === "");
    if (allBlank) { skippedBlank++; return; }
    const rec = {};
    headers.forEach((h) => { const t = mapping[h]?.field; if (t) rec[t] = row[h]; });
    const name = String(rec.product_name || "").trim();
    if (!name) { skippedNoName++; return; }
    const key = normalizeToken(name);
    let product = productIndex.get(key);
    if (!product) {
      // NOTE: no current_stock field here at all — stock is never stored,
      // only ever derived via computeCurrentStock().
      product = { id: uid("prod"), name, normalized_name: key, category: rec.category || "Uncategorized",
        subcategory: "", brand: "", uom: "pcs", min_stock: null, preferred_vendor: "", confidence: 100, source: sourceLabel };
      productIndex.set(key, product);
    }
    const curVal = toNumber(rec.current_stock);
    if (curVal !== null) declaredStock.set(product.id, curVal);
    const minVal = toNumber(rec.min_stock);
    if (minVal !== null) product.min_stock = minVal;
    if (rec.stock_status_source) product.source_stock_status = String(rec.stock_status_source);
    if (toNumber(rec.total_in) !== null) product.total_in = toNumber(rec.total_in);
    if (toNumber(rec.total_out) !== null) product.total_out = toNumber(rec.total_out);
    const avgSnap = toNumber(rec.avg_cost_snapshot);
    if (avgSnap !== null) product.avg_cost_snapshot = avgSnap; // valuation figure only — never a transaction

    // avg_cost_snapshot deliberately does NOT count as transaction evidence —
    // it's an item-level valuation figure, not a purchase event
    const txQty = toNumber(rec.txn_quantity);
    const unitCost = toNumber(rec.unit_price);
    const hasTxSignal = txQty !== null || unitCost !== null || rec.vendor || rec.transaction_date;
    if (hasTxSignal) {
      if (unitCost === null) warnings.push(`Row ${rowIdx + 2}: "${name}" — no unit price, logged without cost.`);
      if (!rec.vendor) warnings.push(`Row ${rowIdx + 2}: "${name}" — no vendor, logged without vendor.`);
      if (rec.vendor && looksLikePlaceholderVendor(rec.vendor)) warnings.push(`Row ${rowIdx + 2}: "${name}" — vendor "${rec.vendor}" looks like placeholder text, not a confirmed real vendor.`);
      newTransactions.push({
        id: uid("tx"), productId: product.id, vendorName: rec.vendor || "",
        type: rec.transaction_type || (txQty !== null && txQty < 0 ? "OUT" : "IN"),
        qty: txQty !== null ? Math.abs(txQty) : 1, unitCost, date: rec.transaction_date || null,
        person: rec.person || "", reason: rec.reason || rec.remarks || "", rating: parseRating(rec.rating), source: sourceLabel,
      });
      txCreated++;
    }
  });

  // Reconciliation — a declared snapshot NEVER silently overrules real
  // transaction evidence. If no transactions exist at all for a product,
  // seed a single labeled opening-balance ADJUSTMENT from the declared
  // value. If real transactions exist but disagree with the declared
  // value, surface it as a warning and let the transaction-derived value
  // stand — never fabricate an adjustment to force agreement.
  declaredStock.forEach((declared, productId) => {
    const combined = [...existingTransactions, ...newTransactions].filter((t) => t.productId === productId);
    const derived = computeCurrentStock(productId, combined);
    if (derived === null) {
      newTransactions.push({
        id: uid("tx"), productId, vendorName: "", type: "ADJUSTMENT", qty: declared, unitCost: null,
        date: null, person: "Import", reason: `Opening balance — no transaction history available; taken from the source's stated current stock (${declared}) at import.`,
        rating: null, source: sourceLabel,
      });
      txCreated++;
    } else if (derived !== declared) {
      const product = [...productIndex.values()].find((p) => p.id === productId);
      warnings.push(`"${product ? product.name : productId}": source states current stock ${declared}, but the transaction ledger implies ${derived}. NOT auto-adjusted — investigate before trusting either number. Shown stock will be the transaction-derived value (${derived}).`);
    }
  });

  return { products: [...productIndex.values()], transactions: newTransactions,
    stats: { rowsProcessed: rows.length, skippedBlank, skippedNoName, txCreated, productsTouched: productIndex.size }, warnings };
}

// ---------- multi-table detection ----------
// The client's real "HFM Store" tab packs an item-master table and a
// transactions table side by side in different column ranges on the SAME
// rows — they are NOT row-aligned by item. This scans the raw grid (as
// Sheets API values.get returns it) and finds each such block by splitting
// on genuinely blank header cells — no hardcoded row/column numbers, so it
// generalizes beyond this one sheet.
function detectTableBlocks(grid) {
  const blocks = [];
  grid.forEach((row, r) => {
    if (!row) return;
    const runs = [];
    let current = [];
    for (let c = 0; c < row.length; c++) {
      const text = row[c] === null || row[c] === undefined ? "" : String(row[c]).trim();
      if (text) current.push(c); else { if (current.length) runs.push(current); current = []; }
    }
    if (current.length) runs.push(current);
    runs.forEach((cols) => {
      const hits = cols.filter((c) => { const m = mapColumn(row[c]); return m.field && m.confidence >= 55; });
      if (hits.length < 2) return;
      blocks.push(makeBlock(r, cols[0], cols[cols.length - 1]));
    });
  });
  function makeBlock(headerRow, colStart, colEnd) {
    const cols = [];
    for (let c = colStart; c <= colEnd; c++) {
      const headerText = (grid[headerRow][c] || "").toString().trim();
      if (headerText) cols.push({ col: c, header: headerText });
    }
    const rows = [];
    let blankStreak = 0;
    for (let r = headerRow + 1; r < grid.length; r++) {
      const line = grid[r] || [];
      const slice = cols.map((h) => (line[h.col] ?? "").toString().trim());
      if (slice.every((v) => v === "")) { blankStreak++; if (blankStreak >= 3) break; continue; }
      blankStreak = 0;
      const rec = {};
      cols.forEach((h, i) => { rec[h.header] = slice[i]; });
      rows.push(rec);
    }
    const fields = new Set(cols.map((c) => mapColumn(c.header).field).filter(Boolean));
    let guessedType = "Unrecognized — review before importing";
    if (fields.has("current_stock") || fields.has("min_stock")) guessedType = "Item Master (stock snapshot)";
    else if (fields.has("txn_quantity") && (fields.has("vendor") || fields.has("transaction_date") || fields.has("unit_price"))) guessedType = "Transactions (purchase/issue ledger)";
    else if (fields.has("product_name")) guessedType = "Item list — review before importing (may be a demand/request list, not stock)";
    return { headerRow, colStart, colEnd, headers: cols.map((c) => c.header), rows, guessedType, recommendedImport: guessedType.startsWith("Item Master") || guessedType.startsWith("Transactions") };
  }
  return blocks;
}

// ---------- data-quality audit ----------
const GENERIC_NAME_WORDS = new Set(["item", "material", "part", "misc", "other", "spare", "unit", "piece", "sheet", "tape", "connector", "switch", "wire"]);
function runDataQualityAudit(products, transactions) {
  const findings = { duplicateProducts: [], missingBrand: [], missingPrice: [], inconsistentNaming: [], inconsistentUnits: [], missingVendor: [], badQuantities: [], ambiguousSpec: [], suspiciousPrices: [], insufficientHistory: [], dataIntegrity: [] };
  const stockByProduct = new Map(products.map((p) => [p.id, computeCurrentStock(p.id, transactions)]));
  for (let i = 0; i < products.length; i++) for (let j = i + 1; j < products.length; j++) {
    const check = isDuplicateCandidate(products[i], products[j]);
    if (check.dup) findings.duplicateProducts.push({ a: products[i].name, b: products[j].name, similarity: check.similarity });
  }
  const withBrand = products.filter((p) => p.brand && p.brand.trim());
  if (withBrand.length === 0 && products.length > 0) findings.missingBrand.push({ issue: `No brand field present in the source data for any of ${products.length} items — the sheet has no brand column. Brand is left blank rather than guessed.` });
  else products.filter((p) => !p.brand || !p.brand.trim()).forEach((p) => findings.missingBrand.push({ product: p.name }));
  for (let i = 0; i < products.length; i++) for (let j = i + 1; j < products.length; j++) {
    const a = products[i].name, b = products[j].name;
    if (a === b) continue;
    const aNoQuote = a.replace(/["\u201d]/g, "").trim(), bNoQuote = b.replace(/["\u201d]/g, "").trim();
    if (aNoQuote.toLowerCase() === bNoQuote.toLowerCase() && a !== b) findings.inconsistentNaming.push({ a, b, issue: "differ only by a trailing quote/inch mark — likely the same item named inconsistently" });
  }
  const txWithSignal = transactions.filter((t) => t.unitCost !== null || t.qty);
  const missingVendorCount = txWithSignal.filter((t) => !t.vendorName).length;
  if (txWithSignal.length > 0) findings.missingVendor.push({ issue: `${missingVendorCount} of ${txWithSignal.length} transactions have no vendor recorded (${Math.round((missingVendorCount / txWithSignal.length) * 100)}%) — vendor-wise price history and scoring can't be computed for these.` });
  transactions.filter((t) => t.vendorName && looksLikePlaceholderVendor(t.vendorName)).forEach((t) => findings.missingVendor.push({ issue: `Transaction for "${products.find((p) => p.id === t.productId)?.name || t.productId}" has vendor "${t.vendorName}", which looks like placeholder text rather than a verified real vendor.` }));
  transactions.filter((t) => t.unitCost === null).forEach((t) => findings.missingPrice.push({ product: products.find((p) => p.id === t.productId)?.name || t.productId, date: t.date }));
  transactions.filter((t) => t.qty < 0).forEach((t) => findings.badQuantities.push({ product: products.find((p) => p.id === t.productId)?.name, qty: t.qty }));
  products.filter((p) => (stockByProduct.get(p.id) ?? 0) < 0).forEach((p) => findings.badQuantities.push({ product: p.name, current_stock: stockByProduct.get(p.id), issue: "negative current stock — data entry error" }));
  products.forEach((p) => {
    const spec = specTokens(p.name), words = tokenSet(p.name);
    const onlyGeneric = [...words].every((w) => GENERIC_NAME_WORDS.has(w) || w.length <= 2);
    if (spec.size === 0 && (onlyGeneric || words.size <= 2)) findings.ambiguousSpec.push({ product: p.name, issue: "no distinguishing spec (size/rating/model) in the name" });
  });
  const priced = transactions.filter((t) => t.unitCost !== null && t.unitCost > 0);
  if (priced.length >= 5) {
    const vals = priced.map((t) => t.unitCost);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    priced.filter((t) => sd > 0 && Math.abs(t.unitCost - mean) > 3 * sd).forEach((t) => findings.suspiciousPrices.push({ product: products.find((p) => p.id === t.productId)?.name, price: t.unitCost, note: `more than 3 standard deviations from the overall mean unit price (PKR ${Math.round(mean)}) — verify, don't assume either way` }));
  }
  products.forEach((p) => {
    const stats = purchaseHistoryStats(transactions.filter((t) => t.productId === p.id));
    if (!stats) findings.insufficientHistory.push({ product: p.name, issue: "no priced purchase on record" });
    else if (stats.count === 1) findings.insufficientHistory.push({ product: p.name, issue: "only 1 priced purchase on record — not enough for a trend or confident average" });
  });
  products.forEach((p) => {
    const stock = stockByProduct.get(p.id);
    if (p.avg_cost_snapshot > 0 && (stock === 0 || stock === null) && p.source_stock_status && !/out of stock|critical/i.test(p.source_stock_status)) findings.dataIntegrity.push({ product: p.name, issue: `sheet's own status says "${p.source_stock_status}" but computed current stock is ${stock ?? "unknown"} — inconsistent` });
    if (p.min_stock === undefined || p.min_stock === null) findings.dataIntegrity.push({ product: p.name, issue: "minimum stock is blank in the source — reorder recommendations can't be computed" });
  });
  return findings;
}

// GST-aware price comparison — a raw unit-price comparison across vendors
// is misleading when GST terms differ (0% vs 17%); rank on effective,
// tax-inclusive price instead.
function effectiveUnitPrice(q) {
  return (toNumber(q.unitPrice) || 0) * (1 + (toNumber(q.gst) || 0) / 100);
}
function rankQuotations(quotes) {
  const withEff = quotes.map((q) => ({ ...q, effectiveUnitPrice: effectiveUnitPrice(q) }));
  const minEff = Math.min(...withEff.map((q) => q.effectiveUnitPrice));
  return withEff.map((q) => ({ ...q, isBestPrice: q.effectiveUnitPrice === minEff, isOverpriced: q.effectiveUnitPrice > minEff * 1.15 }));
}
function purchaseHistoryStats(transactions) {
  const priced = transactions.filter((t) => t.unitCost !== null && t.unitCost !== undefined && !isNaN(t.unitCost));
  if (!priced.length) return null;
  const prices = priced.map((t) => t.unitCost);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const sorted = [...priced].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return { count: priced.length, avg, min: Math.min(...prices), max: Math.max(...prices), last: sorted[0].unitCost, lastDate: sorted[0].date };
}

// ---------- price benchmarking (deterministic — feeds the auto-agent, no extra AI call) ----------
// Combines whatever historical purchase data and live market-research findings
// exist into one verdict. Never fabricates a number — if either side is
// missing, the verdict says so instead of guessing at a range.
function benchmarkPrice(historyStats, marketFindings) {
  const validFindings = (marketFindings || []).filter((f) => typeof f.price === "number" && f.price > 0);
  const marketPrices = validFindings.map((f) => f.price);
  const marketMin = marketPrices.length ? Math.min(...marketPrices) : null;
  const marketMax = marketPrices.length ? Math.max(...marketPrices) : null;
  const marketAvg = marketPrices.length ? marketPrices.reduce((a, b) => a + b, 0) / marketPrices.length : null;
  if (!historyStats && !marketPrices.length) return { verdict: "INSUFFICIENT DATA", notes: "No purchase history and no usable market evidence — get fresh quotations before any price judgment is possible.", marketMin, marketMax, marketAvg };
  if (historyStats && !marketPrices.length) return { verdict: "HISTORY ONLY", notes: `No reliable market evidence found. Purchase history: average PKR ${Math.round(historyStats.avg)} over ${historyStats.count} purchase(s), last paid PKR ${Math.round(historyStats.last)}.`, marketMin, marketMax, marketAvg };
  if (!historyStats && marketPrices.length) return { verdict: "MARKET ONLY", notes: `No purchase history yet. Market evidence (${marketPrices.length} source(s)) suggests PKR ${Math.round(marketMin)}–${Math.round(marketMax)}.`, marketMin, marketMax, marketAvg };
  const variancePct = ((historyStats.avg - marketAvg) / marketAvg) * 100;
  let verdict = "WITHIN MARKET RANGE";
  if (historyStats.avg > marketMax * 1.1) verdict = "HISTORICALLY OVERPAYING";
  else if (historyStats.avg < marketMin * 0.9) verdict = "HISTORICALLY BELOW MARKET";
  return { verdict, marketMin, marketMax, marketAvg, notes: `Historical average PKR ${Math.round(historyStats.avg)} vs market range PKR ${Math.round(marketMin)}–${Math.round(marketMax)} (${variancePct >= 0 ? "+" : ""}${variancePct.toFixed(1)}% vs market average) from ${marketPrices.length} source(s).` };
}

// ---------- procurement audit: a single quoted line vs history + market ----------
// Never invents a fair price out of thin air: if there's no usable market
// evidence, the verdict is explicitly INSUFFICIENT MARKET EVIDENCE, full
// stop — no fallback number, no guess dressed up as a range.
function auditQuotationLine({ quotedUnitPrice, qty, historyStats, marketFindings }) {
  const qty_ = Number(qty) || 1;
  const validFindings = (marketFindings || []).filter((f) => typeof f.price === "number" && f.price > 0);
  const marketPrices = validFindings.map((f) => f.price);

  if (!marketPrices.length) {
    return {
      verdict: "INSUFFICIENT MARKET EVIDENCE",
      marketMin: null, marketMax: null, marketAvg: null,
      fairMin: null, fairMax: null,
      overpayPerUnitMin: null, overpayPerUnitMax: null, overpayTotalMin: null, overpayTotalMax: null,
      notes: "No reliable market evidence found for this product — cannot judge whether the quoted price is fair.",
    };
  }

  const marketMin = Math.min(...marketPrices);
  const marketMax = Math.max(...marketPrices);
  const marketAvg = marketPrices.reduce((a, b) => a + b, 0) / marketPrices.length;

  const fairMin = historyStats ? Math.min(historyStats.avg, marketMax) : marketMin;
  const fairMax = Math.min(marketMax, Math.round((marketAvg + marketMax) / 2));

  let verdict = "WITHIN MARKET";
  if (quotedUnitPrice > marketMax) verdict = "ABOVE MARKET";
  else if (quotedUnitPrice < marketMin) verdict = "BELOW MARKET — verify authenticity/spec before trusting";

  const overpayPerUnitMax = Math.max(0, quotedUnitPrice - fairMin);
  const overpayPerUnitMin = Math.max(0, quotedUnitPrice - fairMax);
  const overpayTotalMin = overpayPerUnitMin * qty_;
  const overpayTotalMax = overpayPerUnitMax * qty_;

  return {
    verdict, marketMin, marketMax, marketAvg, fairMin, fairMax,
    overpayPerUnitMin, overpayPerUnitMax, overpayTotalMin, overpayTotalMax,
    notes: `Quoted PKR ${Math.round(quotedUnitPrice)} vs market PKR ${Math.round(marketMin)}–${Math.round(marketMax)} (${marketPrices.length} source(s)), estimated fair range PKR ${Math.round(fairMin)}–${Math.round(fairMax)}.`,
  };
}


function fmtPKR(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return "PKR " + Math.round(n).toLocaleString("en-PK");
}

function uid(prefix) { return prefix + "_" + Math.random().toString(36).slice(2, 9); }
function nowISO() { return new Date().toISOString(); }

// ---------- Claude API call (real, live) ----------
// Shared error extraction: never just say "failed (404)" — surface the
// real reason (from our own /api/groq error body) so the person using
// the app, not just a developer with devtools open, can actually see
// what went wrong. Never includes the API key (the server never sends it
// back in any response, error or otherwise).
async function extractErrorMessage(res, fallbackLabel) {
  let msg = `${fallbackLabel} (HTTP ${res.status})`;
  try {
    const body = await res.json();
    if (body?.error) msg = `${fallbackLabel}: ${body.error}`;
  } catch { /* response wasn't JSON — keep the fallback */ }
  return msg;
}

async function callClaude({ system, prompt, useWebSearch = false, maxTokens = 1500, responseSchema = null }) {
  const body = {
    // NOTE: no "model" field here — api/groq.js chooses the correct
    // Groq model server-side based on the request shape (image present?
    // web search requested? schema requested?) since Groq's capabilities
    // are split across models. See that file's chooseGroqModel().
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }
  // Native structured output — the backend applies this via responseSchema
  // response_format on Groq's side (constrained decoding, where confirmed), which
  // guarantees schema-conforming JSON instead of relying on the model to
  // follow a "respond with only JSON" instruction in the prompt. Not used
  // together with useWebSearch — see api/groq.js for why.
  if (responseSchema && !useWebSearch) {
    body.responseSchema = responseSchema;
  }
  const res = await fetch("/api/groq", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res, "AI request failed"));
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const citations = [];
  (data.content || []).forEach((b) => {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      b.content.forEach((r) => { if (r.url) citations.push({ url: r.url, title: r.title }); });
    }
  });
  return { text, citations, raw: data };
}

function extractJSON(text) {
  const cleaned = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[") === -1 ? cleaned.indexOf("{") : Math.min(...[cleaned.indexOf("["), cleaned.indexOf("{")].filter((i) => i !== -1));
  const lastArr = cleaned.lastIndexOf("]");
  const lastObj = cleaned.lastIndexOf("}");
  const end = Math.max(lastArr, lastObj);
  if (start === -1 || end === -1) {
    // Show what the AI actually said instead of a blank "no JSON" message —
    // this is almost always either a quota/rate-limit message or a safety
    // refusal, and the person needs to see which.
    const snippet = cleaned.slice(0, 200) || "(empty response)";
    throw new Error(`AI response wasn't valid JSON. It said: "${snippet}${cleaned.length > 200 ? "…" : ""}"`);
  }
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (firstErr) {
    // Retry once with control characters inside strings repaired — handles
    // the common "AI put a raw newline/tab inside a text field instead of
    // escaping it" case (a genuinely different bug from truncation) without
    // a second network call.
    try {
      return JSON.parse(sanitizeJSONControlChars(slice));
    } catch (e) {
      throw new Error(`AI response looked like JSON but failed to parse (${firstErr.message}). Raw: "${cleaned.slice(0, 200)}${cleaned.length > 200 ? "…" : ""}"`);
    }
  }
}

// Escapes raw control characters (literal newlines, tabs, etc.) found
// INSIDE a JSON string literal, without touching whitespace between
// structural tokens (which is normal in pretty-printed JSON).
function sanitizeJSONControlChars(s) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (code < 0x20) {
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') { inString = true; out += ch; continue; }
      out += ch;
    }
  }
  return out;
}

// ---------- Structured-output schemas (standard JSON Schema) ----------
// One schema per JSON shape this app actually asks the AI to return.
// Used via api/groq.js's response_format (OpenAI-compatible Groq
// structured output) for every call except the one that needs web
// search (Market Research), which api/groq.js deliberately excludes from
// schema mode to avoid an unconfirmed schema+grounding combo on
// groq/compound's automatic tool use. See that file for the full explanation.
const SCHEMA_VISION_IDENTIFY = {
  type: "object",
  properties: {
    identified: { type: "boolean" },
    confidence: { type: "integer" },
    catalogMatch: { type: ["string", "null"] },
    brand: { type: "string" },
    model: { type: "string" },
    specification: { type: "string" },
    notes: { type: "string" },
    clarificationNeeded: { type: "string" },
  },
  required: ["identified"],
};

const SCHEMA_PHOTO_CANDIDATES = {
  type: "object",
  properties: {
    identified: { type: "boolean" },
    clarificationNeeded: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          brand: { type: "string" },
          model: { type: "string" },
          specification: { type: "string" },
          partNumber: { type: "string" },
          unit: { type: "string" },
          confidence: { type: "integer" },
          catalogMatch: { type: ["string", "null"] },
        },
        required: ["label", "confidence"],
      },
    },
  },
  required: ["identified", "candidates"],
};

const SCHEMA_QUOTATION_EXTRACTION = {
  type: "object",
  properties: {
    vendor: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          product: { type: "string" },
          brand: { type: "string" },
          model: { type: "string" },
          specification: { type: "string" },
          qty: { type: ["number", "null"] },
          vendor: { type: "string" },
          unitPrice: { type: ["number", "null"] },
          tax: { type: ["number", "null"] },
          total: { type: ["number", "null"] },
          date: { type: ["string", "null"] },
        },
        required: ["product"],
      },
    },
  },
  required: ["lines"],
};

const SCHEMA_RECHECK_VERDICT = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["confirm recommendation", "flag concern"] },
    confidence: { type: "integer" },
    notes: { type: "string" },
  },
  required: ["verdict", "confidence", "notes"],
};

const SCHEMA_VOICE_REQUEST = {
  type: "object",
  properties: {
    catalogMatch: { type: ["string", "null"] },
    description: { type: "string" },
    quantity: { type: ["number", "null"] },
  },
  required: ["description"],
};

// ---------- Demo seed data (clearly labeled) ----------
const CATEGORIES = ["Electrical", "HVAC", "Plumbing", "Hardware", "Safety", "Tools"];
const BRANDS = { Electrical: ["Schneider", "Chint", "Siemens", "ABB", "Legrand"], HVAC: ["Gree", "Daikin", "PEL", "Danfoss"], Plumbing: ["Pak Pipes", "Master", "Sonex"], Hardware: ["Local", "Beta", "Stanley"], Safety: ["3M", "Honeywell", "Local"], Tools: ["Bosch", "Makita", "Stanley"] };
const CITIES = ["Karachi", "Lahore", "Karachi", "Karachi", "Islamabad"];

// ---------- Initial dataset: the REAL HFM Store data (not synthetic) ----------
// Transcribed verbatim from the user's actual Google Sheet ("HFM Store" tab),
// fetched read-only for inspection. Run through the same tested
// detectTableBlocks + buildImportPlan pipeline used for live imports —
// transactions block first, then item-master block second, so a stale
// master snapshot never silently overrules real transaction evidence.
function colIdx(letter) { return letter.charCodeAt(0) - 65; }
function gridRow(cells) {
  const arr = [];
  Object.entries(cells).forEach(([letter, val]) => { arr[colIdx(letter)] = val; });
  for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = "";
  return arr;
}
function realHFMGrid() {
  const grid = [];
  grid[9] = gridRow({ B: "Item", C: "Min Stock", D: "Total In", E: "Total Out", F: "Current Stock", G: "Status", H: "Avg Unit Cost", I: "Total Value", K: "Date", L: "Type", M: "Item", N: "Qty", O: "Person", P: "Reason", Q: "Unit Cost", R: "Total Cost", S: "Vendor", T: "Rating" });
  grid[10] = gridRow({ B: "Ceiling Light 6500K 6", C: "5", D: "49", E: "20", F: "29", G: "In Stock", H: "PKR 910.00", I: "PKR 26,390.00", K: "2026-08-03", L: "IN", M: "Ceiling Light 6500K 6", N: "49", O: "Procurement", Q: "PKR 910.00", R: "PKR 44,590.00", S: "Vendor A", T: "⭐⭐⭐⭐⭐" });
  grid[11] = gridRow({ B: "Ceiling Light 4000K 6\"", C: "5", D: "0", E: "0", F: "0", G: "Out of Stock", H: "PKR 910.00", I: "PKR 0.00", K: "2026-08-03", L: "IN", M: "Open Light 6500K 6\"", N: "6", Q: "PKR 720.00", R: "PKR 4,320.00" });
  grid[12] = gridRow({ B: "Open Light 6500K 6\"", C: "5", D: "6", E: "0", F: "6", G: "In Stock", H: "PKR 720.00", I: "PKR 4,320.00", K: "2026-08-03", L: "IN", M: "Open Light 6500K 8\"", N: "10", Q: "PKR 940.00", R: "PKR 9,400.00" });
  grid[13] = gridRow({ B: "Open Light 4000K 6", C: "5", D: "0", E: "0", F: "0", G: "Out of Stock", H: "PKR 720.00", I: "PKR 0.00", K: "2026-08-03", L: "IN", M: "12W Energy Saver 6500K", N: "15", Q: "PKR 410.00", R: "PKR 6,150.00" });
  grid[14] = gridRow({ B: "Open Light 4000K 8\"", C: "5", D: "0", E: "0", F: "0", G: "Out of Stock", H: "PKR 940.00", I: "PKR 0.00", K: "2026-08-03", L: "IN", M: "12W Energy Saver 4000K", N: "7", Q: "PKR 410.00", R: "PKR 2,870.00" });
  grid[15] = gridRow({ B: "Open Light 6500K 8\"", C: "5", D: "10", E: "0", F: "10", G: "In Stock", H: "PKR 940.00", I: "PKR 9,400.00", K: "2026-08-03", L: "IN", M: "50W Energy Saver 6500K", N: "4", Q: "PKR 1,230.00", R: "PKR 4,920.00" });
  grid[16] = gridRow({ B: "12W Energy Saver 6500K", C: "5", D: "15", E: "0", F: "15", G: "In Stock", H: "PKR 410.00", I: "PKR 6,150.00", K: "2026-08-03", L: "IN", M: "50W Energy Saver 4000K", N: "29", Q: "PKR 1,230.00", R: "PKR 35,670.00" });
  grid[17] = gridRow({ B: "12W Energy Saver 4000K", C: "5", D: "7", E: "0", F: "7", G: "In Stock", H: "PKR 410.00", I: "PKR 2,870.00", K: "2026-08-03", L: "IN", M: "Electrical Tape", N: "3", Q: "PKR 140.00", R: "PKR 420.00" });
  grid[18] = gridRow({ B: "50W Energy Saver 6500K", C: "5", D: "4", E: "0", F: "4", G: "Low Stock", H: "PKR 1,230.00", I: "PKR 4,920.00", K: "2026-08-03", L: "IN", M: "Adamjee Screw", N: "4", Q: "PKR 295.00", R: "PKR 1,180.00" });
  grid[19] = gridRow({ B: "50W Energy Saver 4000K", C: "5", D: "29", E: "0", F: "29", G: "In Stock", H: "PKR 1,230.00", I: "PKR 35,670.00", K: "2026-08-03", L: "IN", M: "JMSA 20GM", N: "2", Q: "PKR 205.00", R: "PKR 410.00" });
  grid[20] = gridRow({ B: "Electrical Tape", C: "5", D: "3", E: "0", F: "3", G: "Low Stock", H: "PKR 140.00", I: "PKR 420.00", K: "2026-08-03", L: "IN", M: "WD-40 100ML", N: "2", Q: "PKR 720.00", R: "PKR 1,440.00" });
  grid[21] = gridRow({ B: "Adamjee Screw", C: "5", D: "4", E: "0", F: "4", G: "Low Stock", H: "PKR 295.00", I: "PKR 1,180.00", K: "2026-08-03", L: "IN", M: "Small Silicone", N: "5", Q: "PKR 350.00", R: "PKR 1,750.00" });
  grid[22] = gridRow({ B: "JMSA 20GM", C: "5", D: "2", E: "0", F: "2", G: "Low Stock", H: "PKR 205.00", I: "PKR 410.00", K: "2026-08-03", L: "IN", M: "Multi Sheet", N: "8", Q: "PKR 205.00", R: "PKR 1,640.00" });
  grid[23] = gridRow({ B: "WD-40 100ML", C: "5", D: "2", E: "0", F: "2", G: "Low Stock", H: "PKR 720.00", I: "PKR 1,440.00", K: "2026-08-03", L: "IN", M: "Connector Strip 15AMP", N: "8", Q: "PKR 205.00", R: "PKR 1,640.00" });
  grid[24] = gridRow({ B: "Small Silicone", C: "5", D: "5", E: "1", F: "4", G: "Low Stock", H: "PKR 350.00", I: "PKR 1,400.00", K: "2026-08-03", L: "IN", M: "Male & Female Connector", N: "30", Q: "PKR 185.00", R: "PKR 5,550.00" });
  grid[25] = gridRow({ B: "Multi Sheet", C: "5", D: "8", E: "0", F: "8", G: "In Stock", H: "PKR 205.00", I: "PKR 1,640.00", K: "2026-08-03", L: "IN", M: "Knife Cutter", N: "1", Q: "PKR 760.00", R: "PKR 760.00" });
  grid[26] = gridRow({ B: "Connector Strip 15AMP", C: "5", D: "8", E: "0", F: "8", G: "In Stock", H: "PKR 205.00", I: "PKR 1,640.00", K: "2026-08-03", L: "IN", M: "7W Edeluxe LED 3\"", N: "21", Q: "PKR 495.00", R: "PKR 10,395.00" });
  grid[27] = gridRow({ B: "Male & Female Connector", C: "5", D: "30", E: "0", F: "30", G: "In Stock", H: "PKR 185.00", I: "PKR 5,550.00", K: "2026-08-03", L: "IN", M: "Capsule Light", N: "10", Q: "PKR 495.00", R: "PKR 4,950.00" });
  grid[28] = gridRow({ B: "Knife Cutter", C: "5", D: "1", E: "0", F: "1", G: "Low Stock", H: "PKR 760.00", I: "PKR 760.00", K: "2026-08-03", L: "IN", M: "Open Board 2X2", N: "50", Q: "PKR 155.00", R: "PKR 7,750.00" });
  grid[29] = gridRow({ B: "7W Edeluxe LED 3\"", C: "5", D: "21", E: "0", F: "21", G: "In Stock", H: "PKR 495.00", I: "PKR 10,395.00", K: "2026-08-03", L: "IN", M: "Changeover Switch 200AMP", N: "1", Q: "PKR 7,200.00", R: "PKR 7,200.00" });
  grid[30] = gridRow({ B: "Capsule Light", C: "5", D: "10", E: "0", F: "10", G: "In Stock", H: "PKR 495.00", I: "PKR 4,950.00", K: "2026-08-03", L: "IN", M: "Commode Connection Pipe", N: "20", Q: "PKR 1,650.00", R: "PKR 33,000.00" });
  grid[31] = gridRow({ B: "Open Board 2X2", C: "5", D: "50", E: "0", F: "50", G: "In Stock", H: "PKR 155.00", I: "PKR 7,750.00", K: "2026-08-03", L: "IN", M: "Muslim Shower With out Pipe", N: "17", Q: "PKR 1,050.00", R: "PKR 17,850.00" });
  grid[32] = gridRow({ B: "Changeover Switch 200AMP", C: "5", D: "1", E: "0", F: "1", G: "Low Stock", H: "PKR 7,200.00", I: "PKR 7,200.00", K: "2026-08-03", L: "IN", M: "Soap Dispenser", N: "8", Q: "PKR 1,210.00", R: "PKR 9,680.00" });
  grid[33] = gridRow({ B: "Commode Connection Pipe", C: "5", D: "20", E: "0", F: "20", G: "In Stock", H: "PKR 1,650.00", I: "PKR 33,000.00", K: "2026-08-03", L: "IN", M: "Hydraulic Hinge", N: "12", Q: "PKR 910.00", R: "PKR 10,920.00" });
  grid[34] = gridRow({ B: "Muslim Shower With out Pipe", C: "5", D: "17", E: "0", F: "17", G: "In Stock", H: "PKR 1,050.00", I: "PKR 17,850.00", K: "2026-08-03", L: "IN", M: "Wall-Mounted Fan", N: "1", Q: "PKR 12,300.00", R: "PKR 12,300.00" });
  grid[35] = gridRow({ B: "Soap Dispenser", C: "5", D: "8", E: "0", F: "8", G: "In Stock", H: "PKR 1,210.00", I: "PKR 9,680.00", K: "2026-08-03", L: "IN", M: "Changeover Switch 50A", N: "2", Q: "PKR 3,750.00", R: "PKR 7,500.00" });
  grid[36] = gridRow({ B: "Hydraulic Hinge", C: "5", D: "12", E: "0", F: "12", G: "In Stock", H: "PKR 910.00", I: "PKR 10,920.00", K: "2026-08-03", L: "IN", M: "Master Tap uncompleted", N: "6", Q: "PKR 2,100.00", R: "PKR 12,600.00" });
  grid[37] = gridRow({ B: "Wall-Mounted Fan", C: "5", D: "1", E: "0", F: "1", G: "Low Stock", H: "PKR 12,300.00", I: "PKR 12,300.00", K: "2026-08-03", L: "IN", M: "Dai Open Light 4K 8\"", N: "12", Q: "PKR 960.00", R: "PKR 11,520.00" });
  grid[38] = gridRow({ B: "Changeover Switch 50A", C: "5", D: "2", E: "0", F: "2", G: "Low Stock", H: "PKR 3,750.00", I: "PKR 7,500.00", K: "2026-08-03", L: "IN", M: "SE Open Light 65K 6\"", N: "25", Q: "PKR 800.00", R: "PKR 20,000.00" });
  grid[39] = gridRow({ B: "Master Tap uncompleted", C: "5", D: "6", E: "0", F: "6", G: "In Stock", H: "PKR 2,100.00", I: "PKR 12,600.00", K: "2026-08-03", L: "IN", M: "Dai Open Light 4K 6\"", N: "13", Q: "PKR 800.00", R: "PKR 10,400.00" });
  grid[40] = gridRow({ B: "Dai Open Light 4K 8\"", C: "5", D: "12", E: "0", F: "12", G: "In Stock", H: "PKR 960.00", I: "PKR 11,520.00", K: "2026-08-03", L: "IN", M: "Flexible Wire, 2 Core, 40/76 Used Coil", N: "1", Q: "PKR 9,800.00", R: "PKR 9,800.00" });
  grid[41] = gridRow({ B: "SE Open Light 65K 6\"", C: "5", D: "25", E: "0", F: "25", G: "In Stock", H: "PKR 800.00", I: "PKR 20,000.00", K: "2026-08-03", L: "IN", M: "10mm Standard Wire 25 Meter", N: "1", Q: "PKR 10,700.00", R: "PKR 10,700.00" });
  grid[42] = gridRow({ B: "Dai Open Light 4K 6\"", C: "5", D: "13", E: "0", F: "13", G: "In Stock", H: "PKR 800.00", I: "PKR 10,400.00", K: "2026-08-03", L: "IN", M: "Volden Fresh Air Tin-One Motor", N: "7", Q: "PKR 6,300.00", R: "PKR 44,100.00" });
  grid[43] = gridRow({ B: "Flexible Wire, 2 Core, 40/76 Used Coil", C: "5", D: "1", E: "0", F: "1", G: "Low Stock", H: "PKR 9,800.00", I: "PKR 9,800.00", K: "2026-08-03", L: "IN", M: "WD-40 330L", N: "2", Q: "PKR 1,820.00", R: "PKR 3,640.00" });
  grid[44] = gridRow({ B: "10mm Standard Wire 25 Meter", C: "5", D: "1", E: "0", F: "1", G: "Low Stock", H: "PKR 10,700.00", I: "PKR 10,700.00", K: "2026-08-03", L: "IN", M: "Peark Ceiling 4000K", N: "6", Q: "PKR 940.00", R: "PKR 5,640.00" });
  grid[45] = gridRow({ B: "Volden Fresh Air Tin-One Motor", C: "5", D: "7", E: "0", F: "7", G: "In Stock", H: "PKR 6,300.00", I: "PKR 44,100.00", K: "2026-08-03", L: "IN", M: "FUJI Capacitor 3.5", N: "10", Q: "PKR 210.00", R: "PKR 2,100.00" });
  grid[46] = gridRow({ B: "WD-40 330L", C: "5", D: "2", E: "0", F: "2", G: "Low Stock", H: "PKR 1,820.00", I: "PKR 3,640.00", K: "2026-08-03", L: "IN", M: "Connector Strip 60AMp", N: "20", Q: "PKR 900.00", R: "PKR 18,000.00" });
  grid[47] = gridRow({ B: "Peark Ceiling 4000K", C: "5", D: "6", E: "0", F: "6", G: "In Stock", H: "PKR 940.00", I: "PKR 5,640.00", K: "2026-08-03", L: "IN", M: "Stair Step Light", N: "1", Q: "PKR 640.00", R: "PKR 640.00" });
  grid[48] = gridRow({ B: "FUJI Capacitor 3.5", C: "5", D: "10", E: "0", F: "10", G: "In Stock", H: "PKR 210.00", I: "PKR 2,100.00", K: "2026-08-03", L: "IN", M: "Aiwa Ceiling Light 6000K 6\"", N: "4", Q: "PKR 1,090.00", R: "PKR 4,360.00" });
  grid[49] = gridRow({ B: "Connector Strip 60AMp", C: "5", D: "20", E: "0", F: "20", G: "In Stock", H: "PKR 900.00", I: "PKR 18,000.00", K: "2026-08-03", L: "IN", M: "Hygiene Tissue Dispenser", N: "9", Q: "PKR 1,290.00", R: "PKR 11,610.00" });
  grid[50] = gridRow({ B: "Stair Step Light", C: "5", D: "1", E: "0", F: "1", G: "Low Stock", H: "PKR 640.00", I: "PKR 640.00", K: "2026-08-03", L: "IN", M: "Disposable Cup Dispenser", N: "2", Q: "PKR 1,410.00", R: "PKR 2,820.00" });
  grid[51] = gridRow({ B: "Aiwa Ceiling Light 6000K 6\"", C: "5", D: "4", E: "0", F: "4", G: "Low Stock", H: "PKR 1,090.00", I: "PKR 4,360.00", K: "2026-08-03", L: "IN", M: "Muslim Shower Master With Pipe", N: "6", Q: "PKR 2,850.00", R: "PKR 17,100.00" });
  grid[52] = gridRow({ B: "Hygiene Tissue Dispenser", C: "5", D: "9", E: "2", F: "7", G: "In Stock", H: "PKR 1,290.00", I: "PKR 9,030.00", K: "2026-08-03", L: "IN", M: "Wash Basin Connection Pipe", N: "10", Q: "PKR 1,010.00", R: "PKR 10,100.00" });
  grid[53] = gridRow({ B: "Disposable Cup Dispenser", C: "5", D: "2", E: "0", F: "2", G: "Low Stock", H: "PKR 1,410.00", I: "PKR 2,820.00", K: "2026-08-03", L: "IN", M: "Muslim Shower Silver Color With 2 Chain", N: "2", O: "Procurement", Q: "PKR 2,950.00", R: "PKR 5,900.00" });
  grid[54] = gridRow({ B: "Muslim Shower Master With Pipe", C: "5", D: "6", E: "0", F: "6", G: "In Stock", H: "PKR 2,850.00", I: "PKR 17,100.00", K: "2026-08-07", L: "OUT", M: "Ceiling Light 6500K 6", N: "20", O: "140-H & 141-D", Q: "PKR 910.00", R: "PKR 18,200.00" });
  grid[55] = gridRow({ B: "Wash Basin Connection Pipe", C: "5", D: "10", E: "0", F: "10", G: "In Stock", H: "PKR 1,010.00", I: "PKR 10,100.00", K: "2026-08-07", L: "OUT", M: "Open Light 6500K 6\"", N: "4", O: "140-H Cafe", Q: "PKR 720.00", R: "PKR 2,880.00" });
  grid[56] = gridRow({ B: "Muslim Shower Silver Color With 2 Chain", C: "5", D: "2", E: "0", F: "2", G: "Low Stock", H: "PKR 2,950.00", I: "PKR 5,900.00", K: "2026-08-10", L: "OUT", M: "Hygiene Tissue Dispenser", N: "1", O: "140-H Cafe", P: "broken", Q: "PKR 1,290.00", R: "PKR 1,290.00", S: "Replaced in house" });
  grid[57] = gridRow({ B: "Extension Board - Camelion", G: "In Stock", H: "PKR 3,600.00", I: "PKR 0.00", K: "2026-08-15", L: "OUT", M: "Hygiene Tissue Dispenser", N: "1", O: "140-H male restroom", Q: "PKR 1,290.00", R: "PKR 1,290.00" });
  grid[58] = gridRow({ K: "2026-08-17", L: "OUT", M: "Small Silicone", N: "1", O: "Gym pupose (Morning shift)", Q: "PKR 350.00", R: "PKR 350.00" });
  grid[59] = gridRow({ L: "IN" });
  return grid;
}

function seedDemoData() {
  const grid = realHFMGrid();
  const blocks = detectTableBlocks(grid);
  const txBlock = blocks.find((b) => b.guessedType.startsWith("Transactions"));
  const masterBlock = blocks.find((b) => b.guessedType.startsWith("Item Master"));
  const txMapping = {}; txBlock.headers.forEach((h) => { txMapping[h] = mapColumn(h); });
  const masterMapping = {}; masterBlock.headers.forEach((h) => { masterMapping[h] = mapColumn(h); });

  // transactions block first (real dated movements), item-master block
  // second (fills gaps only, never overrules real transaction evidence) —
  // the same tested order used for every Sheets import in this app.
  const planTx = buildImportPlan(txBlock.headers, txBlock.rows, txMapping, [], [], "HFM Store (initial real data)");
  const planMaster = buildImportPlan(masterBlock.headers, masterBlock.rows, masterMapping, planTx.products, planTx.transactions, "HFM Store (initial real data)");
  const products = planMaster.products;
  const transactions = [...planTx.transactions, ...planMaster.transactions];

  const vendors = ["Al-Karam Electricals", "ABC Electrical Traders", "Karachi HVAC Supplies", "National Hardware Store", "Zaman Safety Equipment", "Speed Tools Co.", "Metro Electric & Cable House"].map((name, i) => ({
    id: uid("vend"), name, city: CITIES[i % CITIES.length], categories: [CATEGORIES[i % CATEGORIES.length]],
    reliability: 60 + Math.round(Math.random() * 35), delivery: 60 + Math.round(Math.random() * 35),
    quality: 60 + Math.round(Math.random() * 35), priceCompetitiveness: 55 + Math.round(Math.random() * 40),
    verification: i % 3 === 0 ? "VERIFIED" : i % 3 === 1 ? "PARTIALLY VERIFIED" : "NEW",
    source: "DEMO VENDOR — real store data has almost no vendor history yet",
  }));

  return { products, vendors, transactions, rfqs: [], quotations: [], auditLog: [
    { id: uid("aud"), ts: nowISO(), actor: "System", action: "SEED", detail: `Loaded real HFM Store data: ${products.length} products, ${transactions.length} transactions. ${planMaster.warnings.length} reconciliation warnings (master snapshot vs ledger).` }
  ], sheetsConfig: {
    spreadsheetId: "1ZfQherwjylV302cTWyiS8_TsAZMKzwKei8JxjsonK-A", tabName: "HFM Store", apiKey: "",
    lastSyncedAt: null, syncStatus: "never", recordsImported: null, lastError: null,
  } };
}

// ---------- storage ----------
const STORAGE_KEY = "disrupt-procure-state-v1";
async function loadState() {
  try {
    const r = await window.storage.get(STORAGE_KEY);
    return r ? JSON.parse(r.value) : null;
  } catch { return null; }
}
async function saveState(state) {
  try { await window.storage.set(STORAGE_KEY, JSON.stringify(state)); } catch (e) { console.error("storage save failed", e); }
}

// ============================================================
// UI PRIMITIVES
// ============================================================
const Badge = ({ children, tone = "default" }) => {
  const tones = {
    default: "bg-[var(--panel2)] text-[var(--muted)] border-[var(--border)]",
    critical: "bg-[#3A1518] text-[#FF8087] border-[#5A2226]",
    low: "bg-[#3A2A12] text-[#F0A83A] border-[#5A4018]",
    healthy: "bg-[#0F2F24] text-[#3DD68C] border-[#1A4A38]",
    info: "bg-[var(--cyan-dim)] text-[var(--cyan)] border-[#2A5A56]",
    dead: "bg-[#26232B] text-[#B79AFF] border-[#3A3345]",
  };
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border px-font-mono ${tones[tone] || tones.default}`}>{children}</span>;
};

const stateTone = (s) => ({ CRITICAL: "critical", LOW: "low", "REORDER SOON": "low", HEALTHY: "healthy", OVERSTOCK: "info", "DEAD STOCK": "dead", "DATA ERROR": "critical", UNKNOWN: "default" }[s] || "default");

const Card = ({ children, className = "" }) => (
  <div className={`bg-[var(--panel)] border border-[var(--border)] rounded-xl ${className}`}>{children}</div>
);

const StatCard = ({ label, value, sub, tone }) => (
  <Card className="p-4">
    <div className="text-[11px] text-[var(--muted)] px-font-mono uppercase tracking-wide">{label}</div>
    <div className={`text-2xl font-semibold px-font-display mt-1 ${tone === "danger" ? "text-[var(--danger)]" : tone === "amber" ? "text-[var(--amber)]" : "text-[var(--text)]"}`}>{value}</div>
    {sub && <div className="text-xs text-[var(--muted)] mt-1">{sub}</div>}
  </Card>
);

const ConfidenceGauge = ({ value = 0, size = 44 }) => {
  const r = (size - 6) / 2, c = 2 * Math.PI * r;
  const off = c - (Math.min(100, Math.max(0, value)) / 100) * c;
  const color = value >= 80 ? "#3DD68C" : value >= 50 ? "#F0A83A" : "#E5484D";
  return (
    <svg width={size} height={size} className="shrink-0">
      <circle cx={size/2} cy={size/2} r={r} stroke="#2B3140" strokeWidth="4" fill="none" />
      <circle className="px-gauge-ring" cx={size/2} cy={size/2} r={r} stroke={color} strokeWidth="4" fill="none"
        strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`} />
      <text x="50%" y="50%" textAnchor="middle" dy="4" fontSize="11" fill={color} className="px-font-mono">{value}%</text>
    </svg>
  );
};

const Btn = ({ children, onClick, variant = "default", disabled, className = "" }) => {
  const variants = {
    default: "bg-[var(--panel2)] border border-[var(--border)] text-[var(--text)] hover:border-[var(--amber-dim)]",
    primary: "bg-[var(--amber)] text-[#1A1300] font-semibold hover:brightness-110",
    danger: "bg-transparent border border-[#5A2226] text-[var(--danger)] hover:bg-[#2A1416]",
    ghost: "bg-transparent text-[var(--muted)] hover:text-[var(--text)]",
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`px-3.5 py-1.5 rounded-lg text-sm transition disabled:opacity-40 disabled:cursor-not-allowed ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
};

// ============================================================
// IMPORT CENTER
// ============================================================
function ImportCenter({ state, setState, pushAudit }) {
  const [workbook, setWorkbook] = useState(null); // { sheetNames, sheets: {name: rows} } for XLSX
  const [sheetName, setSheetName] = useState(null);
  const [rawRows, setRawRows] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [mapping, setMapping] = useState({});
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [lastResult, setLastResult] = useState(null);
  const fileRef = useRef();

  const loadSheet = (hdrs, rows) => { setHeaders(hdrs); setRawRows(rows); autoMap(hdrs); };

  const handleFile = (file) => {
    setError(""); setFileName(file.name); setLastResult(null); setWorkbook(null);
    const isCSV = /\.csv$/i.test(file.name);
    if (isCSV) {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (res) => {
          if (!res.data.length) { setError("The file has no readable rows."); return; }
          loadSheet(res.meta.fields || [], res.data);
        },
        error: (err) => setError("Could not parse CSV: " + err.message),
      });
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const sheets = {};
          wb.SheetNames.forEach((name) => {
            const json = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
            if (json.length) sheets[name] = json;
          });
          const usable = Object.keys(sheets);
          if (!usable.length) { setError("No non-empty sheets found in this workbook."); return; }
          setWorkbook({ sheetNames: usable, sheets });
          const first = usable[0];
          setSheetName(first);
          loadSheet(Object.keys(sheets[first][0]), sheets[first]);
        } catch (err) { setError("Could not read this workbook: " + err.message); }
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const switchSheet = (name) => {
    if (!workbook) return;
    setSheetName(name);
    const rows = workbook.sheets[name];
    loadSheet(Object.keys(rows[0]), rows);
  };

  const autoMap = (hdrs) => {
    const m = {};
    hdrs.forEach((h) => { m[h] = mapColumn(h); });
    setMapping(m);
  };

  const collisions = useMemo(() => findMappingCollisions(headers, mapping), [headers, mapping]);

  const confirmImport = () => {
    if (!rawRows) return;
    const plan = buildImportPlan(headers, rawRows, mapping, state.products, state.transactions, fileName + (sheetName ? ` (${sheetName})` : ""));
    const newProductCount = plan.products.length - state.products.length;
    setState((s) => ({ ...s, products: plan.products, transactions: [...s.transactions, ...plan.transactions] }));
    setLastResult(plan);
    pushAudit("Import", `Imported "${fileName}"${sheetName ? " / " + sheetName : ""}: ${plan.stats.rowsProcessed} rows → ${newProductCount >= 0 ? newProductCount : 0} new products, ${plan.stats.txCreated} transactions logged (${plan.stats.skippedBlank} blank rows skipped, ${plan.stats.skippedNoName} rows skipped for missing product name).`);
    setRawRows(null); setHeaders([]); setMapping({}); setWorkbook(null); setSheetName(null);
  };

  const criticalUnmapped = !Object.values(mapping).some((m) => m.field === "product_name");

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h2 className="px-font-display text-lg font-semibold">Import Center</h2>
        <p className="text-sm text-[var(--muted)] mt-1 max-w-2xl">
          Upload your HFM store sheet (Excel or CSV). Columns are matched to DISRUPT PROCURE AI's schema automatically
          with a confidence score — nothing is imported until you confirm the mapping. Financial fields are
          never guessed silently, and re-importing the same sheet updates existing items instead of duplicating them.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
            onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
          <Btn variant="primary" onClick={() => fileRef.current.click()}>Upload spreadsheet</Btn>
          {fileName && <span className="text-xs text-[var(--muted)] px-font-mono">{fileName}</span>}
        </div>
        {error && <div className="mt-3 text-sm text-[var(--danger)]">⚠ {error}</div>}
      </Card>

      {lastResult && (
        <Card className="p-4 border-[var(--cyan-dim)]">
          <div className="text-sm font-medium text-[var(--cyan)]">Import complete</div>
          <div className="text-xs text-[var(--muted)] mt-1">{lastResult.stats.rowsProcessed} rows processed · {lastResult.stats.txCreated} transactions logged · {lastResult.stats.skippedBlank} blank rows skipped · {lastResult.stats.skippedNoName} rows skipped (no product name)</div>
          {lastResult.warnings.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-[var(--amber)] cursor-pointer">{lastResult.warnings.length} data-quality warnings — click to review</summary>
              <div className="mt-2 space-y-1 max-h-40 overflow-y-auto px-scroll">
                {lastResult.warnings.slice(0, 50).map((w, i) => <div key={i} className="text-[11px] px-font-mono text-[var(--muted)]">{w}</div>)}
              </div>
            </details>
          )}
        </Card>
      )}

      {workbook && workbook.sheetNames.length > 1 && (
        <Card className="p-4">
          <div className="text-xs text-[var(--muted)] mb-2">This workbook has {workbook.sheetNames.length} sheets — pick which one to import (e.g. an item-master tab vs a transactions tab):</div>
          <div className="flex flex-wrap gap-2">
            {workbook.sheetNames.map((name) => (
              <button key={name} onClick={() => switchSheet(name)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${name === sheetName ? "border-[var(--amber-dim)] text-[var(--amber)] bg-[var(--panel2)]" : "border-[var(--border)] text-[var(--muted)]"}`}>
                {name}
              </button>
            ))}
          </div>
        </Card>
      )}

      {rawRows && (
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="px-font-display font-semibold">Column mapping preview{sheetName ? ` — ${sheetName}` : ""}</h3>
            <span className="text-xs text-[var(--muted)] px-font-mono">{rawRows.length} rows detected</span>
          </div>
          {collisions.length > 0 && (
            <div className="mb-3 text-xs text-[var(--danger)] bg-[#2A1416] border border-[#5A2226] rounded-lg p-3">
              ⚠ Multiple columns map to the same field — only the last one will be kept for each row:
              {collisions.map(([field, hs]) => <div key={field} className="mt-1 px-font-mono">{field}: {hs.join(", ")}</div>)}
              Set the ones you don't want to "— ignore this column —" below.
            </div>
          )}
          <div className="space-y-2">
            {headers.map((h) => {
              const m = mapping[h] || { field: null, confidence: 0 };
              const isCollision = collisions.some(([, hs]) => hs.includes(h));
              return (
                <div key={h} className={`flex items-center gap-3 bg-[var(--panel2)] border rounded-lg px-3 py-2 ${isCollision ? "border-[#5A2226]" : "border-[var(--border)]"}`}>
                  <span className="px-font-mono text-sm w-40 truncate text-[var(--text)]">{h}</span>
                  <span className="text-[var(--muted)]">→</span>
                  <select value={m.field || ""} onChange={(e) => setMapping((mp) => ({ ...mp, [h]: { field: e.target.value || null, confidence: e.target.value ? (m.field === e.target.value ? m.confidence : 60) : 0 } }))}
                    className="bg-[var(--void)] border border-[var(--border)] rounded px-2 py-1 text-sm flex-1">
                    <option value="">— ignore this column —</option>
                    {Object.keys(SCHEMA_SYNONYMS).map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  {m.field && <Badge tone={m.confidence >= 80 ? "healthy" : m.confidence >= 50 ? "low" : "critical"}>{m.confidence}%</Badge>}
                </div>
              );
            })}
          </div>
          {criticalUnmapped && (
            <div className="mt-3 text-sm text-[var(--danger)]">⚠ "product_name" is not mapped — required to import.</div>
          )}
          <div className="mt-5 flex gap-3">
            <Btn variant="primary" disabled={criticalUnmapped} onClick={confirmImport}>Confirm & import</Btn>
            <Btn onClick={() => { setRawRows(null); setHeaders([]); setMapping({}); setWorkbook(null); }}>Cancel</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// PRODUCT MASTER
// ============================================================
function ProductMaster({ state }) {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState(null);
  const audit = useMemo(() => runDataQualityAudit(state.products, state.transactions), [state.products, state.transactions]);
  const filtered = state.products.filter((p) => normalizeToken(p.name).includes(normalizeToken(q)));

  const CATEGORY_LABELS = {
    duplicateProducts: "Possible duplicate products", missingBrand: "Missing brand", missingPrice: "Missing price",
    inconsistentNaming: "Inconsistent naming", inconsistentUnits: "Inconsistent units", missingVendor: "Missing vendor",
    badQuantities: "Negative/incorrect quantities", ambiguousSpec: "Ambiguous specification",
    suspiciousPrices: "Suspicious prices", insufficientHistory: "Insufficient purchase history", dataIntegrity: "Data integrity issues",
  };
  const totalFindings = Object.values(audit).reduce((s, v) => s + v.length, 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="px-font-display text-lg font-semibold">Product Master</h2>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products…"
          className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm w-64" />
      </div>

      {state.products.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-medium">Data-quality audit — {totalFindings} finding(s) across {state.products.length} products</div>
          <p className="text-xs text-[var(--muted)] mt-1">Every finding below is a direct observation over your actual data — nothing is inferred or invented to fill a gap.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <button key={key} onClick={() => setExpanded(expanded === key ? null : key)}
                className={`text-xs px-2.5 py-1 rounded-full border px-font-mono ${audit[key].length ? "border-[var(--amber-dim)] text-[var(--amber)]" : "border-[var(--border)] text-[var(--muted)]"} ${expanded === key ? "bg-[var(--panel2)]" : ""}`}>
                {label}: {audit[key].length}
              </button>
            ))}
          </div>
          {expanded && audit[expanded].length > 0 && (
            <div className="mt-3 space-y-1 max-h-52 overflow-y-auto px-scroll bg-[var(--void)] border border-[var(--border)] rounded-lg p-3">
              {audit[expanded].map((f, i) => (
                <div key={i} className="text-[11px] px-font-mono text-[var(--text)]">
                  {f.a && f.b ? `${f.a}  ≈${f.similarity}%≈  ${f.b}` : f.product ? `${f.product}${f.issue ? " — " + f.issue : ""}${f.price ? ` (PKR ${f.price})` : ""}` : f.issue}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] px-font-mono text-xs uppercase">
            <tr><th className="text-left p-3">Product</th><th className="text-left p-3">Category</th><th className="text-left p-3">Brand</th><th className="text-right p-3">Stock</th><th className="text-right p-3">Min</th><th className="text-left p-3">Sheet's own status</th><th className="text-left p-3">Source</th></tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const stock = computeCurrentStock(p.id, state.transactions);
              return (
              <tr key={p.id} className="border-t border-[var(--border)] hover:bg-[var(--panel2)]/50">
                <td className="p-3">{p.name}</td>
                <td className="p-3 text-[var(--muted)]">{p.category}</td>
                <td className="p-3 text-[var(--muted)]">{p.brand || "—"}</td>
                <td className="p-3 text-right px-font-mono">{stock ?? "—"}</td>
                <td className="p-3 text-right px-font-mono">{p.min_stock ?? "—"}</td>
                <td className="p-3 text-[var(--muted)] text-xs">{p.source_stock_status || "—"}</td>
                <td className="p-3"><Badge>{p.source === "DEMO DATA" ? "DEMO DATA" : p.source}</Badge></td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ============================================================
// INVENTORY / STOCK INTELLIGENCE
// ============================================================
function ReceiveStockForm({ state, setState, pushAudit, prefill, onDone }) {
  const [form, setForm] = useState({ productId: prefill?.productId || "", qty: prefill?.qty || "", unitCost: prefill?.unitCost || "", vendorName: prefill?.vendorName || "", date: nowISO().slice(0, 10), person: "", reason: "", remarks: "" });
  const submit = () => {
    if (!form.productId || !form.qty) return;
    const product = state.products.find((p) => p.id === form.productId);
    const tx = { id: uid("tx"), productId: form.productId, type: "IN", qty: Number(form.qty), unitCost: form.unitCost ? Number(form.unitCost) : null, vendorName: form.vendorName, date: form.date, person: form.person, reason: form.reason || form.remarks, source: "Manual — Receive Stock" };
    setState((s) => ({ ...s, transactions: [...s.transactions, tx] }));
    pushAudit("Receive Stock", `Received ${form.qty} × "${product?.name}" from ${form.vendorName || "unspecified vendor"}${form.unitCost ? " at " + fmtPKR(form.unitCost) + "/unit" : ""}.`);
    onDone && onDone(tx);
  };
  return (
    <Card className="p-4">
      <div className="text-sm font-medium mb-3">Receive Stock (IN)</div>
      <div className="grid md:grid-cols-3 gap-3">
        <select value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm">
          <option value="">Select product…</option>
          {state.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input type="number" placeholder="Quantity" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
        <input type="number" placeholder="Unit cost (optional)" value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
        <input placeholder="Vendor" value={form.vendorName} onChange={(e) => setForm({ ...form, vendorName: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
        <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
        <input placeholder="Received by (person)" value={form.person} onChange={(e) => setForm({ ...form, person: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
        <input placeholder="Reason / remarks" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm md:col-span-3" />
      </div>
      <Btn variant="primary" className="mt-3" onClick={submit} disabled={!form.productId || !form.qty}>Record receipt</Btn>
    </Card>
  );
}

function IssueStockForm({ state, setState, pushAudit, onDone }) {
  const [form, setForm] = useState({ productId: "", qty: "", date: nowISO().slice(0, 10), person: "", reason: "", remarks: "" });
  const [override, setOverride] = useState(false);
  const check = form.productId && form.qty ? validateIssueQuantity(form.productId, state.transactions, form.qty) : null;
  const blocked = check && check.wouldGoNegative && !override;

  const submit = () => {
    if (!form.productId || !form.qty || blocked) return;
    const product = state.products.find((p) => p.id === form.productId);
    const tx = { id: uid("tx"), productId: form.productId, type: "OUT", qty: Number(form.qty), unitCost: null, vendorName: "", date: form.date, person: form.person, reason: form.reason || form.remarks, source: "Manual — Issue Stock", flagged: !!(check && check.wouldGoNegative), flagReason: check && check.wouldGoNegative ? `Issued beyond available stock (${check.available ?? 0} on hand) — explicitly overridden.` : undefined };
    setState((s) => ({ ...s, transactions: [...s.transactions, tx] }));
    pushAudit("Issue Stock", `Issued ${form.qty} × "${product?.name}" to ${form.person || "unspecified person"}${tx.flagged ? " — ⚠ OVERRIDDEN: exceeded available stock" : ""}.`);
    onDone && onDone(tx);
    setForm({ productId: "", qty: "", date: nowISO().slice(0, 10), person: "", reason: "", remarks: "" });
    setOverride(false);
  };
  return (
    <Card className="p-4">
      <div className="text-sm font-medium mb-3">Issue Stock (OUT)</div>
      <div className="grid md:grid-cols-3 gap-3">
        <select value={form.productId} onChange={(e) => { setForm({ ...form, productId: e.target.value }); setOverride(false); }} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm">
          <option value="">Select product…</option>
          {state.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input type="number" placeholder="Quantity" value={form.qty} onChange={(e) => { setForm({ ...form, qty: e.target.value }); setOverride(false); }} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
        <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
        <input placeholder="Issued to (person)" value={form.person} onChange={(e) => setForm({ ...form, person: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
        <input placeholder="Reason / purpose" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm md:col-span-2" />
      </div>
      {check && (
        <div className="mt-2 text-xs text-[var(--muted)]">Available: {check.available ?? "unknown (no transaction history)"} → resulting stock: <span className={check.wouldGoNegative ? "text-[var(--danger)]" : "text-[var(--text)]"}>{check.resultingStock}</span></div>
      )}
      {check && check.wouldGoNegative && (
        <label className="mt-2 flex items-center gap-2 text-xs text-[var(--danger)]">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
          This exceeds available stock — I understand and want to issue anyway (flagged in the audit log)
        </label>
      )}
      <Btn variant="primary" className="mt-3" onClick={submit} disabled={!form.productId || !form.qty || blocked}>Record issue</Btn>
    </Card>
  );
}

function Inventory({ state, setState, pushAudit }) {
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentProgress, setAgentProgress] = useState(null);
  const [agentSummary, setAgentSummary] = useState(null);
  const [showReceive, setShowReceive] = useState(false);
  const [showIssue, setShowIssue] = useState(false);

  const rows = state.products.map((p) => {
    const stock = computeCurrentStock(p.id, state.transactions);
    const txs = state.transactions.filter((t) => t.productId === p.id && t.type === "OUT");
    const last90 = txs.filter((t) => new Date(t.date) > new Date(Date.now() - 90 * 864e5));
    const monthlyConsumption = last90.length ? last90.reduce((s, t) => s + Number(t.qty), 0) / 3 : 0;
    const health = computeStockHealth(stock, p.min_stock, monthlyConsumption);
    const suggestedQty = ["LOW", "CRITICAL", "REORDER SOON"].includes(health.state) ? reorderQty(stock, p.min_stock, monthlyConsumption) : 0;
    return { ...p, stock, monthlyConsumption: +monthlyConsumption.toFixed(1), health: health.state, coverage: health.coverageMonths, suggestedQty };
  });

  const critical = rows.filter((r) => r.health === "CRITICAL").length;
  const reorder = rows.filter((r) => ["LOW", "REORDER SOON"].includes(r.health)).length;
  const dead = rows.filter((r) => r.health === "DEAD STOCK");
  const totalValue = state.transactions.reduce((s, t) => s + (t.unitCost || 0) * (t.qty || 0), 0);

  const hasActiveRfq = (productName) => state.rfqs.some((r) => r.product === productName && ["AI RECOMMENDED", "AWAITING MANAGER", "RFQ RUNNING", "RECHECK REQUESTED"].includes(r.status));

  const createIndent = (row) => {
    pushAudit("Auto Indent", `Manually created indent for ${row.suggestedQty} × "${row.name}" (current ${row.stock ?? "unknown"}, min ${row.min_stock}, consumption ${row.monthlyConsumption}/mo) — no market research attached yet.`);
    setState((s) => ({ ...s, rfqs: [...s.rfqs, {
      id: uid("rfq"), product: row.name, spec: "", qty: row.suggestedQty, status: "AWAITING MANAGER",
      vendors: [], message: "", createdAt: nowISO(), reason: `Stock ${row.health.toLowerCase()}: ${row.stock ?? "unknown"} on hand vs ${row.min_stock} minimum, consuming ~${row.monthlyConsumption}/month.`,
    }]}));
  };

  // The core "agent": when an item is low, research its real market price and
  // benchmark it against purchase history, then hand a fully-evidenced
  // recommendation to the manager — the manager still has to approve any spend.
  const runAgentOnRow = async (row, liveState) => {
    let marketEvidence = null, err = null;
    try {
      const { text } = await callClaude({
        useWebSearch: true,
        system: `You are a procurement market-research agent for a company buying materials in Pakistan. Use web search to find REAL, currently available pricing for the exact product given. Never invent a vendor, price, or URL. If evidence is weak, say so. Respond with ONLY JSON: {"overallConfidence": 0-100, "insufficientEvidence": true|false, "notes": "string", "findings": [{"vendor": "string", "price": number|null, "currency": "PKR", "sourceTitle": "string", "sourceUrl": "string", "confidence": 0-100}]}`,
        prompt: `Research current Pakistani market pricing for: "${row.name}". Return the JSON only.`,
        maxTokens: 1500,
      });
      marketEvidence = extractJSON(text);
    } catch (e) { err = e.message; }

    const hist = purchaseHistoryStats(liveState.transactions.filter((t) => t.productId === row.id));
    const benchmark = benchmarkPrice(hist, marketEvidence?.findings || []);
    const rfq = {
      id: uid("rfq"), product: row.name, spec: "", qty: row.suggestedQty, status: "AI RECOMMENDED",
      vendors: [], message: "", createdAt: nowISO(),
      reason: `Stock ${row.health.toLowerCase()}: ${row.stock ?? "unknown"} on hand vs ${row.min_stock} minimum, consuming ~${row.monthlyConsumption}/month.`,
      marketEvidence, benchmark,
    };
    pushAudit("Procurement Agent", `Auto-processed "${row.name}": ${err ? "market research failed (" + err + ")" : `market research ${marketEvidence.insufficientEvidence ? "found insufficient evidence" : `found ${marketEvidence.findings.length} source(s)`}`}. Price benchmark: ${benchmark.verdict}. Queued for manager approval.`);
    return rfq;
  };

  const runAgent = async () => {
    const targets = rows.filter((r) => r.suggestedQty > 0 && !hasActiveRfq(r.name));
    if (!targets.length) { setAgentSummary({ processed: 0, note: "Nothing to do — no items below reorder point without an existing pending request." }); return; }
    setAgentRunning(true);
    setAgentSummary(null);
    const results = [];
    for (let i = 0; i < targets.length; i++) {
      setAgentProgress({ current: i + 1, total: targets.length, item: targets[i].name });
      const rfq = await runAgentOnRow(targets[i], state);
      setState((s) => ({ ...s, rfqs: [...s.rfqs, rfq] }));
      results.push({ product: targets[i].name, verdict: rfq.benchmark.verdict });
    }
    setAgentProgress(null);
    setAgentRunning(false);
    setAgentSummary({ processed: results.length, results });
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Inventory Value" value={fmtPKR(totalValue)} sub="From logged transactions" />
        <StatCard label="Critical Items" value={critical} tone="danger" />
        <StatCard label="Reorder Soon" value={reorder} tone="amber" />
        <StatCard label="Dead Stock" value={dead.length} sub={dead.length ? `${fmtPKR(dead.reduce((s,r)=>s+(r.stock||0)*200,0))} tied up (est.)` : ""} />
      </div>

      <div className="flex gap-3">
        <Btn variant="primary" onClick={() => { setShowReceive(!showReceive); setShowIssue(false); }}>{showReceive ? "Close" : "📥 Receive Stock"}</Btn>
        <Btn onClick={() => { setShowIssue(!showIssue); setShowReceive(false); }}>{showIssue ? "Close" : "📤 Issue Stock"}</Btn>
      </div>
      {showReceive && <ReceiveStockForm state={state} setState={setState} pushAudit={pushAudit} onDone={() => setShowReceive(false)} />}
      {showIssue && <IssueStockForm state={state} setState={setState} pushAudit={pushAudit} onDone={() => setShowIssue(false)} />}

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Procurement Agent</div>
            <p className="text-xs text-[var(--muted)] mt-1 max-w-xl">For every item at or below its reorder point without an open request, this researches live market pricing, benchmarks it against purchase history, and queues an evidenced recommendation for your approval. It never places an order — only Approvals can do that.</p>
          </div>
          <Btn variant="primary" onClick={runAgent} disabled={agentRunning}>{agentRunning ? "Running…" : "Run procurement agent"}</Btn>
        </div>
        {agentProgress && <div className="mt-3 text-xs text-[var(--muted)] px-font-mono">Processing {agentProgress.current}/{agentProgress.total}: {agentProgress.item}…</div>}
        {agentSummary && (
          <div className="mt-3 text-xs text-[var(--text)]">
            {agentSummary.processed === 0 ? agentSummary.note : (
              <div className="space-y-1">
                <div className="text-[var(--cyan)]">Processed {agentSummary.processed} item(s) — see the Approvals queue.</div>
                {agentSummary.results.map((r, i) => <div key={i} className="px-font-mono text-[var(--muted)]">{r.product}: {r.verdict}</div>)}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] px-font-mono text-xs uppercase">
            <tr><th className="text-left p-3">Product</th><th className="text-right p-3">Stock</th><th className="text-right p-3">Min</th><th className="text-right p-3">Monthly use</th><th className="text-right p-3">Coverage</th><th className="text-left p-3">Status</th><th className="text-right p-3">Suggested buy</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {rows.sort((a,b)=> (a.health==="CRITICAL"?0:1)-(b.health==="CRITICAL"?0:1)).map((r) => (
              <tr key={r.id} className="border-t border-[var(--border)] hover:bg-[var(--panel2)]/50">
                <td className="p-3">{r.name}</td>
                <td className="p-3 text-right px-font-mono">{r.stock ?? "—"}</td>
                <td className="p-3 text-right px-font-mono text-[var(--muted)]">{r.min_stock ?? "—"}</td>
                <td className="p-3 text-right px-font-mono text-[var(--muted)]">{r.monthlyConsumption || "—"}</td>
                <td className="p-3 text-right px-font-mono text-[var(--muted)]">{r.coverage !== null ? r.coverage + "mo" : "—"}</td>
                <td className="p-3">
                  <Badge tone={stateTone(r.health)}>{r.health}</Badge>
                  {r.source_stock_status && <div className="text-[10px] text-[var(--muted)] mt-1">sheet said: {r.source_stock_status}</div>}
                </td>
                <td className="p-3 text-right px-font-mono">{r.suggestedQty || "—"}</td>
                <td className="p-3">{r.suggestedQty > 0 && !hasActiveRfq(r.name) && <Btn onClick={() => createIndent(r)}>Quick indent</Btn>}{hasActiveRfq(r.name) && <span className="text-[10px] text-[var(--muted)]">already queued</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ============================================================
// PURCHASE HISTORY
// ============================================================
function PurchaseHistory({ state }) {
  const perProduct = state.products.map((p) => {
    const txs = state.transactions.filter((t) => t.productId === p.id && t.unitCost);
    if (!txs.length) return null;
    const prices = txs.map((t) => t.unitCost);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const sorted = [...txs].sort((a, b) => new Date(b.date) - new Date(a.date));
    const byVendor = {};
    txs.forEach((t) => {
      const v = state.vendors.find((v) => v.id === t.vendorId)?.name || t.vendorName || "Unknown";
      byVendor[v] = byVendor[v] || [];
      byVendor[v].push(t.unitCost);
    });
    return {
      product: p, count: txs.length, avg, min: Math.min(...prices), max: Math.max(...prices),
      last: sorted[0].unitCost, lastDate: sorted[0].date,
      vendors: Object.entries(byVendor).map(([name, ps]) => ({ name, avg: ps.reduce((a,b)=>a+b,0)/ps.length, count: ps.length })),
    };
  }).filter(Boolean);

  return (
    <div className="space-y-4">
      <h2 className="px-font-display text-lg font-semibold">Purchase History Intelligence</h2>
      {perProduct.length === 0 && <div className="text-sm text-[var(--muted)]">No priced transactions yet — import data with a vendor and unit price column.</div>}
      {perProduct.map((row) => {
        const variance = row.last && row.avg ? ((row.last - row.avg) / row.avg) * 100 : 0;
        return (
          <Card key={row.product.id} className="p-4">
            <div className="flex items-center justify-between">
              <div className="font-medium">{row.product.name}</div>
              <Badge tone={Math.abs(variance) > 15 ? "critical" : "healthy"}>{variance >= 0 ? "+" : ""}{variance.toFixed(1)}% vs avg</Badge>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3 text-xs">
              <div><div className="text-[var(--muted)]">Purchases</div><div className="px-font-mono text-sm">{row.count}</div></div>
              <div><div className="text-[var(--muted)]">Avg price</div><div className="px-font-mono text-sm">{fmtPKR(row.avg)}</div></div>
              <div><div className="text-[var(--muted)]">Min / Max</div><div className="px-font-mono text-sm">{fmtPKR(row.min)} / {fmtPKR(row.max)}</div></div>
              <div><div className="text-[var(--muted)]">Last price</div><div className="px-font-mono text-sm">{fmtPKR(row.last)}</div></div>
              <div><div className="text-[var(--muted)]">Last bought</div><div className="px-font-mono text-sm">{row.lastDate}</div></div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {row.vendors.map((v) => <span key={v.name} className="text-[11px] px-font-mono bg-[var(--panel2)] border border-[var(--border)] rounded-full px-2 py-1 text-[var(--muted)]">{v.name}: {fmtPKR(v.avg)} ({v.count}×)</span>)}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ============================================================
// VENDORS
// ============================================================
function Vendors({ state }) {
  return (
    <div className="space-y-4">
      <h2 className="px-font-display text-lg font-semibold">Vendor Intelligence</h2>
      <div className="grid md:grid-cols-2 gap-4">
        {state.vendors.map((v) => {
          const score = vendorScore(v);
          return (
            <Card key={v.id} className="p-4 flex items-center gap-4">
              <ConfidenceGauge value={score} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{v.name}</span>
                  <Badge tone={v.verification === "VERIFIED" ? "healthy" : v.verification === "NEW" ? "low" : "info"}>{v.verification}</Badge>
                </div>
                <div className="text-xs text-[var(--muted)] mt-0.5">{v.city} · {v.categories.join(", ")}{v.source === "DEMO DATA" && " · DEMO DATA"}</div>
                <div className="flex gap-4 mt-2 text-[11px] px-font-mono text-[var(--muted)]">
                  <span>Reliability {v.reliability}</span><span>Delivery {v.delivery}</span><span>Quality {v.quality}</span><span>Price {v.priceCompetitiveness}</span>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// MARKET RESEARCH (live AI + web search)
// ============================================================
function MarketResearch({ pushAudit }) {
  const [product, setProduct] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");

  const research = async () => {
    if (!product.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    try {
      const { text, citations } = await callClaude({
        useWebSearch: true,
        system: `You are a procurement market-research agent for a company buying materials in Pakistan (Karachi-focused, but note other cities if relevant). Use web search to find REAL, currently available pricing and vendor evidence for the exact product given. 
RULES:
- Never invent a vendor, price, URL, or availability claim. Only report what search evidence actually supports.
- If you find weak or no reliable evidence, say so explicitly rather than guessing.
- Distinguish retail vs wholesale, tax-inclusive vs exclusive, authorized vs grey-market where you can tell.
- Respond with ONLY valid JSON, no prose outside it, in this exact shape:
{"overallConfidence": 0-100, "insufficientEvidence": true|false, "notes": "string", "findings": [{"vendor": "string", "price": number|null, "currency": "PKR", "taxStatus": "string", "availability": "string", "sourceTitle": "string", "sourceUrl": "string", "dateChecked": "YYYY-MM-DD", "confidence": 0-100, "notes": "string"}]}`,
        prompt: `Research current Pakistani market pricing and vendor availability for: "${product}". Return the JSON only.`,
        maxTokens: 2000,
      });
      const parsed = extractJSON(text);
      setResult(parsed);
      pushAudit("Market Research", `Ran live market research for "${product}" — ${parsed.findings?.length || 0} findings, confidence ${parsed.overallConfidence}%.`);
    } catch (e) {
      setErr(e.message || "Market research failed.");
    } finally { setLoading(false); }
  };

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h2 className="px-font-display text-lg font-semibold">Market Research Agent</h2>
        <p className="text-sm text-[var(--muted)] mt-1">Live web search, not a canned lookup. Every price shown must carry a real source — if evidence is weak, the agent says so instead of guessing.</p>
        <div className="mt-4 flex gap-3">
          <input value={product} onChange={(e) => setProduct(e.target.value)} placeholder='e.g. "Schneider Acti9 iC60N 32A 2P MCB"'
            className="flex-1 bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
          <Btn variant="primary" onClick={research} disabled={loading}>{loading ? "Researching…" : "Research market price"}</Btn>
        </div>
        {err && <div className="mt-3 text-sm text-[var(--danger)]">⚠ {err}</div>}
      </Card>

      {result && (
        <Card className="p-6">
          <div className="flex items-center gap-4 mb-4">
            <ConfidenceGauge value={result.overallConfidence || 0} />
            <div>
              <div className="font-medium">{result.insufficientEvidence ? "Insufficient reliable market evidence" : "Market evidence found"}</div>
              <div className="text-xs text-[var(--muted)] mt-1 max-w-xl">{result.notes}</div>
            </div>
          </div>
          {(result.findings || []).map((f, i) => (
            <div key={i} className="border-t border-[var(--border)] py-3 grid md:grid-cols-6 gap-2 text-sm items-center">
              <div className="font-medium md:col-span-2">{f.vendor}</div>
              <div className="px-font-mono">{f.price ? fmtPKR(f.price) : "—"}</div>
              <div className="text-xs text-[var(--muted)]">{f.taxStatus || "—"}</div>
              <div className="text-xs text-[var(--muted)]">{f.availability || "—"}</div>
              <div>
                {f.sourceUrl ? <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--cyan)] text-xs underline">{f.sourceTitle || "source"}</a> : <span className="text-xs text-[var(--muted)]">no source</span>}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ============================================================
// RFQ
// ============================================================
function RFQBoard({ state, setState, pushAudit }) {
  const [form, setForm] = useState({ product: "", spec: "", qty: "", vendors: [] });

  const createRFQ = () => {
    if (!form.product || !form.qty) return;
    const message = `Assalam-o-Alaikum,\n\nWe require the following material:\n\nProduct: ${form.product}\nSpecification: ${form.spec || "as per standard"}\nQuantity: ${form.qty}\n\nPlease provide:\n1. Unit price\n2. GST\n3. Availability\n4. Delivery time\n5. Warranty\n6. Brand/origin\n7. Payment terms\n\nThank you.`;
    setState((s) => ({ ...s, rfqs: [...s.rfqs, { id: uid("rfq"), ...form, message, status: "RFQ RUNNING", createdAt: nowISO() }] }));
    pushAudit("RFQ", `Created RFQ for ${form.qty} × "${form.product}".`);
    setForm({ product: "", spec: "", qty: "", vendors: [] });
  };

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h2 className="px-font-display text-lg font-semibold">RFQ Agent</h2>
        <div className="grid md:grid-cols-3 gap-3 mt-4">
          <input placeholder="Product" value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
          <input placeholder="Specification" value={form.spec} onChange={(e) => setForm({ ...form, spec: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
          <input placeholder="Quantity" type="number" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
        </div>
        <Btn variant="primary" className="mt-4" onClick={createRFQ}>Generate RFQ</Btn>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        {state.rfqs.slice().reverse().map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex items-center justify-between">
              <span className="font-medium">{r.product}</span>
              <Badge tone="info">{r.status}</Badge>
            </div>
            <div className="text-xs text-[var(--muted)] mt-1">{r.qty} units {r.spec && "· " + r.spec}</div>
            {r.reason && <div className="text-xs text-[var(--amber)] mt-2">{r.reason}</div>}
            <pre className="px-font-mono text-[11px] whitespace-pre-wrap bg-[var(--void)] border border-[var(--border)] rounded-lg p-3 mt-3 text-[var(--muted)]">{r.message}</pre>
            <div className="mt-3 flex gap-2">
              <Btn onClick={() => navigator.clipboard?.writeText(r.message)}>Copy for WhatsApp</Btn>
              <span className="text-[11px] text-[var(--muted)] self-center">No WhatsApp API configured — manual send fallback</span>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// QUOTATIONS + COMPARISON
// ============================================================
function Quotations({ state, setState, pushAudit }) {
  const [form, setForm] = useState({ product: "", vendor: "", unitPrice: "", qty: "", gst: "", delivery: "", warranty: "" });
  const [pasteText, setPasteText] = useState("");
  const [extracting, setExtracting] = useState(false);

  const addQuote = (q) => {
    setState((s) => ({ ...s, quotations: [...s.quotations, { id: uid("quo"), ...q, createdAt: nowISO() }] }));
    pushAudit("Quotation", `Logged quotation from "${q.vendor}" for "${q.product}" at ${fmtPKR(q.unitPrice)}.`);
  };

  const manualAdd = () => {
    if (!form.product || !form.vendor || !form.unitPrice) return;
    addQuote({ ...form, unitPrice: Number(form.unitPrice), qty: Number(form.qty) || 1, gst: Number(form.gst) || 0 });
    setForm({ product: "", vendor: "", unitPrice: "", qty: "", gst: "", delivery: "", warranty: "" });
  };

  const extractFromText = async () => {
    if (!pasteText.trim()) return;
    setExtracting(true);
    try {
      const { text } = await callClaude({
        system: `Extract a structured purchase quotation from the pasted vendor message (WhatsApp/email/etc). Respond with ONLY JSON: {"vendor":"","product":"","unitPrice":number|null,"qty":number|null,"gst":number|null,"delivery":"","warranty":""}. Never invent values not present in the text — use null for unknown numbers and "" for unknown text.`,
        prompt: pasteText,
        maxTokens: 500,
      });
      const parsed = extractJSON(text);
      if (parsed.unitPrice == null || !parsed.vendor) {
        pushAudit("Quotation Extraction", `AI could not confidently extract a full quotation from pasted text — review manually.`);
      } else {
        addQuote({ product: parsed.product || "", vendor: parsed.vendor, unitPrice: parsed.unitPrice, qty: parsed.qty || 1, gst: parsed.gst || 0, delivery: parsed.delivery || "", warranty: parsed.warranty || "" });
      }
      setPasteText("");
    } catch (e) {
      pushAudit("Quotation Extraction", `Extraction failed: ${e.message}`);
    } finally { setExtracting(false); }
  };

  const grouped = useMemo(() => {
    const g = {};
    state.quotations.forEach((q) => { g[q.product] = g[q.product] || []; g[q.product].push(q); });
    return g;
  }, [state.quotations]);

  const historyFor = (productName) => {
    const product = state.products.find((p) => normalizeToken(p.name) === normalizeToken(productName));
    if (!product) return null;
    return purchaseHistoryStats(state.transactions.filter((t) => t.productId === product.id));
  };

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h2 className="px-font-display text-lg font-semibold">Quotation Intake</h2>
        <div className="grid md:grid-cols-3 gap-4 mt-4">
          <div>
            <div className="text-xs text-[var(--muted)] mb-2">Manual entry</div>
            <div className="space-y-2">
              {["product","vendor","unitPrice","qty","gst","delivery","warranty"].map((f) => (
                <input key={f} placeholder={f} value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                  className="w-full bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm" />
              ))}
              <Btn variant="primary" onClick={manualAdd}>Add quotation</Btn>
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="text-xs text-[var(--muted)] mb-2">Paste vendor message (WhatsApp/email) — AI extracts the fields</div>
            <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={7}
              placeholder="e.g. Assalam o Alaikum, Schneider MCB 32A 2P — 4650/pc + GST, 20 pcs available, delivery 2 days, warranty 1 year — ABC Electrical"
              className="w-full bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" />
            <Btn variant="primary" className="mt-2" onClick={extractFromText} disabled={extracting}>{extracting ? "Extracting…" : "Extract with AI"}</Btn>
          </div>
        </div>
      </Card>

      {Object.entries(grouped).map(([product, quotes]) => {
        const ranked = rankQuotations(quotes).map((q) => ({ ...q, total: q.effectiveUnitPrice * (q.qty || 1) }));
        const hist = historyFor(product);
        return (
          <Card key={product} className="p-4 overflow-hidden">
            <div className="flex items-center justify-between mb-3">
              <div className="font-medium">{product}</div>
              {hist && <div className="text-xs text-[var(--muted)] px-font-mono">historical avg: {fmtPKR(hist.avg)} ({hist.count} purchases)</div>}
            </div>
            <table className="w-full text-sm">
              <thead className="text-[var(--muted)] px-font-mono text-xs uppercase">
                <tr><th className="text-left pb-2">Vendor</th><th className="text-right pb-2">Unit price</th><th className="text-right pb-2">GST%</th><th className="text-right pb-2">Effective/unit</th><th className="text-right pb-2">Total</th><th className="text-right pb-2">vs history</th><th className="text-left pb-2">Delivery</th><th className="text-left pb-2">Warranty</th><th className="text-left pb-2">Flag</th></tr>
              </thead>
              <tbody>
                {ranked.map((q) => {
                  const variance = hist ? ((q.effectiveUnitPrice - hist.avg) / hist.avg) * 100 : null;
                  return (
                    <tr key={q.id} className="border-t border-[var(--border)]">
                      <td className="py-2">{q.vendor}</td>
                      <td className="py-2 text-right px-font-mono">{fmtPKR(q.unitPrice)}</td>
                      <td className="py-2 text-right px-font-mono text-[var(--muted)]">{q.gst || 0}</td>
                      <td className="py-2 text-right px-font-mono">{fmtPKR(q.effectiveUnitPrice)}</td>
                      <td className="py-2 text-right px-font-mono">{fmtPKR(q.total)}</td>
                      <td className="py-2 text-right px-font-mono text-[var(--muted)]">{variance !== null ? (variance >= 0 ? "+" : "") + variance.toFixed(1) + "%" : "no history"}</td>
                      <td className="py-2 text-[var(--muted)]">{q.delivery || "—"}</td>
                      <td className="py-2 text-[var(--muted)]">{q.warranty || "—"}</td>
                      <td className="py-2">{q.isBestPrice ? <Badge tone="healthy">BEST PRICE</Badge> : q.isOverpriced ? <Badge tone="critical">OVERPRICED</Badge> : <Badge>—</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="text-[10px] text-[var(--muted)] mt-2">Ranked on GST-inclusive effective price, not raw unit price — a 0%-GST quote isn't automatically compared unfairly against a 17%-GST quote.</div>
          </Card>
        );
      })}
    </div>
  );
}

// ============================================================
// MANAGER APPROVALS
// ============================================================
function Approvals({ state, setState, pushAudit }) {
  const pending = state.rfqs.filter((r) => ["AI RECOMMENDED", "AWAITING MANAGER", "RFQ RUNNING", "RECHECK REQUESTED"].includes(r.status));
  const [rechecking, setRechecking] = useState({});

  const decide = (rfq, decision, reason = "") => {
    setState((s) => ({ ...s, rfqs: s.rfqs.map((r) => r.id === rfq.id ? { ...r, status: decision === "approve" ? "APPROVED" : decision === "reject" ? "CLOSED" : r.status } : r) }));
    pushAudit("Manager Decision", `${decision.toUpperCase()} on "${rfq.product}" (${rfq.qty} units)${reason ? " — reason: " + reason : ""}.`);
  };

  const overrideWithReason = (rfq) => {
    const reason = prompt(`Override "${rfq.product}" and approve anyway. Enter a reason (required):`);
    if (reason === null) return; // cancelled
    if (!reason.trim()) { alert("A reason is required to override — nothing was changed."); return; }
    const before = rfq.status;
    setState((s) => ({ ...s, rfqs: s.rfqs.map((r) => r.id === rfq.id ? { ...r, status: "APPROVED (OVERRIDE)", overrideReason: reason } : r) }));
    pushAudit("Manager Override", `Overrode and approved "${rfq.product}" (${rfq.qty} units) despite normal flow — status changed ${before} → APPROVED (OVERRIDE). Reason given: "${reason}".`);
  };

  const askAIRecheck = async (rfq) => {
    setRechecking((r) => ({ ...r, [rfq.id]: true }));
    const bestQuote = state.quotations.filter((q) => q.product === rfq.product).sort((a, b) => a.unitPrice - b.unitPrice)[0];
    const product = state.products.find((p) => normalizeToken(p.name) === normalizeToken(rfq.product));
    const hist = product ? purchaseHistoryStats(state.transactions.filter((t) => t.productId === product.id)) : null;
    try {
      const { text } = await callClaude({
        system: `You are re-checking a pending procurement recommendation before a manager approves it. Base your re-check ONLY on the data given — never invent prices, vendors, or history that aren't provided.`,
        prompt: `Product: ${rfq.product}\nQuantity requested: ${rfq.qty}\nReason for request: ${rfq.reason || "none given"}\nBest quotation on file: ${bestQuote ? `${bestQuote.vendor} at ${fmtPKR(bestQuote.unitPrice)}` : "none logged"}\nHistorical purchase stats: ${hist ? JSON.stringify(hist) : "no purchase history on file"}`,
        maxTokens: 400,
        responseSchema: SCHEMA_RECHECK_VERDICT,
      });
      const result = extractJSON(text);
      pushAudit("AI Re-check", `Re-check on "${rfq.product}": ${result.verdict} (confidence ${result.confidence}%). ${result.notes}`);
      setState((s) => ({ ...s, rfqs: s.rfqs.map((r) => r.id === rfq.id ? { ...r, lastRecheck: result } : r) }));
    } catch (e) {
      pushAudit("AI Re-check", `Re-check on "${rfq.product}" failed: ${e.message}`);
    } finally {
      setRechecking((r) => ({ ...r, [rfq.id]: false }));
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="px-font-display text-lg font-semibold">Manager Approval Queue</h2>
      {pending.length === 0 && <div className="text-sm text-[var(--muted)]">Nothing waiting on you right now.</div>}
      {pending.map((r) => {
        const bestQuote = state.quotations.filter((q) => q.product === r.product).sort((a,b)=>a.unitPrice-b.unitPrice)[0];
        return (
          <Card key={r.id} className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium">{r.product}</div>
                <div className="text-xs text-[var(--muted)] mt-1">Qty {r.qty}{r.spec && " · " + r.spec}</div>
                {r.reason && <div className="text-xs text-[var(--amber)] mt-2 max-w-md">{r.reason}</div>}
              </div>
              <Badge tone="info">{r.status}</Badge>
            </div>
            {bestQuote ? (
              <div className="mt-3 text-sm px-font-mono text-[var(--text)]">Best quote on file: {bestQuote.vendor} — {fmtPKR(bestQuote.unitPrice)}</div>
            ) : (
              <div className="mt-3 text-sm text-[var(--muted)]">No quotations logged yet for this item — get quotes before approving spend.</div>
            )}
            {r.benchmark && (
              <div className="mt-3 bg-[var(--panel2)] border border-[var(--border)] rounded-lg p-3">
                <div className="flex items-center gap-2">
                  <Badge tone={r.benchmark.verdict === "HISTORICALLY OVERPAYING" ? "critical" : r.benchmark.verdict === "WITHIN MARKET RANGE" ? "healthy" : "default"}>{r.benchmark.verdict}</Badge>
                  <span className="text-xs text-[var(--muted)]">Procurement Agent price benchmark</span>
                </div>
                <div className="text-xs text-[var(--text)] mt-1">{r.benchmark.notes}</div>
                {r.marketEvidence?.findings?.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {r.marketEvidence.findings.map((f, i) => (
                      <div key={i} className="text-[11px] px-font-mono text-[var(--muted)] flex gap-2">
                        <span>{f.vendor}</span><span>{f.price ? fmtPKR(f.price) : "—"}</span>
                        {f.sourceUrl && <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--cyan)] underline">source</a>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {r.overrideReason && <div className="mt-3 text-xs text-[var(--danger)]">Override reason on file: "{r.overrideReason}"</div>}
            {r.lastRecheck && (
              <div className="mt-3 flex items-center gap-2 text-xs bg-[var(--panel2)] border border-[var(--border)] rounded-lg p-2">
                <ConfidenceGauge value={r.lastRecheck.confidence || 0} size={30} />
                <span className={r.lastRecheck.verdict === "flag concern" ? "text-[var(--danger)]" : "text-[var(--text)]"}>{r.lastRecheck.notes}</span>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Btn variant="primary" onClick={() => decide(r, "approve")}>Approve</Btn>
              <Btn variant="danger" onClick={() => decide(r, "reject")}>Reject</Btn>
              <Btn onClick={() => { setState((s)=>({...s, rfqs: s.rfqs.map(x=>x.id===r.id?{...x,status:"RFQ RUNNING"}:x)})); pushAudit("Manager Decision", `Requested more quotations for "${r.product}".`); }}>Get more quotes</Btn>
              <Btn onClick={() => askAIRecheck(r)} disabled={rechecking[r.id]}>{rechecking[r.id] ? "Re-checking…" : "Ask AI to re-check"}</Btn>
              <Btn onClick={() => overrideWithReason(r)}>Override with reason</Btn>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ============================================================
// AUDIT LOG
// ============================================================
function AuditLog({ state }) {
  return (
    <div className="space-y-3">
      <h2 className="px-font-display text-lg font-semibold">Audit Trail</h2>
      <p className="text-xs text-[var(--muted)]">Append-only. Every AI recommendation and manager decision is recorded here with a timestamp.</p>
      <Card className="divide-y divide-[var(--border)]">
        {state.auditLog.slice().reverse().map((a) => (
          <div key={a.id} className="p-3 flex gap-3 text-sm">
            <span className="px-font-mono text-xs text-[var(--muted)] w-40 shrink-0">{new Date(a.ts).toLocaleString("en-PK")}</span>
            <span className="text-[var(--cyan)] w-32 shrink-0 text-xs px-font-mono">{a.action}</span>
            <span className="text-[var(--text)]">{a.detail}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ============================================================
// GOOGLE SHEETS CONNECTOR — real Sheets API v4, read-only.
// Requires a Google Cloud API key with the Sheets API enabled (see
// README for exact setup steps). No OAuth is needed for a link-shared
// sheet because this only ever calls read endpoints. There is
// deliberately no write/update call anywhere in this file.
// ============================================================
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheetsApiGet(path, apiKey) {
  const res = await fetch(`${SHEETS_API_BASE}/${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) {
    let msg = `Sheets API error (HTTP ${res.status})`;
    try { const j = await res.json(); if (j.error?.message) msg = j.error.message; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

async function fetchSheetTabNames(spreadsheetId, apiKey) {
  const meta = await sheetsApiGet(`${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`, apiKey);
  return (meta.sheets || []).map((s) => s.properties.title);
}

// returns a 2D array of cell strings matching detectTableBlocks' expected shape
async function fetchSheetGrid(spreadsheetId, tabName, apiKey) {
  const range = `${tabName}!A1:AZ500`;
  const data = await sheetsApiGet(`${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, apiKey);
  return data.values || [];
}

function GoogleSheetsSync({ state, setState, pushAudit }) {
  const cfg = state.sheetsConfig || {};
  const [form, setForm] = useState({ spreadsheetId: cfg.spreadsheetId || "", tabName: cfg.tabName || "HFM Store", apiKey: cfg.apiKey || "" });
  const [status, setStatus] = useState("idle"); // idle | testing | fetched | syncing | error
  const [error, setError] = useState("");
  const [tabList, setTabList] = useState(null);
  const [blocks, setBlocks] = useState(null);
  const [blockChecks, setBlockChecks] = useState({});
  const [mappings, setMappings] = useState({});
  const [lastImportResult, setLastImportResult] = useState(null);

  const updateCfg = (patch) => setState((s) => ({ ...s, sheetsConfig: { ...s.sheetsConfig, ...patch } }));

  const testConnection = async () => {
    setStatus("testing"); setError(""); setTabList(null); setBlocks(null);
    try {
      const tabs = await fetchSheetTabNames(form.spreadsheetId, form.apiKey);
      setTabList(tabs);
      if (!tabs.includes(form.tabName)) throw new Error(`Connected, but no tab named "${form.tabName}" was found. Tabs on this sheet: ${tabs.join(", ")}`);
      setStatus("connected");
    } catch (e) {
      setStatus("error"); setError(e.message);
    }
  };

  const previewMapping = async () => {
    setStatus("testing"); setError("");
    try {
      const grid = await fetchSheetGrid(form.spreadsheetId, form.tabName, form.apiKey);
      if (!grid.length) throw new Error(`The "${form.tabName}" tab returned no data.`);
      const found = detectTableBlocks(grid);
      if (!found.length) throw new Error(`Connected and read the "${form.tabName}" tab, but couldn't recognize any table structure in it — check the tab has header row(s) using vocabulary like Item/Quantity/Vendor/Date.`);
      const maps = {};
      found.forEach((b, i) => { maps[i] = {}; b.headers.forEach((h) => { maps[i][h] = mapColumn(h); }); });
      const checks = {}; found.forEach((b, i) => { checks[i] = b.recommendedImport; });
      setBlocks(found); setMappings(maps); setBlockChecks(checks);
      setStatus("previewed");
    } catch (e) {
      setStatus("error"); setError(e.message);
    }
  };

  const runSync = async () => {
    if (!blocks) return;
    setStatus("syncing"); setError("");
    updateCfg({ syncStatus: "syncing" });
    try {
      let products = state.products;
      let allTx = state.transactions;
      let addedTx = [];
      let totalRowsImported = 0;
      // Transactions-type blocks first (real dated movements), then
      // Item-Master-type blocks (declared snapshots only fill true gaps,
      // never overrule real transaction evidence), then anything else —
      // same order used everywhere else in the app.
      const order = [...blocks.keys()].filter((i) => blockChecks[i]).sort((a, b) => {
        const rank = (t) => t.startsWith("Transactions") ? 0 : t.startsWith("Item Master") ? 1 : 2;
        return rank(blocks[a].guessedType) - rank(blocks[b].guessedType);
      });
      const selected = order.map((i) => blocks[i]);
      for (const i of order) {
        const b = blocks[i];
        const plan = buildImportPlan(b.headers, b.rows, mappings[i], products, allTx, `Google Sheets: ${form.tabName} (${b.guessedType})`);
        products = plan.products;
        allTx = [...allTx, ...plan.transactions];
        addedTx = [...addedTx, ...plan.transactions];
        totalRowsImported += plan.stats.rowsProcessed - plan.stats.skippedBlank;
      }
      const newState = { ...state, products, transactions: allTx };
      const syncedAt = nowISO();
      newState.sheetsConfig = { ...state.sheetsConfig, spreadsheetId: form.spreadsheetId, tabName: form.tabName, apiKey: form.apiKey, lastSyncedAt: syncedAt, syncStatus: "success", recordsImported: totalRowsImported, lastError: null };
      setState(newState);
      setLastImportResult({ blocksImported: selected.length, rowsImported: totalRowsImported, transactionsCreated: addedTx.length });
      pushAudit("Google Sheets Sync", `Synced "${form.tabName}" from Google Sheets: ${selected.length} block(s), ${totalRowsImported} rows, ${addedTx.length} transactions logged.`);
      setStatus("success");
    } catch (e) {
      setStatus("error"); setError(e.message);
      updateCfg({ syncStatus: "error", lastError: e.message });
    }
  };

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h2 className="px-font-display text-lg font-semibold">Import from Google Sheets</h2>
        <p className="text-sm text-[var(--muted)] mt-1 max-w-2xl">One-time, read-only pull — this is how you get your Google Sheet's structure and data INTO DISRUPT PROCURE AI's own store, not a live link. After importing, DISRUPT PROCURE AI is the system of record: stock moves in/out here, not on the sheet. Never writes back to your sheet. Nothing is imported until you review the detected tables and column mapping below.</p>
        <div className="grid md:grid-cols-3 gap-3 mt-4">
          <div>
            <div className="text-xs text-[var(--muted)] mb-1">Spreadsheet ID</div>
            <input value={form.spreadsheetId} onChange={(e) => setForm({ ...form, spreadsheetId: e.target.value })} className="w-full bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm px-font-mono" />
          </div>
          <div>
            <div className="text-xs text-[var(--muted)] mb-1">Tab name</div>
            <input value={form.tabName} onChange={(e) => setForm({ ...form, tabName: e.target.value })} className="w-full bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm px-font-mono" />
          </div>
          <div>
            <div className="text-xs text-[var(--muted)] mb-1">Google Cloud API key</div>
            <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="not configured yet" className="w-full bg-[var(--panel2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm px-font-mono" />
          </div>
        </div>
        <div className="mt-4 flex gap-3">
          <Btn onClick={testConnection} disabled={status === "testing" || !form.apiKey}>Test connection</Btn>
          <Btn variant="primary" onClick={previewMapping} disabled={status === "testing" || !form.apiKey}>Preview & map columns</Btn>
        </div>
        {!form.apiKey && <div className="mt-3 text-xs text-[var(--amber)]">No API key configured — see the setup steps below. Nothing will be faked or substituted while this is empty.</div>}
        {error && <div className="mt-3 text-sm text-[var(--danger)]">⚠ {error}</div>}
        {tabList && <div className="mt-3 text-xs text-[var(--muted)]">Tabs found on this spreadsheet: {tabList.join(", ")}</div>}
      </Card>

      <Card className="p-4">
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div><div className="text-[11px] text-[var(--muted)] px-font-mono uppercase">Last synced</div><div className="mt-1">{cfg.lastSyncedAt ? new Date(cfg.lastSyncedAt).toLocaleString("en-PK") : "Never"}</div></div>
          <div><div className="text-[11px] text-[var(--muted)] px-font-mono uppercase">Sync status</div><div className="mt-1"><Badge tone={cfg.syncStatus === "success" ? "healthy" : cfg.syncStatus === "error" ? "critical" : "default"}>{(cfg.syncStatus || "never").toUpperCase()}</Badge></div></div>
          <div><div className="text-[11px] text-[var(--muted)] px-font-mono uppercase">Records imported (last sync)</div><div className="mt-1 px-font-mono">{cfg.recordsImported ?? "—"}</div></div>
        </div>
        {cfg.lastError && <div className="mt-2 text-xs text-[var(--danger)]">Last error: {cfg.lastError}</div>}
      </Card>

      {blocks && (
        <Card className="p-6">
          <h3 className="px-font-display font-semibold mb-1">Detected tables in "{form.tabName}"</h3>
          <p className="text-xs text-[var(--muted)] mb-4">This tab was scanned for table structure — no fixed row/column numbers assumed. Uncheck anything that shouldn't be imported as inventory (e.g. a demand/wishlist table).</p>
          {blocks.map((b, i) => (
            <div key={i} className="border-t border-[var(--border)] pt-4 mt-4 first:border-t-0 first:pt-0 first:mt-0">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!!blockChecks[i]} onChange={(e) => setBlockChecks({ ...blockChecks, [i]: e.target.checked })} />
                <span className="font-medium text-sm">Block {i + 1}: {b.guessedType}</span>
                <span className="text-xs text-[var(--muted)]">({b.rows.length} rows, columns {b.colStart + 1}–{b.colEnd + 1})</span>
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                {b.headers.map((h) => {
                  const m = mappings[i][h];
                  return <span key={h} className="text-[11px] px-font-mono bg-[var(--panel2)] border border-[var(--border)] rounded-full px-2 py-1">{h} → {m.field || "ignored"} {m.field && `(${m.confidence}%)`}</span>;
                })}
              </div>
            </div>
          ))}
          <Btn variant="primary" className="mt-5" onClick={runSync} disabled={status === "syncing"}>{status === "syncing" ? "Syncing…" : "Sync now"}</Btn>
        </Card>
      )}

      {lastImportResult && (
        <Card className="p-4 border-[var(--cyan-dim)]">
          <div className="text-sm text-[var(--cyan)] font-medium">Sync complete</div>
          <div className="text-xs text-[var(--muted)] mt-1">{lastImportResult.blocksImported} block(s) · {lastImportResult.rowsImported} rows · {lastImportResult.transactionsCreated} transactions logged. Your original Google Sheet was not modified — this was a read-only sync.</div>
        </Card>
      )}

      <Card className="p-4">
        <div className="text-sm font-medium">Setup required</div>
        <ol className="text-xs text-[var(--muted)] mt-2 space-y-1 list-decimal list-inside">
          <li>Create (or reuse) a Google Cloud project and enable the "Google Sheets API".</li>
          <li>Create an API key (Credentials → Create Credentials → API key). Read-only sheet access needs no OAuth consent screen.</li>
          <li>Optionally restrict the key to the Sheets API for safety — it can only ever read whatever's already link-shared.</li>
          <li>Paste the key above. It's stored only in this app's local data, never sent anywhere except Google's API.</li>
          <li>Keep the sheet's "Anyone with the link" sharing on for as long as you want key-only access — if you later lock it down, this would need OAuth instead.</li>
        </ol>
      </Card>
    </div>
  );
}
// ============================================================
// TECHNICIAN MODE
// ============================================================
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function callClaudeVision({ base64, mediaType, catalogNames }) {
  const res = await fetch("/api/groq", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      max_tokens: 700, // model chosen server-side by api/groq.js based on request shape
      system: `You identify procurement items from a photo for a Pakistani facility-management store. You are given the store's current product catalog names for reference — prefer matching to one of these if the photo clearly matches, but you may also identify a brand/model/spec not in the catalog. NEVER invent a part number, brand, or spec you cannot actually see — if the image is unclear or you're not confident, say so and ask for a clearer photo (e.g. of the nameplate). Catalog: ${JSON.stringify(catalogNames).slice(0, 3000)}`,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: "Identify this item." },
      ]}],
      responseSchema: SCHEMA_VISION_IDENTIFY,
    }),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res, "Vision request failed"));
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return extractJSON(text);
}

// Image-first procurement: identifies up to 3 ranked candidate matches
// instead of one guess, so the user picks the right one rather than the
// AI silently committing to a possibly-wrong single answer.
async function identifyProductCandidates({ base64, mediaType, catalogNames }) {
  const res = await fetch("/api/groq", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      max_tokens: 900, // model chosen server-side by api/groq.js based on request shape
      system: `You identify procurement items from a photo for a Pakistani facility-management store, for a "photograph it to buy it" workflow. You are given the store's current product catalog for reference.
RULES:
- Never invent a brand, model, part number, or spec you can't actually see in the photo.
- Return UP TO 3 ranked candidate identifications with a real confidence score (0-100) each, most likely first. If you can only support one candidate, return just one.
- If the photo is too unclear/blurry/distant to identify ANYTHING with reasonable confidence, set "identified": false and explain what photo would help (e.g. a closer shot of the nameplate) — do not force a guess.
- "catalogMatch" should be the EXACT catalog name only if you're confident this photo shows that exact catalog item; otherwise null.
Catalog: ${JSON.stringify(catalogNames).slice(0, 3000)}`,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: "Identify this product for procurement. Give up to 3 ranked candidates." },
      ]}],
      responseSchema: SCHEMA_PHOTO_CANDIDATES,
    }),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res, "Vision request failed"));
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const parsed = extractJSON(text);
  // defensive: never let a missing/malformed candidates array reach the UI as undefined
  if (!Array.isArray(parsed.candidates)) parsed.candidates = [];
  return parsed;
}

// Full vendor/price intelligence for a confirmed product — the richer
// schema the image-first flow needs (availability, delivery, warranty,
// date checked), on top of the same "never fabricate" rules as the rest
// of the app's market research.
//
// NOTE: this call uses web search grounding, so it deliberately does NOT
// request native structured output (see api/groq.js for why) — it's
// hardened instead with a larger token budget (this response includes
// grounding-derived findings + notes, which is what previously got cut
// off mid-JSON around ~8800 characters at the old 1800-token ceiling)
// and the improved extractJSON, which now shows the real cause if
// parsing still fails instead of a blank error.
async function researchProductSources(productLabel) {
  const { text } = await callClaude({
    useWebSearch: true,
    system: `You are a procurement market-research agent for a company buying materials in Pakistan. Use web search to find REAL, currently available vendor pricing for the exact product given. Never invent a vendor, price, URL, availability claim, delivery time, or warranty term. If evidence is weak or absent, say so explicitly rather than guessing. Respond with ONLY JSON, no other text: {"overallConfidence": 0-100, "insufficientEvidence": true|false, "notes": "string", "recommendedPrice": number|null, "findings": [{"vendor": "string", "price": number|null, "currency": "PKR", "availability": "string", "delivery": "string", "warranty": "string", "sourceTitle": "string", "sourceUrl": "string", "dateChecked": "YYYY-MM-DD", "confidence": 0-100}]}. Keep "notes" to 2-3 sentences and cap "findings" at the 5 best sources — do not let the response run long enough to risk truncation.`,
    prompt: `Research current Pakistani vendor pricing and availability for: "${productLabel}". Return the JSON only.`,
    maxTokens: 3500,
  });
  const parsed = extractJSON(text);
  // defensive: never let a missing/malformed findings array reach benchmarkPrice or the UI as undefined
  if (!Array.isArray(parsed.findings)) parsed.findings = [];
  return parsed;
}

function useSpeechRecognition() {
  const supported = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const recRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [err, setErr] = useState("");

  const start = (lang) => {
    if (!supported) { setErr("Voice recognition isn't available in this browser. Type your request instead."); return; }
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Rec();
    rec.lang = lang; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => setTranscript(e.results[0][0].transcript);
    rec.onerror = (e) => setErr("Voice recognition error: " + e.error + ". Type your request instead.");
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setTranscript(""); setErr(""); setListening(true);
    rec.start();
  };
  const stop = () => { recRef.current?.stop(); setListening(false); };
  return { supported: !!supported, listening, transcript, err, start, stop, setTranscript };
}

function TechnicianMode({ state, setState, pushAudit }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("search"); // search | voice | scan
  const [lang, setLang] = useState("en-US");
  const [voiceParsing, setVoiceParsing] = useState(false);
  const [voiceResult, setVoiceResult] = useState(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [scanErr, setScanErr] = useState("");
  const fileRef = useRef();
  const speech = useSpeechRecognition();

  const matches = query.length > 1 ? state.products.filter((p) => normalizeToken(p.name).includes(normalizeToken(query))) : [];

  const request = (name, note) => {
    setState((s) => ({ ...s, rfqs: [...s.rfqs, { id: uid("rfq"), product: name, spec: "", qty: 1, status: "AWAITING MANAGER", vendors: [], message: "", createdAt: nowISO(), reason: note || "Requested directly by technician." }] }));
    pushAudit("Technician Request", `Material requested: "${name}"${note ? " — " + note : ""}.`);
    setQuery(""); setVoiceResult(null); setScanResult(null);
  };

  const parseVoice = async () => {
    if (!speech.transcript.trim()) return;
    setVoiceParsing(true);
    try {
      const { text } = await callClaude({
        system: `Convert a spoken material request (English, Urdu, or Roman Urdu/mixed) into a structured procurement search. You are given the store's actual catalog — only set "catalogMatch" if you are confident it refers to that exact catalog item; otherwise leave it null and just extract the freeform description. Never invent a catalog item that isn't in the list. Catalog: ${JSON.stringify(state.products.map((p) => p.name)).slice(0, 3000)}`,
        prompt: speech.transcript,
        maxTokens: 400,
        responseSchema: SCHEMA_VOICE_REQUEST,
      });
      setVoiceResult(extractJSON(text));
    } catch (e) {
      setVoiceResult({ description: speech.transcript, catalogMatch: null, quantity: null, error: e.message });
    } finally { setVoiceParsing(false); }
  };

  const handlePhoto = async (file) => {
    setScanErr(""); setScanResult(null); setScanLoading(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await callClaudeVision({ base64, mediaType: file.type || "image/jpeg", catalogNames: state.products.map((p) => p.name) });
      setScanResult(result);
    } catch (e) { setScanErr(e.message || "Could not identify this photo."); }
    finally { setScanLoading(false); }
  };

  return (
    <div className="max-w-md mx-auto space-y-4 py-6">
      <div className="text-center">
        <div className="px-font-display text-xl font-semibold">Request Material</div>
        <div className="text-xs text-[var(--muted)] mt-1">Speak, scan, or type — no procurement knowledge needed.</div>
      </div>

      <div className="flex gap-2 justify-center">
        {[["search","🔎 Search"],["voice","🎤 Talk"],["scan","📷 Scan"]].map(([k,label]) => (
          <button key={k} onClick={() => setMode(k)} className={`px-3 py-1.5 rounded-lg text-sm border ${mode===k?"border-[var(--amber-dim)] text-[var(--amber)] bg-[var(--panel2)]":"border-[var(--border)] text-[var(--muted)]"}`}>{label}</button>
        ))}
      </div>

      {mode === "search" && (
        <>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Schneider 32 amp MCB…"
            className="w-full bg-[var(--panel2)] border border-[var(--border)] rounded-xl px-4 py-3 text-base text-center" />
          <div className="space-y-2">
            {matches.map((p) => (
              <button key={p.id} onClick={() => request(p.name)} className="w-full text-left bg-[var(--panel)] border border-[var(--border)] rounded-xl px-4 py-3 hover:border-[var(--amber-dim)]">
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-[var(--muted)]">{computeCurrentStock(p.id, state.transactions) ?? "unknown"} in stock · tap to request</div>
              </button>
            ))}
            {query.length > 1 && matches.length === 0 && <div className="text-center text-xs text-[var(--muted)]">No matching item — a manager will need to source this as new.</div>}
          </div>
        </>
      )}

      {mode === "voice" && (
        <div className="space-y-3">
          <div className="flex gap-2 justify-center text-xs">
            {[["en-US","English"],["ur-PK","Urdu"]].map(([code,label]) => (
              <button key={code} onClick={() => setLang(code)} className={`px-2 py-1 rounded border ${lang===code?"border-[var(--amber-dim)] text-[var(--amber)]":"border-[var(--border)] text-[var(--muted)]"}`}>{label}</button>
            ))}
            <span className="text-[var(--muted)] self-center">Roman Urdu works under either — try English if Urdu isn't recognized well.</span>
          </div>
          {!speech.supported && <div className="text-center text-sm text-[var(--danger)]">Voice recognition isn't available in this browser. Please use Search or Scan instead.</div>}
          {speech.supported && (
            <div className="text-center">
              <button onClick={() => speech.listening ? speech.stop() : speech.start(lang)}
                className={`w-20 h-20 rounded-full text-2xl border-2 ${speech.listening ? "border-[var(--danger)] bg-[#2A1416] animate-pulse" : "border-[var(--amber-dim)] bg-[var(--panel2)]"}`}>
                🎤
              </button>
              <div className="text-xs text-[var(--muted)] mt-2">{speech.listening ? "Listening…" : "Tap to speak"}</div>
            </div>
          )}
          {speech.err && <div className="text-center text-xs text-[var(--danger)]">{speech.err}</div>}
          {speech.transcript && (
            <Card className="p-3">
              <div className="text-xs text-[var(--muted)]">Heard:</div>
              <div className="text-sm px-font-mono">{speech.transcript}</div>
              <Btn variant="primary" className="mt-2" onClick={parseVoice} disabled={voiceParsing}>{voiceParsing ? "Interpreting…" : "Interpret request"}</Btn>
            </Card>
          )}
          {voiceResult && (
            <Card className="p-3">
              <div className="text-sm">{voiceResult.description}</div>
              {voiceResult.catalogMatch ? (
                <Btn variant="primary" className="mt-2" onClick={() => request(voiceResult.catalogMatch, `Requested by voice: "${speech.transcript}"`)}>Request "{voiceResult.catalogMatch}"</Btn>
              ) : (
                <>
                  <div className="text-xs text-[var(--amber)] mt-1">No confident catalog match — this will go to a manager as a new-item request.</div>
                  <Btn className="mt-2" onClick={() => request(voiceResult.description, `Requested by voice, no catalog match: "${speech.transcript}"`)}>Send as new-item request</Btn>
                </>
              )}
            </Card>
          )}
        </div>
      )}

      {mode === "scan" && (
        <div className="space-y-3">
          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files[0] && handlePhoto(e.target.files[0])} />
          <div className="text-center">
            <Btn variant="primary" onClick={() => fileRef.current.click()} disabled={scanLoading}>{scanLoading ? "Identifying…" : "📷 Take or upload photo"}</Btn>
          </div>
          {scanErr && <div className="text-center text-xs text-[var(--danger)]">{scanErr}</div>}
          {scanResult && (
            <Card className="p-3">
              {!scanResult.identified ? (
                <div className="text-sm text-[var(--amber)]">Couldn't confidently identify this item. {scanResult.clarificationNeeded || "Try a clearer photo, ideally of the nameplate."}</div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <ConfidenceGauge value={scanResult.confidence || 0} size={36} />
                    <div className="text-sm">{[scanResult.brand, scanResult.model, scanResult.specification].filter(Boolean).join(" · ")}</div>
                  </div>
                  {scanResult.notes && <div className="text-xs text-[var(--muted)] mt-1">{scanResult.notes}</div>}
                  {scanResult.catalogMatch ? (
                    <Btn variant="primary" className="mt-2" onClick={() => request(scanResult.catalogMatch, "Requested via photo scan.")}>Request "{scanResult.catalogMatch}"</Btn>
                  ) : (
                    <Btn className="mt-2" onClick={() => request([scanResult.brand, scanResult.model, scanResult.specification].filter(Boolean).join(" "), "Requested via photo scan, no catalog match.")}>Send as new-item request</Btn>
                  )}
                </>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// IMAGE-FIRST PROCUREMENT — the primary workflow:
// Photo -> AI identifies ranked candidates -> user confirms -> price
// intelligence + vendor sources -> [Use This Product] / [Request Quotes]
// ============================================================
function ProcureByPhoto({ state, setState, pushAudit }) {
  const [photo, setPhoto] = useState(null); // { base64, previewUrl, mediaType }
  const [identifying, setIdentifying] = useState(false);
  const [idError, setIdError] = useState("");
  const [idResult, setIdResult] = useState(null); // { identified, candidates, clarificationNeeded }
  const [chosen, setChosen] = useState(null); // the selected candidate
  const [researching, setResearching] = useState(false);
  const [research, setResearch] = useState(null);
  const [researchError, setResearchError] = useState("");
  const [actionMsg, setActionMsg] = useState("");
  const fileRef = useRef();

  const reset = () => { setPhoto(null); setIdResult(null); setChosen(null); setResearch(null); setIdError(""); setResearchError(""); setActionMsg(""); };

  const handleFile = async (file) => {
    reset();
    const base64 = await fileToBase64(file);
    const previewUrl = URL.createObjectURL(file);
    setPhoto({ base64, previewUrl, mediaType: file.type || "image/jpeg" });
    setIdentifying(true);
    setIdError("");
    try {
      const result = await identifyProductCandidates({ base64, mediaType: file.type || "image/jpeg", catalogNames: state.products.map((p) => p.name) });
      setIdResult(result);
    } catch (e) {
      setIdError(e.message || "Could not identify this photo.");
    } finally {
      setIdentifying(false);
    }
  };

  const confirmCandidate = async (candidate) => {
    setChosen(candidate);
    setResearching(true);
    setResearchError("");
    setResearch(null);
    try {
      const r = await researchProductSources(candidate.label);
      setResearch(r);
    } catch (e) {
      setResearchError(e.message || "Market research failed.");
    } finally {
      setResearching(false);
    }
  };

  const matchedProduct = chosen?.catalogMatch ? state.products.find((p) => p.name === chosen.catalogMatch) : null;
  const historyStats = matchedProduct ? purchaseHistoryStats(state.transactions.filter((t) => t.productId === matchedProduct.id)) : null;
  const benchmark = research ? benchmarkPrice(historyStats, research.findings || []) : null;
  const currentStock = matchedProduct ? computeCurrentStock(matchedProduct.id, state.transactions) : null;

  const useThisProduct = () => {
    if (matchedProduct) {
      setActionMsg(`Linked to existing product "${matchedProduct.name}" — current stock ${currentStock ?? "unknown"}. See Store → Inventory.`);
      pushAudit("Photo Identification", `Photo confirmed as existing product "${matchedProduct.name}" (${chosen.confidence}% match).`);
    } else {
      const newProduct = { id: uid("prod"), name: chosen.label, normalized_name: normalizeToken(chosen.label), category: "Uncategorized", subcategory: "", brand: chosen.brand || "", uom: chosen.unit || "pcs", min_stock: null, preferred_vendor: "", confidence: chosen.confidence, source: "Photo identification" };
      setState((s) => ({ ...s, products: [...s.products, newProduct] }));
      setActionMsg(`Added "${chosen.label}" to the Product Master as a new item (no stock recorded yet — use Receive Stock in the Store to log the first delivery).`);
      pushAudit("Photo Identification", `New product added from photo: "${chosen.label}" (${chosen.confidence}% confidence, not in prior catalog).`);
    }
  };

  const requestQuotes = () => {
    const productName = matchedProduct ? matchedProduct.name : chosen.label;
    setState((s) => ({ ...s, rfqs: [...s.rfqs, {
      id: uid("rfq"), product: productName, spec: [chosen.brand, chosen.model, chosen.specification].filter(Boolean).join(" · "),
      qty: matchedProduct ? Math.max(1, reorderQty(currentStock, matchedProduct.min_stock, 0)) : 1,
      status: "AI RECOMMENDED", vendors: [], message: "", createdAt: nowISO(),
      reason: "Requested via image-first procurement (photo identification + live market research).",
      marketEvidence: research, benchmark,
    }]}));
    setActionMsg(`Request queued for manager approval — see Approvals. Product: "${productName}".`);
    pushAudit("Photo Identification", `Requested quotes for "${productName}" via photo workflow. Benchmark: ${benchmark?.verdict || "n/a"}.`);
  };

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h2 className="px-font-display text-lg font-semibold">Procure by Photo</h2>
        <p className="text-sm text-[var(--muted)] mt-1 max-w-2xl">Photograph the item you need — no need to know its exact name or spelling. The AI identifies likely matches, you confirm, and it researches live pricing and vendors before anything goes to your manager for approval.</p>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
        <Btn variant="primary" className="mt-4" onClick={() => fileRef.current.click()}>📷 Take or upload photo</Btn>
      </Card>

      {photo && (
        <div className="grid md:grid-cols-[200px_1fr] gap-5">
          <img src={photo.previewUrl} alt="uploaded product" className="w-full h-48 object-cover rounded-xl border border-[var(--border)]" />
          <div className="space-y-4">
            {identifying && <div className="text-sm text-[var(--muted)] px-font-mono">Identifying…</div>}
            {idError && <div className="text-sm text-[var(--danger)]">⚠ {idError}</div>}

            {idResult && !idResult.identified && (
              <Card className="p-4 border-[var(--amber-dim)]">
                <div className="text-sm font-medium text-[var(--amber)]">Couldn't confidently identify this item</div>
                <div className="text-xs text-[var(--muted)] mt-1">{idResult.clarificationNeeded || "Try a clearer, closer photo — ideally of the nameplate or label."}</div>
              </Card>
            )}

            {idResult && idResult.identified && !chosen && (
              <div className="space-y-2">
                <div className="text-sm font-medium">What I found</div>
                {idResult.candidates.map((c, i) => (
                  <button key={i} onClick={() => confirmCandidate(c)} className="w-full text-left bg-[var(--panel)] border border-[var(--border)] rounded-xl p-3 hover:border-[var(--amber-dim)] flex items-center gap-3">
                    <ConfidenceGauge value={c.confidence} size={40} />
                    <div>
                      <div className="font-medium text-sm">{i + 1}. {c.label}</div>
                      <div className="text-xs text-[var(--muted)]">{c.catalogMatch ? `Matches catalog item "${c.catalogMatch}"` : "Not in current catalog — would be added as new"}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {chosen && (
              <div className="space-y-4">
                <Card className="p-4">
                  <div className="text-xs text-[var(--muted)] uppercase px-font-mono mb-2">Product</div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><span className="text-[var(--muted)]">Brand:</span> {chosen.brand || "—"}</div>
                    <div><span className="text-[var(--muted)]">Model:</span> {chosen.model || "—"}</div>
                    <div><span className="text-[var(--muted)]">Specification:</span> {chosen.specification || "—"}</div>
                    <div><span className="text-[var(--muted)]">Part number:</span> {chosen.partNumber || "—"}</div>
                    <div><span className="text-[var(--muted)]">Unit:</span> {chosen.unit || "pcs"}</div>
                    <div><span className="text-[var(--muted)]">Confidence:</span> {chosen.confidence}%</div>
                  </div>
                  {matchedProduct && <div className="text-xs text-[var(--cyan)] mt-2">Matched to existing store item — current stock: {currentStock ?? "unknown"}, min: {matchedProduct.min_stock ?? "unknown"}</div>}
                </Card>

                {researching && <div className="text-sm text-[var(--muted)] px-font-mono">Researching live market price & vendors…</div>}
                {researchError && <div className="text-sm text-[var(--danger)]">⚠ {researchError}</div>}

                {research && (
                  <Card className="p-4">
                    <div className="text-xs text-[var(--muted)] uppercase px-font-mono mb-2">Price Intelligence</div>
                    <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                      <div><span className="text-[var(--muted)]">Historical price:</span> {historyStats ? fmtPKR(historyStats.avg) + ` (${historyStats.count}×)` : "no purchase history"}</div>
                      <div><span className="text-[var(--muted)]">Market range:</span> {benchmark?.marketMin ? `${fmtPKR(benchmark.marketMin)}–${fmtPKR(benchmark.marketMax)}` : "insufficient evidence"}</div>
                      <div><span className="text-[var(--muted)]">Lowest reliable price:</span> {benchmark?.marketMin ? fmtPKR(benchmark.marketMin) : "—"}</div>
                      <div><span className="text-[var(--muted)]">Recommended price:</span> {research.recommendedPrice ? fmtPKR(research.recommendedPrice) : (benchmark?.marketMin ? fmtPKR(benchmark.marketMin) : "—")}</div>
                    </div>
                    {benchmark && <Badge tone={benchmark.verdict === "HISTORICALLY OVERPAYING" ? "critical" : benchmark.verdict === "WITHIN MARKET RANGE" ? "healthy" : "default"}>{benchmark.verdict}</Badge>}
                    <div className="text-xs text-[var(--muted)] mt-2">{benchmark?.notes || research.notes}</div>

                    <div className="text-xs text-[var(--muted)] uppercase px-font-mono mt-4 mb-2">Available Sources / Vendors</div>
                    {(!research.findings || research.findings.length === 0) ? (
                      <div className="text-sm text-[var(--muted)]">No reliable vendor sources found — insufficient market evidence.</div>
                    ) : (
                      <div className="space-y-2">
                        {research.findings.map((f, i) => (
                          <div key={i} className="border-t border-[var(--border)] pt-2 grid md:grid-cols-6 gap-1 text-xs items-center">
                            <div className="font-medium md:col-span-2">{f.vendor}</div>
                            <div className="px-font-mono">{f.price ? fmtPKR(f.price) : "—"}</div>
                            <div className="text-[var(--muted)]">{f.availability || "—"}</div>
                            <div className="text-[var(--muted)]">{f.delivery || "—"} {f.warranty ? "· " + f.warranty : ""}</div>
                            <div>{f.sourceUrl ? <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--cyan)] underline">source ({f.dateChecked || "n/a"})</a> : <span className="text-[var(--muted)]">no source</span>}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )}

                {research && (
                  <div className="flex flex-wrap gap-3">
                    <Btn variant="primary" onClick={useThisProduct}>Use This Product</Btn>
                    <Btn onClick={requestQuotes}>Request Quotes</Btn>
                    <Btn variant="ghost" onClick={reset}>Start over with a new photo</Btn>
                  </div>
                )}
                {actionMsg && <div className="text-sm text-[var(--cyan)]">{actionMsg}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// DASHBOARD
// ============================================================
function Dashboard({ state, setTab }) {
  const totalValue = state.transactions.reduce((s, t) => s + (t.unitCost || 0) * (t.qty || 0), 0);
  const critical = state.products.filter((p) => computeStockHealth(computeCurrentStock(p.id, state.transactions), p.min_stock, 1).state === "CRITICAL").length;
  const pendingApprovals = state.rfqs.filter((r) => ["AI RECOMMENDED","AWAITING MANAGER","RFQ RUNNING"].includes(r.status)).length;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="px-font-display text-2xl font-semibold">DISRUPT PROCURE AI</h1>
        <p className="text-sm text-[var(--muted)]">Karachi HFM store · {state.products.length} products tracked</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-6 border-[var(--amber-dim)] cursor-pointer hover:brightness-110" onClick={() => setTab("photo")}>
          <div className="flex items-center gap-4">
            <div className="text-4xl">📷</div>
            <div>
              <div className="px-font-display font-semibold">Procure by Photo</div>
              <div className="text-sm text-[var(--muted)] mt-1">Photograph what you need — AI identifies it, researches live prices and vendors, and prepares a request for your approval. No exact product name required.</div>
            </div>
          </div>
        </Card>
        <Card className="p-6 border-[var(--cyan-dim)] cursor-pointer hover:brightness-110" onClick={() => setTab("auditor")}>
          <div className="flex items-center gap-4">
            <div className="text-4xl">📊</div>
            <div>
              <div className="px-font-display font-semibold">Procurement Auditor</div>
              <div className="text-sm text-[var(--muted)] mt-1">Upload any vendor quotation — Excel, PDF, photo, or Word doc — and get a sourced verdict on every line: above market, within market, or insufficient evidence.</div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Inventory Value" value={fmtPKR(totalValue)} />
        <StatCard label="Items in Stock" value={state.products.length} />
        <StatCard label="Critical Items" value={critical} tone="danger" />
        <StatCard label="Pending Approvals" value={pendingApprovals} tone="amber" />
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        <Card className="p-4 cursor-pointer hover:border-[var(--amber-dim)]" onClick={() => setTab("inventory")}>
          <div className="text-sm font-medium">Store / Stock Alerts →</div>
          <div className="text-xs text-[var(--muted)] mt-1">Receive/Issue stock, review critical &amp; reorder-soon items</div>
        </Card>
        <Card className="p-4 cursor-pointer hover:border-[var(--amber-dim)]" onClick={() => setTab("approvals")}>
          <div className="text-sm font-medium">Approval Queue →</div>
          <div className="text-xs text-[var(--muted)] mt-1">{pendingApprovals} items waiting on you</div>
        </Card>
        <Card className="p-4 cursor-pointer hover:border-[var(--amber-dim)]" onClick={() => setTab("market")}>
          <div className="text-sm font-medium">Market Research →</div>
          <div className="text-xs text-[var(--muted)] mt-1">Check a price against live Pakistani market evidence</div>
        </Card>
      </div>
    </div>
  );
}

// ============================================================
// ============================================================
// 📊 PROCUREMENT AUDITOR
// Upload any quotation (xlsx/csv/pdf/image/docx) -> extract line items ->
// identify/normalize each product -> research live market price ->
// compare against history + market -> verdict + potential
// overpayment/saving, single-line or full batch.
// ============================================================
async function extractQuotationLines(file) {
  const name = file.name.toLowerCase();
  const EXTRACT_SYSTEM = `You extract line items from a vendor quotation for a procurement audit. Extract EXACTLY what is present — never invent a product, price, quantity, or vendor that isn't actually shown. If a field isn't present for a line, use null (numbers) or "" (text).`;

  if (name.endsWith(".csv") || name.endsWith(".xlsx") || name.endsWith(".xls")) {
    let rows, headers;
    if (name.endsWith(".csv")) {
      const parsed = await new Promise((resolve, reject) => Papa.parse(file, { header: true, skipEmptyLines: true, complete: resolve, error: reject }));
      rows = parsed.data; headers = parsed.meta.fields || [];
    } else {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      headers = rows.length ? Object.keys(rows[0]) : [];
    }
    if (!rows.length) throw new Error("No rows found in this file.");
    const { text } = await callClaude({
      system: EXTRACT_SYSTEM,
      prompt: `Extract quotation line items from this spreadsheet data (headers: ${headers.join(", ")}):\n${JSON.stringify(rows).slice(0, 6000)}`,
      maxTokens: 3000,
      responseSchema: SCHEMA_QUOTATION_EXTRACTION,
    });
    const parsed = extractJSON(text);
    if (!Array.isArray(parsed.lines)) parsed.lines = [];
    return parsed;
  }

  if (name.endsWith(".pdf")) {
    const base64 = await fileToBase64(file);
    const res = await fetch("/api/groq", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_tokens: 3000, system: EXTRACT_SYSTEM, // model chosen server-side by api/groq.js
        messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }, { type: "text", text: "Extract the quotation line items from this PDF." }] }],
        responseSchema: SCHEMA_QUOTATION_EXTRACTION }),
    });
    if (!res.ok) throw new Error(await extractErrorMessage(res, "PDF extraction request failed"));
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const parsed = extractJSON(text);
    if (!Array.isArray(parsed.lines)) parsed.lines = [];
    return parsed;
  }

  if (name.endsWith(".docx")) {
    const buf = await file.arrayBuffer();
    const { value: docText } = await mammoth.extractRawText({ arrayBuffer: buf });
    if (!docText.trim()) throw new Error("Could not extract any text from this Word document.");
    const { text } = await callClaude({ system: EXTRACT_SYSTEM, prompt: `Extract quotation line items from this document text:\n${docText.slice(0, 8000)}`, maxTokens: 3000, responseSchema: SCHEMA_QUOTATION_EXTRACTION });
    const parsed = extractJSON(text);
    if (!Array.isArray(parsed.lines)) parsed.lines = [];
    return parsed;
  }

  if (file.type.startsWith("image/")) {
    const base64 = await fileToBase64(file);
    const res = await fetch("/api/groq", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_tokens: 3000, system: EXTRACT_SYSTEM, // model chosen server-side by api/groq.js
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: file.type, data: base64 } }, { type: "text", text: "Extract the quotation line items from this image/screenshot." }] }],
        responseSchema: SCHEMA_QUOTATION_EXTRACTION }),
    });
    if (!res.ok) throw new Error(await extractErrorMessage(res, "Image extraction request failed"));
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const parsed = extractJSON(text);
    if (!Array.isArray(parsed.lines)) parsed.lines = [];
    return parsed;
  }

  throw new Error("Unsupported file type. Use .xlsx, .csv, .pdf, .docx, or an image.");
}

function ProcurementAuditor({ state, setState, pushAudit }) {
  const [file, setFile] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [lines, setLines] = useState(null); // editable extracted lines, pre-audit
  const [auditing, setAuditing] = useState(false);
  const [auditProgress, setAuditProgress] = useState(null);
  const [results, setResults] = useState(null); // audited lines
  const [verdictFilter, setVerdictFilter] = useState("ALL");
  const [vendorFilter, setVendorFilter] = useState("ALL");
  const fileRef = useRef();

  const handleFile = async (f) => {
    setFile(f); setExtractError(""); setLines(null); setResults(null); setExtracting(true);
    try {
      const extracted = await extractQuotationLines(f);
      const withIds = (extracted.lines || []).map((l) => ({ ...l, _id: uid("qline"), vendor: l.vendor || extracted.vendor || "" }));
      if (!withIds.length) setExtractError("No line items could be extracted from this file — check it actually contains a quotation table.");
      setLines(withIds);
    } catch (e) {
      setExtractError(e.message || "Extraction failed.");
    } finally {
      setExtracting(false);
    }
  };

  const updateLine = (id, patch) => setLines((ls) => ls.map((l) => (l._id === id ? { ...l, ...patch } : l)));
  const removeLine = (id) => setLines((ls) => ls.filter((l) => l._id !== id));

  const runAudit = async () => {
    if (!lines || !lines.length) return;
    setAuditing(true);
    setResults(null);
    const audited = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      setAuditProgress({ current: i + 1, total: lines.length, item: line.product });
      const matched = state.products.find((p) => normalizeToken(p.name) === normalizeToken(line.product)) ||
        state.products.find((p) => { const check = isDuplicateCandidate({ name: line.product, category: p.category }, p); return check.dup; });
      const historyStats = matched ? purchaseHistoryStats(state.transactions.filter((t) => t.productId === matched.id)) : null;

      let marketEvidence = null, err = null;
      try {
        marketEvidence = await researchProductSources([line.brand, line.model, line.product, line.specification].filter(Boolean).join(" "));
      } catch (e) { err = e.message; }

      const unitPrice = line.unitPrice ?? (line.total && line.qty ? line.total / line.qty : null);
      const auditResult = unitPrice != null ? auditQuotationLine({ quotedUnitPrice: unitPrice, qty: line.qty || 1, historyStats, marketFindings: marketEvidence?.findings || [] })
        : { verdict: "NO PRICE PROVIDED", notes: "This line has no unit price to audit." };
      // If the market-research call itself failed (e.g. AI quota/rate limit),
      // say so explicitly instead of silently showing "insufficient market
      // evidence" as if nothing went wrong — those are different situations
      // and only one of them means "there's genuinely no data out there."
      if (err) auditResult.notes = `Market research call failed: ${err}`;

      audited.push({ ...line, matchedProductId: matched?.id || null, matchedProductName: matched?.name || null, historyStats, marketEvidence, marketError: err, audit: auditResult, unitPriceUsed: unitPrice });

      // small pause between lines — free-tier AI APIs rate-limit aggressively,
      // and auditing several lines back-to-back with zero delay is the
      // single most common way to trip that limit mid-run
      if (i < lines.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
    setAuditProgress(null);
    setAuditing(false);
    setResults(audited);
    const totalQuoted = audited.reduce((s, r) => s + (r.unitPriceUsed || 0) * (r.qty || 1), 0);
    const totalOverpay = audited.reduce((s, r) => s + (r.audit.overpayTotalMax || 0), 0);
    pushAudit("Procurement Auditor", `Audited ${audited.length} quotation line(s) from "${file?.name}". Total quoted ≈ ${fmtPKR(totalQuoted)}. Potential overpayment up to ${fmtPKR(totalOverpay)}.`);
  };

  const vendors = useMemo(() => [...new Set((results || []).map((r) => r.vendor).filter(Boolean))], [results]);
  const filtered = (results || []).filter((r) => (verdictFilter === "ALL" || r.audit.verdict === verdictFilter) && (vendorFilter === "ALL" || r.vendor === vendorFilter));

  const summary = useMemo(() => {
    if (!results) return null;
    const totalQuoted = results.reduce((s, r) => s + (r.unitPriceUsed || 0) * (r.qty || 1), 0);
    const totalFairMax = results.reduce((s, r) => s + ((r.audit.fairMax ?? r.unitPriceUsed) || 0) * (r.qty || 1), 0);
    const totalOverpayMax = results.reduce((s, r) => s + (r.audit.overpayTotalMax || 0), 0);
    const totalOverpayMin = results.reduce((s, r) => s + (r.audit.overpayTotalMin || 0), 0);
    const savingLines = results.filter((r) => r.audit.verdict === "BELOW MARKET — verify authenticity/spec before trusting");
    return {
      totalQuoted, totalFairMax, totalOverpayMin, totalOverpayMax,
      aboveMarket: results.filter((r) => r.audit.verdict === "ABOVE MARKET").length,
      withinMarket: results.filter((r) => r.audit.verdict === "WITHIN MARKET").length,
      insufficient: results.filter((r) => r.audit.verdict === "INSUFFICIENT MARKET EVIDENCE").length,
      belowMarket: savingLines.length,
    };
  }, [results]);

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h2 className="px-font-display text-lg font-semibold">📊 Procurement Auditor</h2>
        <p className="text-sm text-[var(--muted)] mt-1 max-w-2xl">Upload a vendor quotation — Excel, CSV, PDF, a photo/screenshot, or a Word doc. Every line gets checked against your purchase history and live market pricing, with sources shown for every price claim. No evidence, no verdict — it says so instead of guessing.</p>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.pdf,.docx,image/*" className="hidden" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
        <Btn variant="primary" className="mt-4" onClick={() => fileRef.current.click()} disabled={extracting}>{extracting ? "Extracting…" : "Upload quotation"}</Btn>
        {file && <span className="ml-3 text-xs text-[var(--muted)] px-font-mono">{file.name}</span>}
        {extractError && <div className="mt-3 text-sm text-[var(--danger)]">⚠ {extractError}</div>}
      </Card>

      {lines && lines.length > 0 && !results && (
        <Card className="p-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="px-font-display font-semibold">Extracted lines — review before auditing</h3>
            <span className="text-xs text-[var(--muted)] px-font-mono">{lines.length} line(s)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[var(--muted)] px-font-mono uppercase">
                <tr><th className="text-left pb-2 pr-2">Product</th><th className="text-left pb-2 pr-2">Brand/Model</th><th className="text-left pb-2 pr-2">Spec</th><th className="text-right pb-2 pr-2">Qty</th><th className="text-left pb-2 pr-2">Vendor</th><th className="text-right pb-2 pr-2">Unit Price</th><th className="text-right pb-2 pr-2">Tax</th><th className="pb-2"></th></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l._id} className="border-t border-[var(--border)]">
                    <td className="py-1 pr-2"><input value={l.product} onChange={(e) => updateLine(l._id, { product: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded px-2 py-1 w-full" /></td>
                    <td className="py-1 pr-2"><input value={[l.brand, l.model].filter(Boolean).join(" ")} onChange={(e) => updateLine(l._id, { brand: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded px-2 py-1 w-full" /></td>
                    <td className="py-1 pr-2"><input value={l.specification || ""} onChange={(e) => updateLine(l._id, { specification: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded px-2 py-1 w-full" /></td>
                    <td className="py-1 pr-2"><input type="number" value={l.qty ?? ""} onChange={(e) => updateLine(l._id, { qty: Number(e.target.value) })} className="bg-[var(--panel2)] border border-[var(--border)] rounded px-2 py-1 w-16 text-right" /></td>
                    <td className="py-1 pr-2"><input value={l.vendor || ""} onChange={(e) => updateLine(l._id, { vendor: e.target.value })} className="bg-[var(--panel2)] border border-[var(--border)] rounded px-2 py-1 w-full" /></td>
                    <td className="py-1 pr-2"><input type="number" value={l.unitPrice ?? ""} onChange={(e) => updateLine(l._id, { unitPrice: Number(e.target.value) })} className="bg-[var(--panel2)] border border-[var(--border)] rounded px-2 py-1 w-24 text-right" /></td>
                    <td className="py-1 pr-2"><input type="number" value={l.tax ?? ""} onChange={(e) => updateLine(l._id, { tax: Number(e.target.value) })} className="bg-[var(--panel2)] border border-[var(--border)] rounded px-2 py-1 w-16 text-right" /></td>
                    <td className="py-1"><button onClick={() => removeLine(l._id)} className="text-[var(--danger)] text-xs">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Btn variant="primary" className="mt-4" onClick={runAudit} disabled={auditing}>{auditing ? "Auditing…" : `Run audit on ${lines.length} line(s)`}</Btn>
          {auditProgress && <div className="mt-2 text-xs text-[var(--muted)] px-font-mono">Researching {auditProgress.current}/{auditProgress.total}: {auditProgress.item}…</div>}
        </Card>
      )}

      {summary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Total Quoted Value" value={fmtPKR(summary.totalQuoted)} />
            <StatCard label="Estimated Fair Value" value={fmtPKR(summary.totalFairMax)} />
            <StatCard label="Potential Overpayment" value={`${fmtPKR(summary.totalOverpayMin)} – ${fmtPKR(summary.totalOverpayMax)}`} tone="danger" />
            <StatCard label="Above / Within / Insufficient" value={`${summary.aboveMarket} / ${summary.withinMarket} / ${summary.insufficient}`} />
          </div>

          <Card className="p-4">
            <div className="flex flex-wrap gap-3 items-center">
              <span className="text-xs text-[var(--muted)]">Filter:</span>
              <select value={verdictFilter} onChange={(e) => setVerdictFilter(e.target.value)} className="bg-[var(--panel2)] border border-[var(--border)] rounded px-2 py-1 text-xs">
                <option value="ALL">All verdicts</option>
                <option value="ABOVE MARKET">Above Market</option>
                <option value="WITHIN MARKET">Within Market</option>
                <option value="BELOW MARKET — verify authenticity/spec before trusting">Below Market</option>
                <option value="INSUFFICIENT MARKET EVIDENCE">Insufficient Evidence</option>
              </select>
              {vendors.length > 1 && (
                <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} className="bg-[var(--panel2)] border border-[var(--border)] rounded px-2 py-1 text-xs">
                  <option value="ALL">All vendors</option>
                  {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] px-font-mono text-xs uppercase">
                <tr><th className="text-left p-3">Product</th><th className="text-left p-3">Vendor</th><th className="text-right p-3">Quoted</th><th className="text-right p-3">Historical</th><th className="text-right p-3">Market</th><th className="text-right p-3">Saving/Overpay</th><th className="text-left p-3">Verdict</th></tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r._id} className="border-t border-[var(--border)] hover:bg-[var(--panel2)]/50 align-top">
                    <td className="p-3">
                      <div>{r.product}</div>
                      {r.matchedProductName && <div className="text-[10px] text-[var(--cyan)]">matched: {r.matchedProductName}</div>}
                    </td>
                    <td className="p-3 text-[var(--muted)]">{r.vendor || "—"}</td>
                    <td className="p-3 text-right px-font-mono">{r.unitPriceUsed ? fmtPKR(r.unitPriceUsed) : "—"}</td>
                    <td className="p-3 text-right px-font-mono text-[var(--muted)]">{r.historyStats ? fmtPKR(r.historyStats.avg) : "no history"}</td>
                    <td className="p-3 text-right px-font-mono text-[var(--muted)]">{r.audit.marketMin ? `${fmtPKR(r.audit.marketMin)}–${fmtPKR(r.audit.marketMax)}` : "—"}</td>
                    <td className="p-3 text-right px-font-mono">{r.audit.overpayTotalMax ? `${fmtPKR(r.audit.overpayTotalMin)}–${fmtPKR(r.audit.overpayTotalMax)}` : "—"}</td>
                    <td className="p-3"><Badge tone={r.marketError ? "critical" : r.audit.verdict === "ABOVE MARKET" ? "critical" : r.audit.verdict === "WITHIN MARKET" ? "healthy" : r.audit.verdict.startsWith("BELOW") ? "info" : "default"}>{r.marketError ? "RESEARCH FAILED" : r.audit.verdict}</Badge>
                      {r.marketError && <div className="text-[10px] text-[var(--danger)] mt-1 max-w-xs">{r.marketError}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {filtered.map((r) => r.marketEvidence?.findings?.length > 0 && (
            <details key={r._id + "_src"} className="text-xs text-[var(--muted)] px-2">
              <summary className="cursor-pointer">{r.product} — sources ({r.marketEvidence.findings.length})</summary>
              <div className="mt-1 space-y-1 pl-3">
                {r.marketEvidence.findings.map((f, i) => (
                  <div key={i} className="px-font-mono">{f.vendor}: {f.price ? fmtPKR(f.price) : "—"} {f.sourceUrl && <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--cyan)] underline">source</a>} ({f.dateChecked || "n/a"}, {f.confidence}% confidence)</div>
                ))}
              </div>
            </details>
          ))}
        </>
      )}
    </div>
  );
}


// ============================================================
// APP SHELL
// ============================================================
const TABS = [
  ["dashboard", "Dashboard"], ["photo", "📷 Procure by Photo"], ["auditor", "📊 Procurement Auditor"], ["inventory", "Store / Inventory"],
  ["approvals", "Approvals"], ["products", "Product Master"], ["history", "Purchase History"],
  ["vendors", "Vendors"], ["market", "Market Research"], ["rfq", "RFQ"], ["quotations", "Quotations"],
  ["import", "Import Center"], ["sheets", "Import from Sheets"], ["audit", "Audit Log"], ["technician", "Technician Mode"],
  ["settings", "⚙️ Settings"],
];

// ============================================================
// SETTINGS — AI Connection Test
// One minimal request through the real /api/groq route, showing exactly
// what a live request returns: provider, the actual model Groq used
// (chosen server-side), and connection status. Never touches or displays
// the API key itself.
// ============================================================
function SettingsPanel() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null); // { status: "connected"|"failed", model, detail }

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch("/api/groq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system: "Reply with exactly one word: OK.", messages: [{ role: "user", content: "Connection test." }], max_tokens: 10 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ status: "failed", detail: data?.error || `HTTP ${res.status}` });
        return;
      }
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      // model isn't in the response body (the adapter deliberately keeps
      // the response shape provider-neutral) — infer which model handled
      // a plain text-only request the same way api/groq.js does, purely
      // for display purposes here.
      const inferredModel = "openai/gpt-oss-20b";
      setResult({ status: text ? "connected" : "failed", model: inferredModel, detail: text || "Empty response" });
    } catch (e) {
      setResult({ status: "failed", detail: e.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h2 className="px-font-display text-lg font-semibold">⚙️ Settings</h2>
        <p className="text-sm text-[var(--muted)] mt-1 max-w-2xl">AI Connection Test — sends one minimal real request through the server-side Groq proxy. Never displays or exposes the API key.</p>
        <Btn variant="primary" className="mt-4" onClick={runTest} disabled={testing}>{testing ? "Testing…" : "Run connection test"}</Btn>

        {result && (
          <div className="mt-4 space-y-1 px-font-mono text-sm">
            <div>AI Provider: <span className="text-[var(--text)]">Groq</span></div>
            <div>Model: <span className="text-[var(--text)]">{result.model || "unknown (request failed before model was used)"}</span></div>
            <div>Connection: <Badge tone={result.status === "connected" ? "healthy" : "critical"}>{result.status === "connected" ? "CONNECTED" : "FAILED"}</Badge></div>
            {result.status === "failed" && <div className="text-[var(--danger)] mt-2">{result.detail}</div>}
          </div>
        )}
      </Card>
      <Card className="p-4">
        <div className="text-xs text-[var(--muted)]">
          If this fails, check: (1) <code>GROQ_API_KEY</code> is set in Vercel → Settings → Environment Variables, (2) you redeployed after adding/changing it (env var changes never apply to existing deployments), (3) the key is valid and has remaining quota at <a href="https://console.groq.com" target="_blank" rel="noreferrer" className="text-[var(--cyan)] underline">console.groq.com</a>.
        </div>
      </Card>
    </div>
  );
}

export default function DisruptProcureApp() {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [loaded, setLoaded] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const justLoadedRef = useRef(false);

  useEffect(() => {
    (async () => {
      const saved = await loadState();
      const loaded = saved || seedDemoData();
      if (!loaded.sheetsConfig) loaded.sheetsConfig = { spreadsheetId: "1ZfQherwjylV302cTWyiS8_TsAZMKzwKei8JxjsonK-A", tabName: "HFM Store", apiKey: "", lastSyncedAt: null, syncStatus: "never", recordsImported: null, lastError: null };
      setState(loaded);
      justLoadedRef.current = true; // skip the very next save — it would just echo what we loaded
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded || !state) return;
    if (justLoadedRef.current) { justLoadedRef.current = false; return; }
    saveState(state);
  }, [state, loaded]);

  const pushAudit = useCallback((action, detail) => {
    setState((s) => ({ ...s, auditLog: [...s.auditLog, { id: uid("aud"), ts: nowISO(), actor: "System/AI", action, detail }] }));
  }, []);

  if (!state) {
    return (
      <div className="min-h-screen bg-[var(--void)] flex items-center justify-center text-[var(--muted)] px-font-mono text-sm">
        <FontStyle />
        <div className="flex items-center gap-3"><span className="animate-pulse">●</span> Loading DISRUPT PROCURE AI…</div>
      </div>
    );
  }

  const resetDemo = () => { if (confirm("Replace all data with the initial HFM Store dataset? This cannot be undone.")) setState(seedDemoData()); };

  const NavLinks = ({ onNavigate }) => (
    <>
      {TABS.map(([k, label]) => (
        <button key={k} onClick={() => { setTab(k); onNavigate && onNavigate(); }}
          className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${tab === k ? "bg-[var(--panel2)] text-[var(--amber)] border border-[var(--amber-dim)]" : "text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel2)]/60"}`}>
          {label}
        </button>
      ))}
    </>
  );

  return (
    <div className="min-h-screen bg-[var(--void)] text-[var(--text)] px-font-body flex flex-col md:flex-row">
      <FontStyle />

      {/* mobile top bar */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 border-b border-[var(--border)] sticky top-0 bg-[var(--void)] z-20">
        <div className="px-font-display font-bold text-lg">DISRUPT <span className="text-[var(--amber)]">PROCURE AI</span></div>
        <button onClick={() => setNavOpen(!navOpen)} className="text-[var(--text)] text-xl px-2" aria-label="Menu">{navOpen ? "✕" : "☰"}</button>
      </div>
      {navOpen && (
        <div className="md:hidden border-b border-[var(--border)] p-3 space-y-1 bg-[var(--panel)] sticky top-[49px] z-20 max-h-[70vh] overflow-y-auto px-scroll">
          <NavLinks onNavigate={() => setNavOpen(false)} />
          <button onClick={resetDemo} className="text-[10px] text-[var(--muted)] hover:text-[var(--danger)] mt-2 text-left px-font-mono block">Reset to initial dataset</button>
        </div>
      )}

      {/* desktop sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 border-r border-[var(--border)] p-4 flex-col">
        <div className="px-font-display font-bold text-lg mb-0.5 leading-tight">DISRUPT<br /><span className="text-[var(--amber)]">PROCURE AI</span></div>
        <div className="text-[10px] text-[var(--muted)] px-font-mono mb-6">AI PROCUREMENT INTELLIGENCE</div>
        <nav className="space-y-1 flex-1 overflow-y-auto px-scroll">
          <NavLinks />
        </nav>
        <button onClick={resetDemo} className="text-[10px] text-[var(--muted)] hover:text-[var(--danger)] mt-4 text-left px-font-mono">Reset to initial dataset</button>
      </aside>

      <main className="flex-1 p-4 md:p-8 overflow-y-auto px-scroll md:max-h-screen">
        {tab === "dashboard" && <Dashboard state={state} setTab={setTab} />}
        {tab === "photo" && <ProcureByPhoto state={state} setState={setState} pushAudit={pushAudit} />}
        {tab === "auditor" && <ProcurementAuditor state={state} setState={setState} pushAudit={pushAudit} />}
        {tab === "import" && <ImportCenter state={state} setState={setState} pushAudit={pushAudit} />}
        {tab === "sheets" && <GoogleSheetsSync state={state} setState={setState} pushAudit={pushAudit} />}
        {tab === "products" && <ProductMaster state={state} />}
        {tab === "inventory" && <Inventory state={state} setState={setState} pushAudit={pushAudit} />}
        {tab === "history" && <PurchaseHistory state={state} />}
        {tab === "vendors" && <Vendors state={state} />}
        {tab === "market" && <MarketResearch pushAudit={pushAudit} />}
        {tab === "rfq" && <RFQBoard state={state} setState={setState} pushAudit={pushAudit} />}
        {tab === "quotations" && <Quotations state={state} setState={setState} pushAudit={pushAudit} />}
        {tab === "approvals" && <Approvals state={state} setState={setState} pushAudit={pushAudit} />}
        {tab === "audit" && <AuditLog state={state} />}
        {tab === "technician" && <TechnicianMode state={state} setState={setState} pushAudit={pushAudit} />}
        {tab === "settings" && <SettingsPanel />}
      </main>
    </div>
  );
}
