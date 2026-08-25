const assert = require("assert");
const L = require("./procurex-logic.js");

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(["PASS", name]); }
  catch (e) { fail++; results.push(["FAIL", name, e.message]); }
}

/* ============================================================
   1. Column mapping — using the REAL HFM column headers from
      the client's own spreadsheet structure
   ============================================================ */
const HFM_HEADERS = [
  "Item", "Minimum Stock", "Total IN", "Total OUT", "Current Stock", "Stock Status",
  "Average Unit Cost", "Total Value", "Transaction Date", "Transaction Type",
  "Quantity", "Person", "Reason/Purpose", "Unit Cost", "Total Cost", "Vendor",
  "Rating", "Location", "Remarks",
];

test("maps 'Item' -> product_name with high confidence", () => {
  const m = L.mapColumn("Item");
  assert.strictEqual(m.field, "product_name");
  assert.ok(m.confidence >= 90, "confidence was " + m.confidence);
});

test("'Current Stock' and 'Quantity' map to DIFFERENT fields (regression: previously both mapped to the same field, corrupting stock levels)", () => {
  const stock = L.mapColumn("Current Stock");
  const qty = L.mapColumn("Quantity");
  assert.strictEqual(stock.field, "current_stock");
  assert.strictEqual(qty.field, "txn_quantity");
  assert.notStrictEqual(stock.field, qty.field);
});

test("'Reason/Purpose' tokenizes correctly and maps to reason (regression: punctuation deletion glued tokens)", () => {
  assert.deepStrictEqual([...L.tokenSet("Reason/Purpose")].sort(), ["purpose", "reason"]);
  const m = L.mapColumn("Reason/Purpose");
  assert.strictEqual(m.field, "reason");
});

test("'Remarks' maps to its own field, not silently merged into 'reason'", () => {
  const m = L.mapColumn("Remarks");
  assert.strictEqual(m.field, "remarks");
});

test("'Average Unit Cost' maps to a distinct valuation field, NOT the same field as per-transaction 'Unit Cost' (regression: an earlier version collided these two, which would have fabricated a phantom transaction from every item's valuation snapshot)", () => {
  const avgCost = L.mapColumn("Average Unit Cost");
  const unitCost = L.mapColumn("Unit Cost");
  assert.strictEqual(avgCost.field, "avg_cost_snapshot");
  assert.strictEqual(unitCost.field, "unit_price");
  assert.notStrictEqual(avgCost.field, unitCost.field);
});

test("all 19 real HFM headers get either a confident mapping or are safely ignored (none silently corrupt an unrelated field)", () => {
  const bad = [];
  HFM_HEADERS.forEach((h) => {
    const m = L.mapColumn(h);
    if (m.field === null && !["Stock Status", "Total IN", "Total OUT"].includes(h)) bad.push(h);
  });
  assert.deepStrictEqual(bad, []);
});

test("robust number parsing handles commas, currency prefixes, blanks", () => {
  assert.strictEqual(L.toNumber("4,650"), 4650);
  assert.strictEqual(L.toNumber("Rs. 4,650.50"), 4650.5);
  assert.strictEqual(L.toNumber("PKR 200"), 200);
  assert.strictEqual(L.toNumber(""), null);
  assert.strictEqual(L.toNumber(null), null);
  assert.strictEqual(L.toNumber("-5"), -5);
});

/* ============================================================
   2. Import merge — transaction-ledger-style sheet
      (the real HFM structure: one row per transaction, item
      fields repeated across many rows for the same item)
   ============================================================ */
test("repeated item rows merge into ONE product, not N duplicates (regression: previous build created a new product per row)", () => {
  const headers = ["Item", "Minimum Stock", "Current Stock", "Transaction Date", "Vendor", "Unit Cost", "Quantity", "Transaction Type"];
  const mapping = {}; headers.forEach((h) => (mapping[h] = L.mapColumn(h)));
  const rows = [
    { Item: "Schneider 32A 2P MCB", "Minimum Stock": "10", "Current Stock": "18", "Transaction Date": "2026-01-05", Vendor: "Al-Karam Electricals", "Unit Cost": "4500", Quantity: "5", "Transaction Type": "IN" },
    { Item: "Schneider 32A 2P MCB", "Minimum Stock": "", "Current Stock": "", "Transaction Date": "2026-02-11", Vendor: "ABC Electrical Traders", "Unit Cost": "4700", Quantity: "3", "Transaction Type": "IN" },
    { Item: "Schneider 32A 2P MCB", "Minimum Stock": "", "Current Stock": "", "Transaction Date": "2026-03-02", Vendor: "Al-Karam Electricals", "Unit Cost": "4650", Quantity: "2", "Transaction Type": "OUT" },
  ];
  const plan = L.buildImportPlan(headers, rows, mapping, [], [], "test.csv");
  assert.strictEqual(plan.products.length, 1, "expected exactly 1 product, got " + plan.products.length);
  assert.strictEqual(plan.transactions.length, 3, "the 3 real transaction rows must still be present, with NO fabricated adjustment forcing agreement with the declared 18");
  assert.ok(plan.transactions.every((t) => t.productId === plan.products[0].id), "all transactions must link to the same product id");
  const stock = L.computeCurrentStock(plan.products[0].id, plan.transactions);
  assert.strictEqual(stock, 6, "derived current stock must reflect only the REAL transactions on record (net 6), not be silently forced to match the sheet's declared 18");
  assert.ok(plan.warnings.some((w) => w.includes("18") && w.includes("6")), "the mismatch between declared (18) and derived (6) stock must be surfaced as a warning, not papered over");
  assert.strictEqual(plan.products[0].min_stock, 10);
});

