/* ============================================================
   ProcureX AI — core logic (pure functions, no React/DOM deps)
   This file is the single source of truth for calculation logic.
   The shipped app (procurex-ai.jsx) inlines these exact functions
   (artifacts must be single-file) — keep them byte-for-byte in
   sync when either changes.
   ============================================================ */

// ---------- text normalization ----------
function normalizeToken(s) {
  // Replace punctuation with a SPACE (not delete) so "Reason/Purpose"
  // tokenizes as {reason, purpose}, not the single glued token
  // "reasonpurpose". Deleting punctuation was the original bug.
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

// spec-carrying tokens: numeric/alnum codes like 32a, 2p, 45uf, 400v, m10
function specTokens(s) {
  return new Set([...tokenSet(s)].filter((t) => /^[a-z]*\d+[a-z]*$/.test(t)));
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// ---------- robust number parsing ----------
// Handles "4,650", "Rs. 4,650.50", "PKR 200", "-5", "", null, undefined
function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === "") return null;
  s = s.replace(/,/g, ""); // strip thousands separators before anything else
  s = s.replace(/[^0-9.\-]/g, ""); // strip currency letters/symbols ("Rs.", "PKR", "/-")
  if (s === "" || s === "-" || s === ".") return null;
  const parts = s.split(".");
  if (parts.length > 2) s = parts.slice(0, -1).join("") + "." + parts[parts.length - 1]; // collapse stray dots (e.g. from "Rs.")
  const n = Number(s);
  return isFinite(n) ? n : null;
}