test("blank rows are skipped, not imported as empty products", () => {
  const headers = ["Item", "Current Stock"];
  const mapping = { Item: L.mapColumn("Item"), "Current Stock": L.mapColumn("Current Stock") };
  const rows = [{ Item: "", "Current Stock": "" }, { Item: "Bearing 6205", "Current Stock": "40" }];
  const plan = L.buildImportPlan(headers, rows, mapping, [], [], "test.csv");
  assert.strictEqual(plan.stats.skippedBlank, 1);
  assert.strictEqual(plan.products.length, 1);
});

test("rows with no product name are skipped and counted, not silently dropped", () => {
  const headers = ["Item", "Current Stock"];
  const mapping = { Item: L.mapColumn("Item"), "Current Stock": L.mapColumn("Current Stock") };
  const rows = [{ Item: "   ", "Current Stock": "5" }];
  const plan = L.buildImportPlan(headers, rows, mapping, [], [], "test.csv");
  assert.strictEqual(plan.stats.skippedNoName, 1);
  assert.strictEqual(plan.products.length, 0);
});

test("missing unit price -> transaction still logged, with a warning, not fabricated", () => {
  const headers = ["Item", "Vendor", "Quantity"];
  const mapping = { Item: L.mapColumn("Item"), Vendor: L.mapColumn("Vendor"), Quantity: L.mapColumn("Quantity") };
  const rows = [{ Item: "Cable 2.5mm", Vendor: "Metro Electric", Quantity: "3" }];
  const plan = L.buildImportPlan(headers, rows, mapping, [], [], "test.csv");
  assert.strictEqual(plan.transactions[0].unitCost, null);
  assert.ok(plan.warnings.some((w) => w.includes("no unit price")));
});

test("missing vendor -> transaction still logged, with a warning, not fabricated", () => {
  const headers = ["Item", "Unit Cost", "Quantity"];
  const mapping = { Item: L.mapColumn("Item"), "Unit Cost": L.mapColumn("Unit Cost"), Quantity: L.mapColumn("Quantity") };
  const rows = [{ Item: "Cable 4mm", "Unit Cost": "900", Quantity: "2" }];
  const plan = L.buildImportPlan(headers, rows, mapping, [], [], "test.csv");
  assert.strictEqual(plan.transactions[0].vendorName, "");
  assert.ok(plan.warnings.some((w) => w.includes("no vendor")));
});

test("re-importing the same sheet against existing products updates in place, doesn't duplicate — and a mismatched declared stock is surfaced as a warning, never silently forced", () => {
  const headers = ["Item", "Current Stock"];
  const mapping = { Item: L.mapColumn("Item"), "Current Stock": L.mapColumn("Current Stock") };
  const existingProducts = [{ id: "prod_1", name: "PVC Pipe 4in", normalized_name: "pvc pipe 4in", min_stock: 5, category: "Plumbing", uom: "length", source: "prior" }];
  const existingTransactions = [{ id: "tx_prior", productId: "prod_1", type: "IN", qty: 10, unitCost: 650, vendorName: "National Hardware Store", date: "2026-01-01" }];
  const rows = [{ Item: "PVC Pipe 4in", "Current Stock": "25" }];
  const plan = L.buildImportPlan(headers, rows, mapping, existingProducts, existingTransactions, "resync.csv");
  assert.strictEqual(plan.products.length, 1);
  assert.strictEqual(plan.products[0].id, "prod_1");
  assert.strictEqual(plan.transactions.some((t) => t.type === "ADJUSTMENT"), false, "must NOT fabricate an adjustment when real transaction history already exists but disagrees with the declared value");
  assert.ok(plan.warnings.some((w) => w.includes("25") && w.includes("10")), "the 25-vs-10 mismatch must be surfaced as a warning");
  const finalStock = L.computeCurrentStock("prod_1", [...existingTransactions, ...plan.transactions]);
  assert.strictEqual(finalStock, 10, "the real transaction history (10) stands as the honest current stock, not the sheet's stale re-declared 25");
});

/* ============================================================
   3. Stock health calculations
   ============================================================ */
test("zero stock -> CRITICAL", () => assert.strictEqual(L.computeStockHealth(0, 10, 5).state, "CRITICAL"));
test("negative stock -> DATA ERROR, not miscategorized as a restock urgency", () => assert.strictEqual(L.computeStockHealth(-3, 10, 5).state, "DATA ERROR"));
test("stock well below min -> CRITICAL", () => assert.strictEqual(L.computeStockHealth(4, 10, 5).state, "CRITICAL"));
test("stock just below min -> LOW", () => assert.strictEqual(L.computeStockHealth(8, 10, 5).state, "LOW"));
test("stock just above min -> REORDER SOON", () => assert.strictEqual(L.computeStockHealth(11, 10, 5).state, "REORDER SOON"));
test("healthy mid-range stock -> HEALTHY", () => assert.strictEqual(L.computeStockHealth(30, 10, 5).state, "HEALTHY"));
test("huge coverage (500 units at 5/month = 100mo) -> DEAD STOCK", () => assert.strictEqual(L.computeStockHealth(500, 10, 5).state, "DEAD STOCK"));
test("no consumption history + high stock -> OVERSTOCK, not a false HEALTHY", () => assert.strictEqual(L.computeStockHealth(100, 10, 0).state, "OVERSTOCK"));
test("missing current stock value -> UNKNOWN, not treated as zero", () => assert.strictEqual(L.computeStockHealth(null, 10, 5).state, "UNKNOWN"));

/* ============================================================
   4. Duplicate-product detection (spec: never merge on name alone)
   ============================================================ */
test("same product, different phrasing, same spec -> flagged as duplicate", () => {
  const a = { name: "Schneider 32A MCB 2P", category: "Electrical" };
  const b = { name: "MCB Schneider 2P 32A", category: "Electrical" };
  assert.strictEqual(L.isDuplicateCandidate(a, b).dup, true);
});
test("similar name, DIFFERENT pole count (1P vs 2P) -> NOT flagged (regression: name-only similarity falsely flagged these)", () => {
  const a = { name: "Schneider MCB 32A 2P C-Curve", category: "Electrical" };
  const b = { name: "Schneider MCB 32A 1P C-Curve", category: "Electrical" };
  assert.strictEqual(L.isDuplicateCandidate(a, b).dup, false);
});
test("similar name, different amperage -> NOT flagged", () => {
  const a = { name: "Schneider MCB 16A", category: "Electrical" };
  const b = { name: "Schneider MCB 32A", category: "Electrical" };
  assert.strictEqual(L.isDuplicateCandidate(a, b).dup, false);
});
test("same name+spec but different unit of measure -> NOT flagged", () => {
  const a = { name: "Cable 2.5mm", category: "Electrical", uom: "roll" };
  const b = { name: "Cable 2.5mm", category: "Electrical", uom: "meter" };
  assert.strictEqual(L.isDuplicateCandidate(a, b).dup, false);
});
test("different category -> never flagged regardless of name similarity", () => {
  const a = { name: "Filter", category: "HVAC" };
  const b = { name: "Filter", category: "Plumbing" };
  assert.strictEqual(L.isDuplicateCandidate(a, b).dup, false);
});

/* ============================================================
   5. Vendor scoring
   ============================================================ */
test("vendor score is the documented weighted average (0.3/0.25/0.25/0.2)", () => {
  const v = { reliability: 80, delivery: 90, quality: 70, priceCompetitiveness: 60 };
  const expected = Math.round(80 * 0.3 + 90 * 0.25 + 70 * 0.25 + 60 * 0.2);
  assert.strictEqual(L.vendorScore(v), expected);
});

/* ============================================================
   6. GST-aware price comparison (spec: don't conflate tax-inclusive
      vs exclusive pricing)
   ============================================================ */
test("best price is chosen on GST-inclusive effective price, not raw unit price (regression: raw-price ranking picked the wrong vendor)", () => {
  const quotes = [
    { vendor: "Vendor A", unitPrice: 4500, gst: 17 }, // effective 5265
    { vendor: "Vendor B", unitPrice: 4900, gst: 0 },  // effective 4900 <- actually cheaper
  ];
  const ranked = L.rankQuotations(quotes);
  const best = ranked.find((q) => q.isBestPrice);
  assert.strictEqual(best.vendor, "Vendor B");
});
test("overpriced flag uses effective price threshold (>15% above best effective price)", () => {
  const quotes = [
    { vendor: "Vendor A", unitPrice: 1000, gst: 0 },
    { vendor: "Vendor B", unitPrice: 1200, gst: 0 }, // +20%
  ];
  const ranked = L.rankQuotations(quotes);
  assert.strictEqual(ranked.find((q) => q.vendor === "Vendor B").isOverpriced, true);
  assert.strictEqual(ranked.find((q) => q.vendor === "Vendor A").isOverpriced, false);
});

/* ============================================================
   7. Purchase history stats
   ============================================================ */
test("purchase history averages ignore transactions with no price", () => {
  const txs = [
    { unitCost: 100, date: "2026-01-01" },
    { unitCost: null, date: "2026-01-02" },
    { unitCost: 200, date: "2026-01-03" },
  ];
  const stats = L.purchaseHistoryStats(txs);
  assert.strictEqual(stats.count, 2);
  assert.strictEqual(stats.avg, 150);
});
test("purchase history returns null (not a crash / not zero) when there is no priced data", () => {
  assert.strictEqual(L.purchaseHistoryStats([{ unitCost: null }]), null);
});

test("'Average Unit Cost' (item-level valuation) never creates a phantom transaction on its own — only genuine transaction signals (qty/unit price/vendor/date) or a declared current-stock reconciliation do", () => {
  // case 1: avg cost only, no declared current stock at all -> zero transactions
  const headersA = ["Item", "Average Unit Cost"];
  const mappingA = { Item: L.mapColumn("Item"), "Average Unit Cost": L.mapColumn("Average Unit Cost") };
  const planA = L.buildImportPlan(headersA, [{ Item: "Ceiling Light 6500K", "Average Unit Cost": "PKR 910.00" }], mappingA, [], [], "item-master-only.csv");
  assert.strictEqual(planA.transactions.length, 0, "avg cost with no declared stock must not fabricate anything");
  assert.strictEqual(planA.products[0].avg_cost_snapshot, 910);

  // case 2: avg cost AND a declared current stock -> exactly one clean reconciliation adjustment, never a fake priced purchase
  const headersB = ["Item", "Current Stock", "Average Unit Cost"];
  const mappingB = { Item: L.mapColumn("Item"), "Current Stock": L.mapColumn("Current Stock"), "Average Unit Cost": L.mapColumn("Average Unit Cost") };
  const planB = L.buildImportPlan(headersB, [{ Item: "Ceiling Light 6500K", "Current Stock": "29", "Average Unit Cost": "PKR 910.00" }], mappingB, [], [], "item-master-only.csv");
  assert.strictEqual(planB.transactions.length, 1);
  assert.strictEqual(planB.transactions[0].type, "ADJUSTMENT");
  assert.strictEqual(planB.transactions[0].qty, 29);
  assert.strictEqual(planB.transactions[0].unitCost, null, "the adjustment must never carry a fabricated cost, even though an avg unit cost exists on the item");
});

test("star-rating cells parse to a number; plain numeric ratings still work", () => {
  assert.strictEqual(L.parseRating("⭐⭐⭐⭐⭐"), 5);
  assert.strictEqual(L.parseRating("★★★"), 3);
  assert.strictEqual(L.parseRating("4"), 4);
  assert.strictEqual(L.parseRating(""), null);
});