// ---------- column mapping ----------
// current_stock (item-level snapshot) and txn_quantity (per-transaction
// movement) are DELIBERATELY separate fields — the original build
// conflated "Current Stock" and "Quantity" into one field, which
// silently corrupted stock levels on any transaction-log-style sheet
// (the real HFM sheet has both as distinct columns).
const SCHEMA_SYNONYMS = {
  product_name: ["item", "product", "material", "description", "item name", "item description", "product name"],
  category: ["category", "cat", "item type"],
  current_stock: ["current stock", "current qty", "closing stock"],
  txn_quantity: ["qty", "quantity"],
  min_stock: ["minimum stock", "min stock", "reorder level", "min qty", "minimum"],
  unit_price: ["unit price", "unit cost", "rate", "purchase price"], // per-transaction cost only
  avg_cost_snapshot: ["average unit cost", "avg unit cost"], // item-level valuation snapshot — must NOT trigger transaction creation
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

// detect >1 source header mapped to the same canonical field, which
// silently overwrote data (last-wins) in the original build
function findMappingCollisions(headers, mapping) {
  const byField = {};
  headers.forEach((h) => {
    const f = mapping[h]?.field;
    if (!f) return;
    (byField[f] = byField[f] || []).push(h);
  });
  return Object.entries(byField).filter(([, hs]) => hs.length > 1);
}

// ---------- stock intelligence ----------
function computeStockHealth(current, min, monthlyConsumption) {
  const cur = toNumber(current);
  const minS = toNumber(min) || 0;
  const cons = toNumber(monthlyConsumption) || 0;
  if (cur === null) return { state: "UNKNOWN", coverageMonths: null };
  if (cur < 0) return { state: "DATA ERROR", coverageMonths: null }; // negative stock is a data integrity issue, not a restock urgency
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

// ---------- vendor scoring ----------
function vendorScore(v) {
  const w = { reliability: 0.3, delivery: 0.25, quality: 0.25, price: 0.2 };
  return Math.round(
    (v.reliability || 0) * w.reliability +
    (v.delivery || 0) * w.delivery +
    (v.quality || 0) * w.quality +
    (v.priceCompetitiveness || 0) * w.price
  );
}

// ---------- duplicate-product detection ----------
// Name similarity ALONE is not sufficient (spec explicitly warns
// against this). Two products with high name overlap but DIFFERING
// spec tokens (32A vs 16A, 1P vs 2P) or differing unit-of-measure
// are genuinely different products and must not be flagged.
function isDuplicateCandidate(a, b) {
  if (a.category && b.category && a.category !== b.category) return { dup: false, reason: "different category" };
  const nameSim = jaccard(a.name, b.name);
  if (nameSim < 0.55) return { dup: false, reason: "low name similarity" };
  const specA = specTokens(a.name), specB = specTokens(b.name);
  if (specA.size && specB.size && !setsEqual(specA, specB)) {
    return { dup: false, reason: "differing spec tokens: " + [...specA].join(",") + " vs " + [...specB].join(",") };
  }
  if (a.uom && b.uom && a.uom !== b.uom) return { dup: false, reason: "different unit of measure" };
  return { dup: true, similarity: Math.round(nameSim * 100) };
}

// ---------- import merge (handles transaction-log-style sheets) ----------
// Takes raw parsed rows + confirmed header->field mapping + the
// products already in state, and returns a NEW products array and
// NEW transactions array (no mutation of inputs). Repeated rows for
// the same item (a real transaction ledger) merge into ONE product
// record instead of creating a duplicate per row — this was the
// most severe bug in the original build.
// parses a star-rating cell ("⭐⭐⭐⭐⭐") or a plain number; returns null if neither
function parseRating(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const stars = (s.match(/⭐|★/g) || []).length;
  if (stars > 0) return stars;
  return toNumber(v);
}

// flags vendor names that look like unfilled placeholder text rather than
// a real company name (e.g. "Vendor A") — surfaced for human verification,
// never silently treated as a confirmed real vendor
function looksLikePlaceholderVendor(name) {
  return /^vendor\s*[a-z0-9]{1,3}$/i.test(String(name || "").trim());
}

// ---------- current stock: ALWAYS derived, never a stored/editable field ----------
// Sums every IN/OUT/ADJUSTMENT transaction for a product. Returns null (not 0)
// when there is no transaction history at all — "no data" and "genuinely
// zero" are different facts and must not be conflated.
function computeCurrentStock(productId, transactions) {
  const relevant = transactions.filter((t) => t.productId === productId && ["IN", "OUT", "ADJUSTMENT"].includes(t.type));
  if (!relevant.length) return null;
  let total = 0;
  relevant.forEach((t) => {
    const q = Number(t.qty) || 0;
    total += t.type === "OUT" ? -q : q; // ADJUSTMENT qty is a signed correction, added directly
  });
  return total;
}

// ---------- issue-stock guard ----------
// Pure decision function: does NOT mutate anything, just tells the caller
// whether the requested OUT quantity is coverable by what's actually on
// record, so the UI can require an explicit override before going negative.
function validateIssueQuantity(productId, transactions, requestedQty) {
  const available = computeCurrentStock(productId, transactions);
  const qty = Number(requestedQty) || 0;
  if (available === null) return { available: null, wouldGoNegative: true, resultingStock: -qty, allowedWithoutOverride: false };
  const resultingStock = available - qty;
  return { available, wouldGoNegative: resultingStock < 0, resultingStock, allowedWithoutOverride: resultingStock >= 0 };
}

// ---------- procurement lifecycle stage (derived, not stored) ----------
// Stock Alert -> AI Research -> RFQ -> Quotations -> Comparison ->
// AI Recommendation -> Manager Approval -> Approved -> Purchased -> Received -> Audited
// Computed from what's actually on the request object + how many real
// quotations exist for it, so it can never drift out of sync with reality.
function computeProcurementStage(rfq, quotationsCount = 0) {
  if (!rfq) return "Stock Alert";
  if (rfq.audit) return "Audited";
  if (rfq.receivedTransactionId) return "Received";
  if (rfq.purchase) return "Purchased";
  if (rfq.status === "APPROVED" || rfq.status === "APPROVED (OVERRIDE)") return "Approved";
  if (rfq.status === "CLOSED" || rfq.status === "REJECTED") return "Manager Approval"; // rejected — decision made, loop ends here
  if (rfq.benchmark) return "AI Recommendation";
  if (quotationsCount > 1) return "Comparison";
  if (quotationsCount === 1) return "Quotations";
  if (rfq.message) return "RFQ";
  if (rfq.marketEvidence) return "AI Research";
  return "Stock Alert";
}

function buildImportPlan(headers, rows, mapping, existingProducts, existingTransactions, sourceLabel) {
  const productIndex = new Map(); // normalized name -> product (cloned)
  existingProducts.forEach((p) => productIndex.set(normalizeToken(p.name), { ...p }));

  const newTransactions = [];
  const warnings = [];
  const declaredStock = new Map(); // productId -> last non-blank "current stock" value seen in THIS import
  let skippedBlank = 0, skippedNoName = 0, txCreated = 0;

  rows.forEach((row, rowIdx) => {
    const allBlank = headers.every((h) => String(row[h] ?? "").trim() === "");
    if (allBlank) { skippedBlank++; return; }

    const rec = {};
    headers.forEach((h) => {
      const target = mapping[h]?.field;
      if (target) rec[target] = row[h];
    });

    const name = String(rec.product_name || "").trim();
    if (!name) { skippedNoName++; return; }

    const key = normalizeToken(name);
    let product = productIndex.get(key);
    if (!product) {
      // NOTE: no current_stock field here at all — stock is never stored,
      // only ever derived from transactions via computeCurrentStock().
      product = {
        id: "prod_" + key.replace(/\s+/g, "_") + "_" + rowIdx,
        name, normalized_name: key, category: rec.category || "Uncategorized",
        subcategory: "", brand: "", uom: "pcs", min_stock: null, preferred_vendor: "",
        confidence: 100, source: sourceLabel,
      };
      productIndex.set(key, product);
    }

    // item-level snapshot fields: "last non-blank wins" (a ledger sheet
    // typically repeats these per row; only overwrite when a real value
    // is present, so a blank cell on a later row can't erase a known value)
    const curVal = toNumber(rec.current_stock);
    if (curVal !== null) declaredStock.set(product.id, curVal);
    const minVal = toNumber(rec.min_stock);
    if (minVal !== null) product.min_stock = minVal;
    if (rec.stock_status_source) product.source_stock_status = String(rec.stock_status_source);
    if (rec.total_in !== undefined && toNumber(rec.total_in) !== null) product.total_in = toNumber(rec.total_in);
    if (rec.total_out !== undefined && toNumber(rec.total_out) !== null) product.total_out = toNumber(rec.total_out);
    const avgSnap = toNumber(rec.avg_cost_snapshot);
    if (avgSnap !== null) product.avg_cost_snapshot = avgSnap; // valuation figure only — never treated as a transaction

    // transaction-level fields: create a transaction row only when there's
    // real transaction evidence (a movement qty, or a priced/vendored event).
    // NOTE: avg_cost_snapshot deliberately does NOT count as transaction
    // evidence — it's an item-level valuation figure, not a purchase event.
    const txQty = toNumber(rec.txn_quantity);
    const unitCost = toNumber(rec.unit_price);
    const hasTxSignal = txQty !== null || unitCost !== null || rec.vendor || rec.transaction_date;
    if (hasTxSignal) {
      if (unitCost === null) warnings.push(`Row ${rowIdx + 2}: "${name}" has no unit price — logged without cost.`);
      if (!rec.vendor) warnings.push(`Row ${rowIdx + 2}: "${name}" has no vendor — logged without vendor.`);
      if (rec.vendor && looksLikePlaceholderVendor(rec.vendor)) warnings.push(`Row ${rowIdx + 2}: "${name}" — vendor "${rec.vendor}" looks like placeholder text, not a confirmed real vendor name.`);
      newTransactions.push({
        id: "tx_" + key.replace(/\s+/g, "_") + "_" + rowIdx,
        productId: product.id,
        vendorName: rec.vendor || "",
        type: rec.transaction_type || (txQty !== null && txQty < 0 ? "OUT" : "IN"),
        qty: txQty !== null ? Math.abs(txQty) : 1,
        unitCost: unitCost,
        date: rec.transaction_date || null,
        person: rec.person || "",
        reason: rec.reason || rec.remarks || "",
        rating: parseRating(rec.rating),
        source: sourceLabel,
      });
      txCreated++;
    }
  });

  // Reconciliation pass — current stock is NEVER set directly, even from a
  // trusted source sheet, and a declared snapshot is NEVER allowed to
  // silently overrule what the real transaction ledger shows. Two cases:
  //  - no transaction evidence exists at all for this product -> seed a
  //    single, clearly-labeled opening-balance ADJUSTMENT from the
  //    declared value (there's nothing to disagree with).
  //  - real transactions DO exist but their net doesn't match the
  //    declared snapshot -> do NOT fabricate an adjustment to force
  //    agreement (that would just be a different flavor of overwriting
  //    reality). Surface it as a warning instead and let the real,
  //    derived transaction total stand as the honest current stock.
  declaredStock.forEach((declared, productId) => {
    const combined = [...existingTransactions, ...newTransactions].filter((t) => t.productId === productId);
    const derived = computeCurrentStock(productId, combined);
    if (derived === null) {
      newTransactions.push({
        id: "tx_adj_" + productId + "_" + Math.round(Math.random() * 1e9),
        productId, vendorName: "", type: "ADJUSTMENT", qty: declared, unitCost: null,
        date: null, person: "Import", reason: `Opening balance — no transaction history available; taken from the source's stated current stock (${declared}) at import.`,
        rating: null, source: sourceLabel,
      });
      txCreated++;
    } else if (derived !== declared) {
      const product = [...productIndex.values()].find((p) => p.id === productId);
      const productName = product ? product.name : productId;
      warnings.push(`"${productName}": source sheet states current stock ${declared}, but the transaction ledger implies ${derived}. NOT auto-adjusted — investigate the discrepancy (a stale snapshot or a missing movement) before trusting either number. Current stock shown will be the transaction-derived value (${derived}).`);
    }
  });

  return {
    products: [...productIndex.values()],
    transactions: newTransactions,
    stats: { rowsProcessed: rows.length, skippedBlank, skippedNoName, txCreated, productsTouched: productIndex.size },
    warnings,
  };
}

// ---------- price intelligence (GST-aware) ----------
// A raw unit-price comparison across vendors is misleading when GST
// terms differ (0% vs 17%) — must compare on an effective, tax-inclusive
// basis. The original comparison screen ranked on raw unitPrice only.
function effectiveUnitPrice(quote) {
  const unit = toNumber(quote.unitPrice) || 0;
  const gst = toNumber(quote.gst) || 0;
  return unit * (1 + gst / 100);
}

function rankQuotations(quotes) {
  const withEff = quotes.map((q) => ({ ...q, effectiveUnitPrice: effectiveUnitPrice(q) }));
  const minEff = Math.min(...withEff.map((q) => q.effectiveUnitPrice));
  return withEff.map((q) => ({
    ...q,
    isBestPrice: q.effectiveUnitPrice === minEff,
    isOverpriced: q.effectiveUnitPrice > minEff * 1.15,
  }));
}

function purchaseHistoryStats(transactions) {
  const priced = transactions.filter((t) => t.unitCost !== null && t.unitCost !== undefined && !isNaN(t.unitCost));
  if (!priced.length) return null;
  const prices = priced.map((t) => t.unitCost);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const sorted = [...priced].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return { count: priced.length, avg, min: Math.min(...prices), max: Math.max(...prices), last: sorted[0].unitCost, lastDate: sorted[0].date };
}

// ---------- multi-table detection (spec: "Detect tables") ----------
// Real spreadsheets often pack more than one logical table into a single
// tab, side by side, with blank spacer columns between them (exactly what
// the client's actual "HFM Store" tab does: an item-master table and a
// transactions table share the same rows but sit in different, unrelated
// column ranges — they are NOT row-aligned by item). This scans a raw
// 2D grid (rows of cell strings, as returned by Sheets API values.get)
// and finds each such block independently, with no hardcoded row/column
// numbers, so it generalizes beyond this one sheet.
function detectTableBlocks(grid) {
  const blocks = [];
  grid.forEach((row, r) => {
    if (!row) return;
    // split the row into runs of CONTIGUOUS non-blank header cells — a truly
    // blank cell is what actually separates two side-by-side tables (this
    // sheet has exactly one blank spacer column between its item-master
    // and transactions tables; a fuzzy "allow a small index gap" heuristic
    // here previously merged them into one bogus block)
    const runs = [];
    let current = [];
    for (let c = 0; c < row.length; c++) {
      const text = row[c] === null || row[c] === undefined ? "" : String(row[c]).trim();
      if (text) current.push(c); else { if (current.length) runs.push(current); current = []; }
    }
    if (current.length) runs.push(current);

    runs.forEach((cols) => {
      const hits = cols.filter((c) => { const m = mapColumn(row[c]); return m.field && m.confidence >= 55; });
      if (hits.length < 2) return; // not enough recognizable columns to be a real table header
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
// Every category the spec asks for. Nothing here is invented — each
// finding is a direct, explainable observation over the actual imported
// data, never a guess at what the "correct" value should have been.
const GENERIC_NAME_WORDS = new Set(["item", "material", "part", "misc", "other", "spare", "unit", "piece", "sheet", "tape", "connector", "switch", "wire"]);

function runDataQualityAudit(products, transactions) {
  const findings = { duplicateProducts: [], missingBrand: [], missingPrice: [], inconsistentNaming: [], inconsistentUnits: [], missingVendor: [], badQuantities: [], ambiguousSpec: [], suspiciousPrices: [], insufficientHistory: [], dataIntegrity: [] };
  const stockByProduct = new Map(products.map((p) => [p.id, computeCurrentStock(p.id, transactions)]));

  // duplicates (spec-aware, never name-only)
  for (let i = 0; i < products.length; i++) {
    for (let j = i + 1; j < products.length; j++) {
      const check = isDuplicateCandidate(products[i], products[j]);
      if (check.dup) findings.duplicateProducts.push({ a: products[i].name, b: products[j].name, similarity: check.similarity });
    }
  }

  // brand / unit-of-measure: systemic gaps if the source never carried these fields at all
  const withBrand = products.filter((p) => p.brand && p.brand.trim());
  if (withBrand.length === 0 && products.length > 0) {
    findings.missingBrand.push({ issue: `No brand field present in the source data for any of ${products.length} items — the sheet has no brand column. Brand cannot be inferred from item names without guessing and is left blank.` });
  } else {
    products.filter((p) => !p.brand || !p.brand.trim()).forEach((p) => findings.missingBrand.push({ product: p.name }));
  }

  // inconsistent naming: quote-mark / trailing-unit inconsistency between near-identical names
  for (let i = 0; i < products.length; i++) {
    for (let j = i + 1; j < products.length; j++) {
      const a = products[i].name, b = products[j].name;
      if (a === b) continue;
      const aNoQuote = a.replace(/["\u201d]/g, "").trim();
      const bNoQuote = b.replace(/["\u201d]/g, "").trim();
      if (aNoQuote.toLowerCase() === bNoQuote.toLowerCase() && a !== b) {
        findings.inconsistentNaming.push({ a, b, issue: "differ only by a trailing quote/inch mark — likely the same item named inconsistently" });
      }
    }
  }

  // missing vendor / rating on transactions
  const txWithVendorSignal = transactions.filter((t) => t.unitCost !== null || t.qty);
  const missingVendorCount = txWithVendorSignal.filter((t) => !t.vendorName).length;
  if (txWithVendorSignal.length > 0) {
    findings.missingVendor.push({ issue: `${missingVendorCount} of ${txWithVendorSignal.length} transactions have no vendor recorded (${Math.round((missingVendorCount / txWithVendorSignal.length) * 100)}%) — vendor-wise price history and vendor scoring can't be computed for these.` });
  }
  transactions.filter((t) => t.vendorName && looksLikePlaceholderVendor(t.vendorName)).forEach((t) => {
    findings.missingVendor.push({ issue: `Transaction for "${products.find((p) => p.id === t.productId)?.name || t.productId}" has vendor "${t.vendorName}", which looks like placeholder text rather than a verified real vendor — confirm before trusting vendor-based recommendations.` });
  });

  // missing price
  transactions.filter((t) => t.unitCost === null).forEach((t) => {
    findings.missingPrice.push({ product: products.find((p) => p.id === t.productId)?.name || t.productId, date: t.date });
  });

  // negative / suspicious quantities
  transactions.filter((t) => t.qty < 0).forEach((t) => findings.badQuantities.push({ product: products.find((p) => p.id === t.productId)?.name, qty: t.qty }));
  products.filter((p) => (stockByProduct.get(p.id) ?? 0) < 0).forEach((p) => findings.badQuantities.push({ product: p.name, current_stock: stockByProduct.get(p.id), issue: "negative current stock — data entry error, not a real inventory state" }));

  // ambiguous specification: short, generic names with no distinguishing spec token
  products.forEach((p) => {
    const spec = specTokens(p.name);
    const words = tokenSet(p.name);
    const onlyGenericWords = [...words].every((w) => GENERIC_NAME_WORDS.has(w) || w.length <= 2);
    if (spec.size === 0 && (onlyGenericWords || words.size <= 2)) {
      findings.ambiguousSpec.push({ product: p.name, issue: "no distinguishing spec (size/rating/model) in the name — hard to tell exactly which variant this is without checking the physical item" });
    }
  });

  // suspicious prices: statistical outliers within the whole priced set (crude but explainable — not a category-aware benchmark since no category data exists)
  const priced = transactions.filter((t) => t.unitCost !== null && t.unitCost > 0);
  if (priced.length >= 5) {
    const vals = priced.map((t) => t.unitCost);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    priced.filter((t) => sd > 0 && Math.abs(t.unitCost - mean) > 3 * sd).forEach((t) => {
      findings.suspiciousPrices.push({ product: products.find((p) => p.id === t.productId)?.name, price: t.unitCost, note: `more than 3 standard deviations from the overall mean unit price (PKR ${Math.round(mean)}) across all items — could be a genuinely expensive item or a data entry error; verify, don't assume either way` });
    });
  }

  // insufficient historical data
  products.forEach((p) => {
    const stats = purchaseHistoryStats(transactions.filter((t) => t.productId === p.id));
    if (!stats) findings.insufficientHistory.push({ product: p.name, issue: "no priced purchase on record" });
    else if (stats.count === 1) findings.insufficientHistory.push({ product: p.name, issue: "only 1 priced purchase on record — not enough to establish a price trend or average with confidence" });
  });

  // data integrity: fields that don't reconcile with each other
  products.forEach((p) => {
    const stock = stockByProduct.get(p.id);
    if (p.avg_cost_snapshot && p.avg_cost_snapshot > 0 && (stock === 0 || stock === null) && p.source_stock_status && !/out of stock|critical/i.test(p.source_stock_status)) {
      findings.dataIntegrity.push({ product: p.name, issue: `sheet's own status says "${p.source_stock_status}" but computed current stock is ${stock ?? "unknown (no transactions on record)"} — inconsistent` });
    }
    if (p.min_stock === undefined || p.min_stock === null) findings.dataIntegrity.push({ product: p.name, issue: "minimum stock is blank in the source — reorder recommendations can't be computed for this item" });
  });

  return findings;
}

// ---------- price benchmarking (deterministic, no extra AI call needed) ----------
// Combines whatever historical purchase data and live market-research
// findings exist into one verdict. Never fabricates a number — if either
// side is missing, the verdict says so instead of guessing at a range.
function benchmarkPrice(historyStats, marketFindings) {
  const validFindings = (marketFindings || []).filter((f) => typeof f.price === "number" && f.price > 0);
  const marketPrices = validFindings.map((f) => f.price);
  const marketMin = marketPrices.length ? Math.min(...marketPrices) : null;
  const marketMax = marketPrices.length ? Math.max(...marketPrices) : null;
  const marketAvg = marketPrices.length ? marketPrices.reduce((a, b) => a + b, 0) / marketPrices.length : null;

  if (!historyStats && !marketPrices.length) {
    return { verdict: "INSUFFICIENT DATA", notes: "No purchase history and no usable market evidence — a manager should get fresh quotations before any price judgment is possible.", marketMin, marketMax, marketAvg };
  }
  if (historyStats && !marketPrices.length) {
    return { verdict: "HISTORY ONLY", notes: `No reliable market evidence found. Based on purchase history alone: average PKR ${Math.round(historyStats.avg)} over ${historyStats.count} purchase(s), last paid PKR ${Math.round(historyStats.last)}.`, marketMin, marketMax, marketAvg };
  }
  if (!historyStats && marketPrices.length) {
    return { verdict: "MARKET ONLY", notes: `No purchase history yet. Market evidence (${marketPrices.length} source(s)) suggests a range of PKR ${Math.round(marketMin)}–${Math.round(marketMax)}.`, marketMin, marketMax, marketAvg };
  }
  const variancePct = ((historyStats.avg - marketAvg) / marketAvg) * 100;
  let verdict = "WITHIN MARKET RANGE";
  if (historyStats.avg > marketMax * 1.1) verdict = "HISTORICALLY OVERPAYING";
  else if (historyStats.avg < marketMin * 0.9) verdict = "HISTORICALLY BELOW MARKET";
  return {
    verdict, marketMin, marketMax, marketAvg,
    notes: `Historical average PKR ${Math.round(historyStats.avg)} vs market range PKR ${Math.round(marketMin)}–${Math.round(marketMax)} (${variancePct >= 0 ? "+" : ""}${variancePct.toFixed(1)}% vs market average) from ${marketPrices.length} source(s).`,
  };
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

  // fair-price estimate: lower bound favors real purchase history when we
  // have it (it's the most concrete evidence of what we've actually paid),
  // upper bound sits between the market average and market max — never
  // above the highest price actually observed.
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

// ---------- robust JSON extraction from AI text (fallback path) ----------
// Used when a call didn't (or couldn't) use native structured output —
// e.g. as a safety net, or for providers/paths that don't support it.
// Never silently swallows a parse failure: always surfaces what the AI
// actually said so the real cause (truncation, refusal, rate-limit text
// that leaked into the response) is visible instead of a blank error.
// Escapes raw control characters (literal newlines, tabs, etc.) that
// appear INSIDE a JSON string literal, without touching whitespace that
// sits between structural tokens (which is normal and fine in
// pretty-printed JSON). LLMs occasionally emit a real line break inside a
// text field (e.g. "notes") instead of escaping it as \n — that's invalid
// per the JSON spec ("Bad control character in string literal") even
// though the JSON is otherwise complete and well-formed. This is a
// distinct failure mode from truncation and needs a different fix: repair
// the string in place rather than just reporting the error.
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

function extractJSON(text) {
  const cleaned = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[") === -1 ? cleaned.indexOf("{") : Math.min(...[cleaned.indexOf("["), cleaned.indexOf("{")].filter((i) => i !== -1));
  const lastArr = cleaned.lastIndexOf("]");
  const lastObj = cleaned.lastIndexOf("}");
  const end = Math.max(lastArr, lastObj);
  if (start === -1 || end === -1) {
    const snippet = cleaned.slice(0, 200) || "(empty response)";
    throw new Error(`AI response wasn't valid JSON. It said: "${snippet}${cleaned.length > 200 ? "…" : ""}"`);
  }
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (firstErr) {
    // retry once with control characters inside strings repaired — handles
    // the common "raw newline in a text field" case without a second
    // network call
    try {
      return JSON.parse(sanitizeJSONControlChars(slice));
    } catch (e) {
      throw new Error(`AI response looked like JSON but failed to parse (${firstErr.message}). Raw: "${cleaned.slice(0, 200)}${cleaned.length > 200 ? "…" : ""}"`);
    }
  }
}

// ---------- Procurement Auditor: document classification ----------
// Before any table gets treated as a "quotation," it must actually look
// like one. A product+quantity list with no vendor/price is a demand
// list, not a quotation — auditing it would fabricate a comparison that
// doesn't exist. This scores a table's headers (and, if there's no real
// header row, falls back to inspecting the actual cell values) against
// what each real document type looks like, and returns a classification
// + confidence + the reasoning, never a guess dressed up as certainty.
const QUOTATION_FIELD_SYNONYMS = {
  product: ["item", "product", "name", "product name", "material", "description", "item description"],
  qty: ["qty", "quantity", "required qty", "recommended qty", "order qty"],
  unitPrice: ["unit price", "rate", "price", "unit cost"],
  referencePrice: ["current price", "market price", "daraz price", "reference price", "list price"],
  vendor: ["vendor", "supplier", "vendor name", "company", "seller"],
  tax: ["tax", "gst", "vat"],
  total: ["total", "amount", "total amount", "grand total"],
  quoteRef: ["quotation no", "quote no", "quote number", "quotation number", "invoice no", "invoice number", "po number", "reference"],
  date: ["date", "quotation date", "quote date", "invoice date"],
  assetRegister: ["tag", "room", "location", "campus", "floor", "status", "health", "assignedtech", "assigned tech", "capacity"],
};

function headerHas(normHeaders, synonyms) {
  return normHeaders.some((h) => synonyms.some((s) => { const sn = normalizeToken(s); return h === sn || h.includes(sn); }));
}

// value-based fallback for sheets with no real header row (e.g. a title
// caption in row 1 followed directly by data) — inspects actual cell
// values instead of header text
function inferSignalsFromValues(rows) {
  if (!rows || !rows.length) return { hasQty: false, hasDate: false, hasUnitPrice: false };
  const cols = Object.keys(rows[0] || {});
  let hasQty = false, hasDate = false, hasUnitPrice = false;
  cols.forEach((col) => {
    const vals = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== "");
    if (!vals.length) return;
    const numericVals = vals.filter((v) => typeof v === "number" || (!isNaN(Number(v)) && String(v).trim() !== ""));
    const dateVals = vals.filter((v) => v instanceof Date || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)));
    if (dateVals.length >= vals.length * 0.6) { hasDate = true; return; }
    if (numericVals.length >= vals.length * 0.6) {
      const nums = numericVals.map(Number);
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      // small whole numbers (<100, mostly integers) read as quantities;
      // larger or fractional-looking values read as money — a rough but
      // explainable heuristic, never presented as a real price
      if (avg < 100 && nums.every((n) => Number.isInteger(n))) hasQty = true;
      else if (avg >= 20) hasUnitPrice = true;
    }
  });
  return { hasQty, hasDate, hasUnitPrice };
}

function classifySheetTable(headers, rows) {
  const normHeaders = (headers || []).map((h) => normalizeToken(h)).filter(Boolean);
  let hasProduct = headerHas(normHeaders, QUOTATION_FIELD_SYNONYMS.product);
  let hasQty = headerHas(normHeaders, QUOTATION_FIELD_SYNONYMS.qty);
  let hasUnitPrice = headerHas(normHeaders, QUOTATION_FIELD_SYNONYMS.unitPrice);
  const hasReferencePrice = headerHas(normHeaders, QUOTATION_FIELD_SYNONYMS.referencePrice);
  const hasVendor = headerHas(normHeaders, QUOTATION_FIELD_SYNONYMS.vendor);
  const hasTax = headerHas(normHeaders, QUOTATION_FIELD_SYNONYMS.tax);
  const hasTotal = headerHas(normHeaders, QUOTATION_FIELD_SYNONYMS.total);
  const hasQuoteRef = headerHas(normHeaders, QUOTATION_FIELD_SYNONYMS.quoteRef);
  let hasDate = headerHas(normHeaders, QUOTATION_FIELD_SYNONYMS.date);
  const assetFieldCount = QUOTATION_FIELD_SYNONYMS.assetRegister.filter((s) => normHeaders.some((h) => h === normalizeToken(s) || h.includes(normalizeToken(s)))).length;

  const usedValueFallback = normHeaders.filter((h) => h && !/^empty(\s?\d+)?$|^column\s?\d+$|^unnamed/.test(h)).length < 2;
  if (usedValueFallback && rows && rows.length) {
    const inferred = inferSignalsFromValues(rows);
    hasQty = inferred.hasQty;
    hasDate = inferred.hasDate;
    hasUnitPrice = hasUnitPrice || inferred.hasUnitPrice;
    hasProduct = Object.keys(rows[0] || {}).length > 0; // assume first text-bearing column is the product
  }

  const signals = { hasProduct, hasQty, hasUnitPrice, hasReferencePrice, hasVendor, hasTax, hasTotal, hasQuoteRef, hasDate, usedValueFallback };

  if (assetFieldCount >= 3) {
    return { classification: "Store/Inventory", confidence: Math.min(95, 60 + assetFieldCount * 8), signals, reason: `Matches ${assetFieldCount} asset-register fields (location/status/health/etc.) — this is an inventory/asset list, not a quotation or demand.` };
  }

  if (hasVendor && hasUnitPrice) {
    let confidence = 60;
    if (hasTotal) confidence += 10;
    if (hasTax) confidence += 8;
    if (hasQuoteRef) confidence += 12;
    if (hasDate) confidence += 5;
    const label = normHeaders.some((h) => h.includes("invoice")) ? "Invoice" : normHeaders.some((h) => h.includes("po") || h.includes("purchase order")) ? "Purchase Order" : "Vendor Quotation";
    return { classification: label, confidence: Math.min(97, confidence), signals, reason: `Found vendor identity plus real pricing (unit price${hasTotal ? ", total" : ""}${hasTax ? ", tax" : ""}${hasQuoteRef ? ", reference/quote number" : ""}) — looks like a genuine ${label.toLowerCase()}.` };
  }

  if (hasReferencePrice && !hasQty) {
    return { classification: "Price List", confidence: 80, signals, reason: "Contains reference/market prices per item with no quantity requested and no vendor — reads as a price-reference catalog, not an order." };
  }

  if (hasUnitPrice && !hasVendor) {
    return { classification: "Internal Demand/Request", confidence: hasQty ? 70 : 55, signals, reason: `Has unit price${hasTotal ? "/total" : ""}${hasTax ? "/tax" : ""} but no vendor is identified anywhere — this looks like an internal cost estimate, not a vendor's quotation. There's no way to know who quoted these prices.` };
  }

  if (hasQty && !hasUnitPrice && !hasReferencePrice && !hasVendor) {
    return { classification: "Internal Demand/Request", confidence: usedValueFallback ? 78 : (hasProduct ? 92 : 75), signals, reason: usedValueFallback ? "No labeled header row, but the data itself looks like product + quantity (+ possibly a date) with no pricing or vendor columns — an internal request, not a quotation." : "Only product and quantity found — no vendor, price, or tax information anywhere. This is an internal request, not a quotation." };
  }

  return { classification: "Unknown", confidence: 25, signals, reason: "Could not confidently classify this table against any known document type." };
}

// Applies the same rule (no vendor + no price = not a quotation) to
// lines an AI already extracted from a PDF/image/docx — those formats
// don't have inspectable headers, so this checks the extracted result
// itself instead of spending a second AI call classifying first.
function classifyExtractedLines(lines) {
  if (!lines || !lines.length) return { classification: "Unknown", confidence: 0, reason: "No lines were extracted." };
  const withVendor = lines.filter((l) => l.vendor && String(l.vendor).trim()).length;
  const withPrice = lines.filter((l) => l.unitPrice !== null && l.unitPrice !== undefined).length;
  const ratio = (n) => n / lines.length;
  if (ratio(withVendor) >= 0.5 && ratio(withPrice) >= 0.5) {
    return { classification: "Vendor Quotation", confidence: Math.round(70 + 20 * Math.min(ratio(withVendor), ratio(withPrice))), reason: `${withVendor}/${lines.length} lines have a vendor and ${withPrice}/${lines.length} have a unit price.` };
  }
  if (ratio(withPrice) >= 0.5 && ratio(withVendor) < 0.5) {
    return { classification: "Internal Demand/Request", confidence: 65, reason: `${withPrice}/${lines.length} lines have a price but only ${withVendor}/${lines.length} have a vendor identified — pricing without a confirmed vendor isn't a quotation.` };
  }
  return { classification: "Internal Demand/Request", confidence: 85, reason: `Only ${withVendor}/${lines.length} lines have a vendor and ${withPrice}/${lines.length} have a price — this reads as a request list, not a quotation.` };
}

// ---------- xAI Grok provider adapter helpers (pure, testable) ----------
// The frontend sends a provider-neutral request shape (system, messages
// with text/image/document content blocks, responseSchema). These
// functions translate that into xAI's OpenAI-compatible request format.
// Mirrored (identical logic) into api/xai.js, which is what actually
// runs server-side — duplicated here only so it's unit-testable without
// spinning up a serverless function.

// Converts our internal content-block array (or a plain string) into
// OpenAI/xAI-compatible message content. Images become data-URI
// image_url blocks (the documented xAI/OpenAI pattern). Document (PDF)
// blocks are passed through as a labeled placeholder text block, NOT as
// a native document attachment — xAI's public docs do not confirm PDF
// input support the way Gemini's did, so we don't pretend it works;
// callers relying on PDF quotation extraction should treat this as
// unconfirmed until tested against a real key.
function toOpenAIContent(content) {
  if (typeof content === "string") return content;
  return (content || []).map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") return { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}`, detail: "high" } };
    if (block.type === "document") return { type: "text", text: "[A document/PDF was attached here. PDF input is not confirmed-supported by the xAI API — this placeholder is a visible signal that extraction from this file may not have actually reached the model. Verify against a real request before trusting results from PDF uploads.]" };
    return { type: "text", text: "" };
  });
}

// Wraps one of our provider-neutral JSON schemas (plain JSON Schema:
// lowercase "object"/"string"/"array"/etc.) into the OpenAI/xAI
// response_format structure for structured output.
function buildJsonSchemaResponseFormat(schema, name) {
  return { type: "json_schema", json_schema: { name: name || "response", strict: true, schema: ensureStrictObjectSchema(schema) } };
}

// ---------- Groq provider: model routing (pure, testable) ----------
// Groq doesn't have one model that does everything — capabilities are
// split across models, confirmed against Groq's own docs, not guessed:
//   - openai/gpt-oss-20b: confirmed structured-output (json_schema) support
//     in Groq's own docs example — used for ordinary JSON extraction calls.
//   - qwen/qwen3.6-27b: confirmed vision + JSON mode, but only the looser
//     json_object mode is confirmed for it, NOT strict json_schema — so
//     vision calls get json_object, not a schema, even when the caller
//     asked for one. The frontend's hardened extractJSON is the safety
//     net for the resulting less-constrained output.
//   - groq/compound: superseded (see below) — kept as history of what
//     was tried and why it didn't work.
function chooseGroqModel({ hasImage, useWebSearch, hasSchema }) {
  // Web search: uses openai/gpt-oss-20b's Browser Search tool with
  // tool_choice:"required" (forced, reliable) instead of groq/compound(-mini)'s
  // automatic tool routing — a real test showed compound can silently skip
  // searching entirely while still returning a plausible-looking
  // "insufficient evidence" response with no error at all. Forcing the
  // tool is the documented, reliable mechanism instead.
  if (useWebSearch) return { model: "openai/gpt-oss-20b", responseFormatMode: "none" };
  if (hasImage) return { model: "qwen/qwen3.6-27b", responseFormatMode: hasSchema ? "json_object" : "none" };
  return { model: "openai/gpt-oss-20b", responseFormatMode: hasSchema ? "json_schema" : "none" };
}

// Groq/OpenAI strict json_schema mode requires additionalProperties:false
// on EVERY object node in the schema (not just the root), and requires
// every property key to appear in that object's "required" array (a
// genuinely optional field is expressed via a ["type","null"] union, not
// by omitting it from "required"). Rather than hand-maintain this on
// every schema, this walks a schema tree and enforces both rules
// automatically — the actual bug this fixes: a nested "lines" array's
// item objects didn't have additionalProperties:false, which Groq
// rejected outright before even attempting the request.
function ensureStrictObjectSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(ensureStrictObjectSchema);
  const clone = { ...schema };
  const isObjectType = clone.type === "object" || (Array.isArray(clone.type) && clone.type.includes("object"));
  if (isObjectType) {
    if (clone.properties) {
      const newProps = {};
      for (const [k, v] of Object.entries(clone.properties)) newProps[k] = ensureStrictObjectSchema(v);
      clone.properties = newProps;
      clone.required = Object.keys(newProps); // strict mode: every key must be required
    }
    if (clone.additionalProperties === undefined) clone.additionalProperties = false;
  }
  if (clone.items) clone.items = ensureStrictObjectSchema(clone.items);
  return clone;
}

// ---------- Gemini provider: schema conversion (pure, testable) ----------
// The frontend's schemas are defined once, in standard JSON Schema
// (lowercase types, ["type","null"] unions for optional fields) — the
// same neutral format used for Groq/xAI. Gemini's own schema format is
// different (uppercase Type strings, a separate "nullable" boolean
// instead of a type union), so this converts one into the other. This
// is the actual fix needed to bring Gemini back after the frontend's
// schemas were changed to the neutral format during the Groq migration.
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
  // Gemini doesn't use additionalProperties or require every key listed —
  // that was a Groq/OpenAI strict-mode requirement, not general JSON
  // Schema semantics, so it's dropped rather than carried over.
  delete out.additionalProperties;
  return out;
}

module.exports = {
  normalizeToken, tokenSet, jaccard, specTokens, setsEqual, toNumber,
  SCHEMA_SYNONYMS, mapColumn, findMappingCollisions,
  computeStockHealth, reorderQty, vendorScore, isDuplicateCandidate,
  buildImportPlan, effectiveUnitPrice, rankQuotations, purchaseHistoryStats,
  parseRating, looksLikePlaceholderVendor, detectTableBlocks, runDataQualityAudit, benchmarkPrice,
  computeCurrentStock, validateIssueQuantity, computeProcurementStage, auditQuotationLine, extractJSON,
  classifySheetTable, classifyExtractedLines, toOpenAIContent, buildJsonSchemaResponseFormat, chooseGroqModel, ensureStrictObjectSchema, toGeminiSchema,
};