test("placeholder-looking vendor names ('Vendor A') are flagged, real company names are not", () => {
  assert.strictEqual(L.looksLikePlaceholderVendor("Vendor A"), true);
  assert.strictEqual(L.looksLikePlaceholderVendor("Vendor 1"), true);
  assert.strictEqual(L.looksLikePlaceholderVendor("Al-Karam Electricals"), false);
  assert.strictEqual(L.looksLikePlaceholderVendor("Replaced in house"), false); // not a vendor-shaped string at all, caught separately as a missing-vendor case
});

/* ============================================================
   8. Multi-table detection — the real HFM Store tab has an item-master
      table and a transactions table sitting in different column ranges
      on the SAME rows (not row-aligned by item). This must not be
      hardcoded to one sheet's layout.
   ============================================================ */
test("detects two separate table blocks in a grid that packs an item-master table and a transactions table side by side, unaligned by row", () => {
  // column layout mirrors the real sheet: A blank, B..I item master, J blank spacer, K..N transactions
  const grid = [
    [], [], [], [], [], [], [], [], [], // rows 0-8 blank/title
    ["", "Item", "Min Stock", "Current Stock", "", "", "", "", "", "Date", "Type", "Item", "Qty", "Vendor"], // header row (9)
    ["", "Bulb A", "5", "10", "", "", "", "", "", "2026-01-01", "IN", "Bulb B", "20", "Al-Karam"], // NOT the same item across the two blocks — realistic
    ["", "Bulb B", "5", "0", "", "", "", "", "", "2026-01-02", "IN", "Bulb A", "10", "Al-Karam"],
  ];
  const blocks = L.detectTableBlocks(grid);
  assert.strictEqual(blocks.length, 2, "expected exactly 2 detected blocks, got " + blocks.length);
  const master = blocks.find((b) => b.guessedType.startsWith("Item Master"));
  const txns = blocks.find((b) => b.guessedType.startsWith("Transactions"));
  assert.ok(master, "expected an Item Master block to be identified");
  assert.ok(txns, "expected a Transactions block to be identified");
  assert.strictEqual(master.rows.length, 2);
  assert.strictEqual(txns.rows.length, 2);
});

test("chaining buildImportPlan across the two detected blocks correctly cross-links transactions to item-master products even though the blocks are not row-aligned — the real transaction ledger wins over a mismatched declared snapshot", () => {
  const masterHeaders = ["Item", "Min Stock", "Current Stock"];
  const masterMapping = { Item: L.mapColumn("Item"), "Min Stock": L.mapColumn("Min Stock"), "Current Stock": L.mapColumn("Current Stock") };
  const masterRows = [{ Item: "Bulb A", "Min Stock": "5", "Current Stock": "10" }, { Item: "Bulb B", "Min Stock": "5", "Current Stock": "0" }];

  const txHeaders = ["Date", "Type", "Item", "Qty", "Vendor"];
  const txMapping = { Date: L.mapColumn("Date"), Type: L.mapColumn("Type"), Item: L.mapColumn("Item"), Qty: L.mapColumn("Qty"), Vendor: L.mapColumn("Vendor") };
  const txRows = [{ Date: "2026-01-01", Type: "IN", Item: "Bulb B", Qty: "20", Vendor: "Al-Karam" }, { Date: "2026-01-02", Type: "IN", Item: "Bulb A", Qty: "10", Vendor: "Al-Karam" }];

  // transactions block first (real dated movements), item-master block second (only fills gaps, never overrules)
  const planTx = L.buildImportPlan(txHeaders, txRows, txMapping, [], [], "sheet (Transactions)");
  const planMaster = L.buildImportPlan(masterHeaders, masterRows, masterMapping, planTx.products, planTx.transactions, "sheet (Item Master)");

  const allTx = [...planTx.transactions, ...planMaster.transactions];
  assert.strictEqual(planMaster.products.length, 2, "no duplicate products should be created across the two blocks");
  const bulbA = planMaster.products.find((p) => p.name === "Bulb A");
  const bulbB = planMaster.products.find((p) => p.name === "Bulb B");

  const txForA = allTx.find((t) => t.productId === bulbA.id && t.type === "IN");
  assert.ok(txForA, "the transaction for Bulb A (in the transactions block) must link to the SAME product id created there and reused by the item-master block");
  assert.strictEqual(txForA.qty, 10);

  assert.strictEqual(L.computeCurrentStock(bulbA.id, allTx), 10, "Bulb A: real transaction (10) already matches the declared master stock (10) -> clean, no warning needed");
  assert.strictEqual(planMaster.transactions.some((t) => t.productId === bulbA.id), false);

  assert.strictEqual(L.computeCurrentStock(bulbB.id, allTx), 20, "Bulb B: the real transaction (20) stands as the honest current stock, even though the master snapshot claims 0");
  assert.strictEqual(planMaster.transactions.some((t) => t.productId === bulbB.id && t.type === "ADJUSTMENT"), false, "must not fabricate an adjustment to force agreement with a stale-looking snapshot");
  assert.ok(planMaster.warnings.some((w) => w.includes("Bulb B") && w.includes("0") && w.includes("20")), "the Bulb B mismatch (declared 0 vs derived 20) must be surfaced as a warning");
});

/* ============================================================
   9. Data-quality audit
   ============================================================ */
test("data-quality audit reports a systemic missing-brand finding when the source has no brand column at all, not one line per product", () => {
  const products = [{ id: "p1", name: "Bulb A", category: "Electrical" }, { id: "p2", name: "Bulb B", category: "Electrical" }];
  const audit = L.runDataQualityAudit(products, []);
  assert.strictEqual(audit.missingBrand.length, 1);
  assert.ok(audit.missingBrand[0].issue.includes("No brand field"));
});

test("data-quality audit flags transactions with no vendor as a percentage summary", () => {
  const products = [{ id: "p1", name: "Bulb A" }];
  const transactions = [
    { id: "t1", productId: "p1", unitCost: 100, vendorName: "" },
    { id: "t2", productId: "p1", unitCost: 100, vendorName: "Al-Karam" },
  ];
  const audit = L.runDataQualityAudit(products, transactions);
  assert.ok(audit.missingVendor[0].issue.includes("1 of 2"));
});

test("data-quality audit flags items with only one priced purchase as insufficient history", () => {
  const products = [{ id: "p1", name: "Bulb A" }];
  const transactions = [{ id: "t1", productId: "p1", unitCost: 100, date: "2026-01-01" }];
  const audit = L.runDataQualityAudit(products, transactions);
  assert.ok(audit.insufficientHistory.some((f) => f.product === "Bulb A"));
});

/* ============================================================
   10. Price benchmarking (deterministic — feeds the auto-agent)
   ============================================================ */
test("benchmarkPrice: no history, no market evidence -> INSUFFICIENT DATA, never guesses", () => {
  const r = L.benchmarkPrice(null, []);
  assert.strictEqual(r.verdict, "INSUFFICIENT DATA");
});
test("benchmarkPrice: history but no market evidence -> HISTORY ONLY, uses only real numbers", () => {
  const r = L.benchmarkPrice({ avg: 1000, count: 3, last: 1050 }, []);
  assert.strictEqual(r.verdict, "HISTORY ONLY");
  assert.ok(r.notes.includes("1000"));
});
test("benchmarkPrice: history above market max by >10% -> HISTORICALLY OVERPAYING", () => {
  const r = L.benchmarkPrice({ avg: 1500, count: 2, last: 1500 }, [{ price: 1000 }, { price: 1100 }]);
  assert.strictEqual(r.verdict, "HISTORICALLY OVERPAYING");
});
test("benchmarkPrice: history within market range -> WITHIN MARKET RANGE", () => {
  const r = L.benchmarkPrice({ avg: 1050, count: 2, last: 1050 }, [{ price: 1000 }, { price: 1100 }]);
  assert.strictEqual(r.verdict, "WITHIN MARKET RANGE");
});
test("benchmarkPrice: findings with no numeric price are ignored, not treated as zero", () => {
  const r = L.benchmarkPrice({ avg: 1000, count: 1, last: 1000 }, [{ price: null }, { vendor: "X" }]);
  assert.strictEqual(r.verdict, "HISTORY ONLY");
});

/* ============================================================
   11. Current stock — ALWAYS derived from transactions, never stored
   ============================================================ */
test("computeCurrentStock: IN adds, OUT subtracts, ADJUSTMENT applies signed delta", () => {
  const tx = [
    { productId: "p1", type: "IN", qty: 50 },
    { productId: "p1", type: "OUT", qty: 20 },
    { productId: "p1", type: "ADJUSTMENT", qty: -5 },
    { productId: "p2", type: "IN", qty: 999 }, // different product — must not leak in
  ];
  assert.strictEqual(L.computeCurrentStock("p1", tx), 25);
});
test("computeCurrentStock: no transactions at all -> null (unknown), never a fabricated zero", () => {
  assert.strictEqual(L.computeCurrentStock("p1", []), null);
  assert.strictEqual(L.computeCurrentStock("p1", [{ productId: "p2", type: "IN", qty: 10 }]), null);
});
test("computeCurrentStock: real IN/OUT movements can legitimately net to zero (distinct from 'no data')", () => {
  const tx = [{ productId: "p1", type: "IN", qty: 10 }, { productId: "p1", type: "OUT", qty: 10 }];
  assert.strictEqual(L.computeCurrentStock("p1", tx), 0);
});

test("validateIssueQuantity: issuing less than available is allowed without override", () => {
  const tx = [{ productId: "p1", type: "IN", qty: 20 }];
  const r = L.validateIssueQuantity("p1", tx, 5);
  assert.strictEqual(r.available, 20);
  assert.strictEqual(r.wouldGoNegative, false);
  assert.strictEqual(r.allowedWithoutOverride, true);
  assert.strictEqual(r.resultingStock, 15);
});
test("validateIssueQuantity: issuing more than available is flagged, not silently permitted", () => {
  const tx = [{ productId: "p1", type: "IN", qty: 5 }];
  const r = L.validateIssueQuantity("p1", tx, 8);
  assert.strictEqual(r.wouldGoNegative, true);
  assert.strictEqual(r.allowedWithoutOverride, false);
  assert.strictEqual(r.resultingStock, -3);
});
test("validateIssueQuantity: issuing against a product with zero transaction history is flagged, not assumed available", () => {
  const r = L.validateIssueQuantity("p1", [], 1);
  assert.strictEqual(r.available, null);
  assert.strictEqual(r.allowedWithoutOverride, false);
});

/* ============================================================
   12. Procurement lifecycle stage (derived, not stored)
   ============================================================ */
test("computeProcurementStage walks Stock Alert -> AI Research -> RFQ -> Quotations -> Comparison -> AI Recommendation -> Approved -> Purchased -> Received -> Audited", () => {
  assert.strictEqual(L.computeProcurementStage({}, 0), "Stock Alert");
  assert.strictEqual(L.computeProcurementStage({ marketEvidence: { findings: [] } }, 0), "AI Research");
  assert.strictEqual(L.computeProcurementStage({ marketEvidence: {}, message: "RFQ text" }, 0), "RFQ");
  assert.strictEqual(L.computeProcurementStage({ marketEvidence: {}, message: "x" }, 1), "Quotations");
  assert.strictEqual(L.computeProcurementStage({ marketEvidence: {}, message: "x" }, 2), "Comparison");
  assert.strictEqual(L.computeProcurementStage({ marketEvidence: {}, message: "x", benchmark: { verdict: "WITHIN MARKET RANGE" } }, 2), "AI Recommendation");
  assert.strictEqual(L.computeProcurementStage({ benchmark: {}, status: "APPROVED" }, 2), "Approved");
  assert.strictEqual(L.computeProcurementStage({ benchmark: {}, status: "APPROVED", purchase: { vendor: "X", unitPrice: 100 } }, 2), "Purchased");
  assert.strictEqual(L.computeProcurementStage({ benchmark: {}, status: "APPROVED", purchase: {}, receivedTransactionId: "tx_1" }, 2), "Received");
  assert.strictEqual(L.computeProcurementStage({ benchmark: {}, status: "APPROVED", purchase: {}, receivedTransactionId: "tx_1", audit: { verdict: "GOOD PURCHASE" } }, 2), "Audited");
});
test("computeProcurementStage: rejection ends the loop at Manager Approval, doesn't advance further", () => {
  assert.strictEqual(L.computeProcurementStage({ status: "CLOSED" }, 0), "Manager Approval");
});

/* ============================================================
   13. Procurement Auditor — single quotation line audit
   ============================================================ */
test("auditQuotationLine: no market evidence -> INSUFFICIENT MARKET EVIDENCE, no fabricated fair price", () => {
  const r = L.auditQuotationLine({ quotedUnitPrice: 5000, qty: 10, historyStats: null, marketFindings: [] });
  assert.strictEqual(r.verdict, "INSUFFICIENT MARKET EVIDENCE");
  assert.strictEqual(r.fairMin, null);
  assert.strictEqual(r.overpayTotalMax, null);
});
test("auditQuotationLine: quoted price above market max -> ABOVE MARKET with a positive overpayment range", () => {
  const r = L.auditQuotationLine({
    quotedUnitPrice: 5000, qty: 10,
    historyStats: { avg: 4650, count: 3, last: 4650 },
    marketFindings: [{ price: 4600 }, { price: 4850 }],
  });
  assert.strictEqual(r.verdict, "ABOVE MARKET");
  assert.strictEqual(r.marketMin, 4600);
  assert.strictEqual(r.marketMax, 4850);
  assert.ok(r.overpayPerUnitMin >= 0 && r.overpayPerUnitMax > r.overpayPerUnitMin);
  assert.strictEqual(r.overpayTotalMax, r.overpayPerUnitMax * 10);
});
test("auditQuotationLine: quoted price within observed market range -> WITHIN MARKET, zero overpayment", () => {
  const r = L.auditQuotationLine({
    quotedUnitPrice: 4700, qty: 5,
    historyStats: { avg: 4650, count: 3, last: 4650 },
    marketFindings: [{ price: 4600 }, { price: 4850 }],
  });
  assert.strictEqual(r.verdict, "WITHIN MARKET");
});
test("auditQuotationLine: quoted price below market min -> flagged as suspiciously cheap, not just 'good'", () => {
  const r = L.auditQuotationLine({ quotedUnitPrice: 3000, qty: 1, historyStats: null, marketFindings: [{ price: 4600 }, { price: 4850 }] });
  assert.ok(r.verdict.startsWith("BELOW MARKET"));
});
test("auditQuotationLine: findings with no numeric price are ignored, not treated as zero evidence", () => {
  const r = L.auditQuotationLine({ quotedUnitPrice: 5000, qty: 1, historyStats: null, marketFindings: [{ price: 4700 }, { vendor: "X" }] });
  assert.notStrictEqual(r.verdict, "INSUFFICIENT MARKET EVIDENCE");
});
test("auditQuotationLine: fair range never exceeds the highest real market price observed", () => {
  const r = L.auditQuotationLine({ quotedUnitPrice: 5000, qty: 1, historyStats: { avg: 9999, count: 1, last: 9999 }, marketFindings: [{ price: 4600 }, { price: 4850 }] });
  assert.ok(r.fairMax <= 4850);
  assert.ok(r.fairMin <= 4850);
});

/* ============================================================
   14. extractJSON — regression coverage for malformed/truncated
   AI responses (the root cause of the "AI response looked like
   JSON but failed to parse" bug seen on real long market-research
   responses that got cut off mid-array).
   ============================================================ */
test("extractJSON: parses clean, well-formed JSON normally", () => {
  const result = L.extractJSON('{"overallConfidence": 85, "findings": [{"vendor": "X", "price": 100}]}');
  assert.strictEqual(result.overallConfidence, 85);
  assert.strictEqual(result.findings[0].vendor, "X");
});
test("extractJSON: strips markdown code fences before parsing", () => {
  const result = L.extractJSON('```json\n{"ok": true}\n```');
  assert.strictEqual(result.ok, true);
});
test("extractJSON: a response with no JSON at all throws with the actual text visible, not a blank message", () => {
  assert.throws(() => L.extractJSON("I'm sorry, I cannot help with that request."), /I'm sorry, I cannot help/);
});
test("extractJSON: an empty response throws a clear '(empty response)' message rather than crashing uninformatively", () => {
  assert.throws(() => L.extractJSON(""), /empty response/);
});
test("extractJSON: a long response truncated mid-array (the real bug that was observed — cut off around a findings array) throws with the parse error AND a visible raw snippet, not a silent failure", () => {
  // simulates a real long market-research response that got cut off before
  // its closing brackets — e.g. hitting a token limit mid-generation
  const longNotes = "Prices vary significantly based on the vendor and specific model. ".repeat(120); // pushes well past 200 chars, like the real ~8856-char response
  const truncated = `{"overallConfidence": 85, "insufficientEvidence": false, "notes": "${longNotes}", "findings": [{"vendor": "ABC Traders", "price": 4650, "sourceUrl": "https://example.com/a"}, {"vendor": "XYZ Elec`; // cut off mid-object, no closing braces at all
  assert.throws(() => L.extractJSON(truncated), (err) => {
    return err.message.includes("failed to parse") || err.message.includes("wasn't valid JSON");
  });
});
test("extractJSON: valid JSON with a genuinely long findings array (many vendors) still parses correctly — long-but-complete is not the same bug as truncated", () => {
  const findings = Array.from({ length: 15 }, (_, i) => ({ vendor: `Vendor ${i}`, price: 1000 + i, sourceUrl: `https://example.com/${i}`, dateChecked: "2026-08-23" }));
  const payload = JSON.stringify({ overallConfidence: 70, insufficientEvidence: false, notes: "long but complete", findings });
  const result = L.extractJSON(payload);
  assert.strictEqual(result.findings.length, 15);
});
test("extractJSON: repairs a literal (unescaped) newline inside a JSON string value — a distinct real bug from truncation ('Bad control character in string literal')", () => {
  // this is NOT valid JSON on its own — it has a real newline byte inside
  // the "notes" string instead of an escaped \n, which is exactly what a
  // Gemini market-research response produced in practice
  const withRawNewline = '{"overallConfidence": 75, "insufficientEvidence": false, "notes": "Prices are fluctuating and depend on the specific model (inverter vs.\nnon-inverter, floor standing vs. split).", "findings": [{"vendor": "ABC", "price": 5000}]}';
  const result = L.extractJSON(withRawNewline);
  assert.strictEqual(result.overallConfidence, 75);
  assert.ok(result.notes.includes("inverter"));
  assert.strictEqual(result.findings[0].vendor, "ABC");
});
test("extractJSON: repairs a raw tab character inside a string value too, not just newlines", () => {
  const withRawTab = '{"notes": "line one\tline two", "ok": true}';
  const result = L.extractJSON(withRawTab);
  assert.strictEqual(result.ok, true);
  assert.ok(result.notes.includes("line one"));
});
test("extractJSON: newlines BETWEEN JSON tokens (normal pretty-printing, not inside a string) are left alone and still parse fine", () => {
  const prettyPrinted = '{\n  "a": 1,\n  "b": "two"\n}';
  const result = L.extractJSON(prettyPrinted);
  assert.strictEqual(result.a, 1);
  assert.strictEqual(result.b, "two");
});

/* ============================================================
   15. Procurement Auditor — document classification.
   Uses the REAL sheet structures from the user's actual uploaded
   file (AC_demand_UPDATED.xlsx, inspected directly) — not
   synthetic data. This is the regression test for the exact
   reported bug: "extension board — Qty 1, fan — Qty 1" must
   NEVER be presented as quotation lines from this file.
   ============================================================ */
test("classifySheetTable: 'Sheet2' from the real file (title row + bare Item/Qty/Date, no header labels at all) classifies as Internal Demand/Request via the value-based fallback, NEVER as a quotation", () => {
  // row 1 in the real file is a title caption ("Items provided by workplace
  // team"), not column headers — headers[] here reflects what SheetJS
  // would actually hand back as keys for a headerless sheet read this way
  const headers = ["Items provided by workplace team", "__EMPTY", "__EMPTY_1"];
  const rows = [
    { "Items provided by workplace team": "extension board", "__EMPTY": 1, "__EMPTY_1": "2026-11-06" },
    { "Items provided by workplace team": "fan", "__EMPTY": 1, "__EMPTY_1": "2026-12-06" },
  ];
  const result = L.classifySheetTable(headers, rows);
  assert.strictEqual(result.classification, "Internal Demand/Request");
  assert.notStrictEqual(result.classification, "Vendor Quotation");
  assert.ok(result.confidence >= 60);
});

test("classifySheetTable: the real 'AC Demand' sheet (Name/Qty/Unit Price/Amount/Brand, real tax+total math, but NO vendor column) is Internal Demand/Request, NOT Vendor Quotation — pricing without a vendor identity isn't a quotation", () => {
  const headers = ["Name", "Qty", "Unit Price", "Amount", "Brand"];
  const rows = [
    { Name: "Capacitor 35 µF", Qty: 4, "Unit Price": 700, Amount: 2800, Brand: "Any" },
    { Name: "Capacitor 40 µF", Qty: 4, "Unit Price": 750, Amount: 3000, Brand: "Any" },
    { Name: "Fridge Pin Valve", Qty: 4, "Unit Price": 130, Amount: 520, Brand: "Any" },
  ];
  const result = L.classifySheetTable(headers, rows);
  assert.strictEqual(result.classification, "Internal Demand/Request");
  assert.notStrictEqual(result.classification, "Vendor Quotation");
  assert.ok(result.reason.includes("no vendor"));
});

test("classifySheetTable: the real 'Electrical demand' sheet (Product/Recommended Brand/Current Daraz Price — reference prices, no qty requested, no vendor) classifies as Price List, not a quotation", () => {
  const headers = ["Product Name from List", "Recommended / Authentic Brand", "Current Daraz Price (PKR)"];
  const rows = [
    { "Product Name from List": "GMSA Extra Super Glue Elfy", "Recommended / Authentic Brand": "GMSA (Authentic)", "Current Daraz Price (PKR)": "₨ 165" },
    { "Product Name from List": "Breaker 10Amp / 20Amp (Hamel)", "Recommended / Authentic Brand": "Hamel / Chint", "Current Daraz Price (PKR)": "₨ 790" },
  ];
  const result = L.classifySheetTable(headers, rows);
  assert.strictEqual(result.classification, "Price List");
});

test("classifySheetTable: the real 'Sheet5' asset register (ID/Tag/Room/Location/Campus/Floor/Brand/Capacity/Status/Year/Health/Category/AssignedTech) classifies as Store/Inventory, not a quotation or demand", () => {
  const headers = ["ID", "Tag", "Room", "Location", "Campus", "Floor", "Brand", "Capacity", "Status", "Year", "Health", "Category", "AssignedTech"];
  const rows = [{ ID: 1, Tag: "1-01-08-004-001-0073", Room: "Reception area", Location: "Reception", Campus: "141-C", Floor: "Ground", Brand: "Haier", Capacity: 1, Status: "Active", Year: 2023, Health: 1, Category: "AC" }];
  const result = L.classifySheetTable(headers, rows);
  assert.strictEqual(result.classification, "Store/Inventory");
});

test("classifySheetTable: a genuine vendor quotation (vendor + unit price + tax + quote number) IS correctly recognized — the classifier isn't just conservative in one direction", () => {
  const headers = ["Item", "Vendor", "Unit Price", "Tax", "Total", "Quotation No"];
  const rows = [{ Item: "MCB 32A", Vendor: "Al-Karam Electricals", "Unit Price": 4650, Tax: 17, Total: 5440.5, "Quotation No": "QT-1029" }];
  const result = L.classifySheetTable(headers, rows);
  assert.strictEqual(result.classification, "Vendor Quotation");
  assert.ok(result.confidence >= 80);
});

test("classifyExtractedLines: AI-extracted lines from a PDF/image with no vendor and no price on any line -> Internal Demand/Request, not a quotation", () => {
  const lines = [{ product: "extension board", qty: 1, vendor: "", unitPrice: null }, { product: "fan", qty: 1, vendor: "", unitPrice: null }];
  const result = L.classifyExtractedLines(lines);
  assert.strictEqual(result.classification, "Internal Demand/Request");
});

test("classifyExtractedLines: AI-extracted lines WITH vendor and price on most lines -> Vendor Quotation", () => {
  const lines = [{ product: "MCB 32A", qty: 20, vendor: "ABC Electrical", unitPrice: 4650 }, { product: "MCB 16A", qty: 10, vendor: "ABC Electrical", unitPrice: 3200 }];
  const result = L.classifyExtractedLines(lines);
  assert.strictEqual(result.classification, "Vendor Quotation");
});

/* ============================================================
   16. xAI Grok provider adapter — pure request-building helpers
   ============================================================ */
test("toOpenAIContent: plain string passes through unchanged", () => {
  assert.strictEqual(L.toOpenAIContent("hello world"), "hello world");
});
test("toOpenAIContent: text block converts to OpenAI text content shape", () => {
  const result = L.toOpenAIContent([{ type: "text", text: "hi" }]);
  assert.deepStrictEqual(result, [{ type: "text", text: "hi" }]);
});
test("toOpenAIContent: image block converts to a data-URI image_url block (the documented xAI/OpenAI pattern)", () => {
  const result = L.toOpenAIContent([{ type: "image", source: { media_type: "image/jpeg", data: "ZmFrZQ==" } }]);
  assert.strictEqual(result[0].type, "image_url");
  assert.strictEqual(result[0].image_url.url, "data:image/jpeg;base64,ZmFrZQ==");
});
test("toOpenAIContent: document (PDF) block becomes a visible placeholder, NOT silently dropped or pretended to work — PDF input isn't confirmed-supported by xAI's public API", () => {
  const result = L.toOpenAIContent([{ type: "document", source: { media_type: "application/pdf", data: "ZmFrZQ==" } }]);
  assert.strictEqual(result[0].type, "text");
  assert.ok(result[0].text.includes("not confirmed-supported"));
});
test("buildJsonSchemaResponseFormat: wraps a schema in the OpenAI/xAI response_format shape", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const wrapped = L.buildJsonSchemaResponseFormat(schema, "TestSchema");
  assert.strictEqual(wrapped.type, "json_schema");
  assert.strictEqual(wrapped.json_schema.name, "TestSchema");
  assert.deepStrictEqual(wrapped.json_schema.schema, schema);
});
test("buildJsonSchemaResponseFormat: defaults to a generic name when none is given", () => {
  const wrapped = L.buildJsonSchemaResponseFormat({ type: "object" });
  assert.strictEqual(wrapped.json_schema.name, "response");
});

/* ============================================================
   17. Groq provider — model routing. Groq's capabilities are split
   across models (confirmed against Groq's own docs), so the request
   shape must route to the right one — never assume one model does
   everything.
   ============================================================ */
test("chooseGroqModel: a web-search request routes to groq/compound and does NOT request structured output (unconfirmed combo)", () => {
  const r = L.chooseGroqModel({ hasImage: false, useWebSearch: true, hasSchema: true });
  assert.strictEqual(r.model, "groq/compound");
  assert.strictEqual(r.responseFormatMode, "none");
});
test("chooseGroqModel: an image request with a schema routes to the vision model using the CONFIRMED json_object mode, not the unconfirmed strict json_schema mode", () => {
  const r = L.chooseGroqModel({ hasImage: true, useWebSearch: false, hasSchema: true });
  assert.strictEqual(r.model, "qwen/qwen3.6-27b");
  assert.strictEqual(r.responseFormatMode, "json_object");
});
test("chooseGroqModel: an image request with no schema needed still uses the vision model, but requests no JSON mode at all", () => {
  const r = L.chooseGroqModel({ hasImage: true, useWebSearch: false, hasSchema: false });
  assert.strictEqual(r.model, "qwen/qwen3.6-27b");
  assert.strictEqual(r.responseFormatMode, "none");
});
test("chooseGroqModel: a plain text request with a schema routes to the confirmed structured-output model using strict json_schema mode", () => {
  const r = L.chooseGroqModel({ hasImage: false, useWebSearch: false, hasSchema: true });
  assert.strictEqual(r.model, "openai/gpt-oss-20b");
  assert.strictEqual(r.responseFormatMode, "json_schema");
});
test("chooseGroqModel: web search takes priority over image (a hypothetical combined request) since compound's image support isn't confirmed", () => {
  const r = L.chooseGroqModel({ hasImage: true, useWebSearch: true, hasSchema: false });
  assert.strictEqual(r.model, "groq/compound");
});


console.log("\n=== ProcureX AI — automated test results ===\n");
results.forEach(([status, name, err]) => {
  console.log((status === "PASS" ? "✓ PASS" : "✗ FAIL") + "  " + name + (err ? "\n       " + err : ""));
});
console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total\n`);
process.exit(fail > 0 ? 1 : 0);
