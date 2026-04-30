const EDGAR_BASE = "https://data.sec.gov";
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || "Exposure/1.0 exposure-app@example.com";
const HEADERS = { "User-Agent": SEC_USER_AGENT, "Accept": "application/json" };
const FETCH_TIMEOUT_MS = 30_000;

let tickerCache = null;
let tickerCacheExpiry = 0;

const USD_SERIES = {
  revenue: [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
  ],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "CapitalExpendituresIncurredButNotYetPaid"],
  rdExpense: ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "Cash", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  inventory: ["InventoryNet", "InventoriesNetOfReserves"],
  accountsReceivable: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
  debtTotal: [
    "LongTermDebtAndCapitalLeaseObligations",
    "LongTermDebtAndFinanceLeaseObligations",
    "DebtAndFinanceLeaseObligations",
    "DebtInstrumentFaceAmount",
  ],
  debtCurrent: [
    "LongTermDebtAndCapitalLeaseObligationsCurrent",
    "LongTermDebtAndFinanceLeaseObligationsCurrent",
    "LongTermDebtCurrent",
    "ShortTermBorrowings",
    "ShortTermDebt",
    "CommercialPaper",
  ],
  debtNoncurrent: [
    "LongTermDebtAndCapitalLeaseObligationsNoncurrent",
    "LongTermDebtAndFinanceLeaseObligationsNoncurrent",
    "LongTermDebtNoncurrent",
  ],
};

const SHARE_SERIES = {
  sharesOutstanding: [
    "CommonStockSharesOutstanding",
    "EntityCommonStockSharesOutstanding",
  ],
};

async function secFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getTickerMap() {
  if (Date.now() < tickerCacheExpiry && tickerCache) return tickerCache;
  const data = await secFetch("https://www.sec.gov/files/company_tickers.json");
  if (data) {
    tickerCache = data;
    tickerCacheExpiry = Date.now() + 24 * 60 * 60 * 1000;
  }
  return tickerCache;
}

async function lookupCIK(ticker) {
  const map = await getTickerMap();
  if (!map) return null;
  const entry = Object.values(map).find((candidate) => candidate.ticker.toUpperCase() === ticker.toUpperCase());
  return entry ? String(entry.cik_str).padStart(10, "0") : null;
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{10}$/;

function normalizeForTitleMatch(name) {
  return name
    .toUpperCase()
    .replace(/\s+(INC\.?|CORP\.?|CO\.?|LTD\.?|PLC|SE|AG|ADR|CLASS\s+[ABC]|[ABC])$/, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function lookupCIKByDisplayName(displayName) {
  const map = await getTickerMap();
  if (!map) return null;
  const needle = normalizeForTitleMatch(displayName);
  if (!needle) return null;

  let bestCIK = null;
  let bestScore = -1;

  for (const entry of Object.values(map)) {
    const title = normalizeForTitleMatch(entry.title || "");
    if (!title) continue;
    if (title === needle || title.startsWith(needle)) {
      const score = title === needle ? 2 : 1;
      if (score > bestScore) {
        bestScore = score;
        bestCIK = String(entry.cik_str).padStart(10, "0");
      }
    }
  }

  return bestCIK;
}

function extractUnitSeries(facts, concepts, units) {
  for (const concept of concepts) {
    const metric = facts?.["us-gaap"]?.[concept];
    if (!metric?.units) continue;
    for (const unit of units) {
      const series = metric.units?.[unit];
      if (Array.isArray(series) && series.length) {
        return sanitizeSeries(series);
      }
    }
  }
  return [];
}

function sanitizeSeries(series) {
  return series
    .map((entry) => ({
      val: toNumber(entry?.val),
      start: entry?.start || null,
      end: entry?.end || null,
      fy: entry?.fy || null,
      fp: entry?.fp || null,
      form: entry?.form || null,
      filed: entry?.filed || null,
      frame: entry?.frame || null,
    }))
    .filter((entry) => entry.val != null && entry.end);
}

function toNumber(value) {
  return Number.isFinite(value) ? value : Number.isFinite(Number(value)) ? Number(value) : null;
}

function durationDays(entry) {
  if (!entry?.start || !entry?.end) return null;
  const start = new Date(entry.start);
  const end = new Date(entry.end);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return null;
  return Math.round((end - start) / 86_400_000) + 1;
}

function fiscalYear(entry) {
  return String(entry?.fy || entry?.end?.slice(0, 4) || "");
}

function quarterNumber(entry) {
  const fp = String(entry?.fp || "").toUpperCase();
  if (fp === "Q1") return 1;
  if (fp === "Q2") return 2;
  if (fp === "Q3") return 3;
  if (fp === "Q4") return 4;
  return null;
}

function pickPreferredEntry(entries) {
  return [...entries].sort((a, b) => {
    const filedA = new Date(a.filed || a.end).valueOf();
    const filedB = new Date(b.filed || b.end).valueOf();
    return filedB - filedA;
  })[0] || null;
}

function buildAnnualDurationRecords(series) {
  const byYear = new Map();
  for (const entry of normalizeDurationSeries(series)) {
    const year = fiscalYear(entry);
    if (!year || entry.durationKind !== "full_year") continue;
    const group = byYear.get(year) || [];
    group.push(entry);
    byYear.set(year, group);
  }
  return [...byYear.entries()]
    .map(([year, entries]) => {
      const best = pickPreferredEntry(entries);
      return best ? { year, end: best.end, value: best.val } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.year.localeCompare(b.year))
    .slice(-6);
}

function buildAnnualInstantRecords(series) {
  const byYear = new Map();
  for (const entry of series) {
    const year = fiscalYear(entry);
    if (!year) continue;
    const group = byYear.get(year) || [];
    group.push(entry);
    byYear.set(year, group);
  }
  return [...byYear.entries()]
    .map(([year, entries]) => {
      const best = pickPreferredEntry(entries);
      return best ? { year, end: best.end, value: best.val } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.year.localeCompare(b.year))
    .slice(-6);
}

function buildQuarterlyDurationRecords(series, options = {}) {
  const normalized = normalizeDurationSeries(series);
  const grouped = new Map();

  for (const entry of normalized) {
    const fy = fiscalYear(entry);
    if (!fy || !entry.quarter && entry.durationKind !== "full_year") continue;
    const bucket = grouped.get(fy) || {
      q1Direct: [],
      q1Ytd: [],
      q2Direct: [],
      q2Ytd: [],
      q3Direct: [],
      q3Ytd: [],
      q4Direct: [],
      fyTotal: [],
    };

    if (entry.durationKind === "full_year") {
      bucket.fyTotal.push(entry);
    } else if (entry.quarter === 1) {
      if (entry.durationKind === "single_quarter" || entry.durationKind === "q1_ytd") bucket.q1Direct.push(entry);
      if (entry.durationKind === "q1_ytd") bucket.q1Ytd.push(entry);
    } else if (entry.quarter === 2) {
      if (entry.durationKind === "single_quarter") bucket.q2Direct.push(entry);
      if (entry.durationKind === "h1_ytd") bucket.q2Ytd.push(entry);
    } else if (entry.quarter === 3) {
      if (entry.durationKind === "single_quarter") bucket.q3Direct.push(entry);
      if (entry.durationKind === "q3_ytd") bucket.q3Ytd.push(entry);
    } else if (entry.quarter === 4 && entry.durationKind === "single_quarter") {
      bucket.q4Direct.push(entry);
    }

    grouped.set(fy, bucket);
  }

  const results = [];
  for (const [fy, bucket] of [...grouped.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const q1Entry = pickPreferredEntry(bucket.q1Direct);
    const q1YtdEntry = pickPreferredEntry(bucket.q1Ytd);
    const q2DirectEntry = pickPreferredEntry(bucket.q2Direct);
    const q2YtdEntry = pickPreferredEntry(bucket.q2Ytd);
    const q3DirectEntry = pickPreferredEntry(bucket.q3Direct);
    const q3YtdEntry = pickPreferredEntry(bucket.q3Ytd);
    const q4DirectEntry = pickPreferredEntry(bucket.q4Direct);
    const fyEntry = pickPreferredEntry(bucket.fyTotal);

    const q1 = sanitizeDerivedQuarter(
      q1Entry?.val ?? q1YtdEntry?.val ?? null,
      options
    );
    const q2 = sanitizeDerivedQuarter(
      q2DirectEntry?.val ?? subtractIfComparable(q2YtdEntry?.val, q1YtdEntry?.val ?? q1),
      options
    );
    const q3 = sanitizeDerivedQuarter(
      q3DirectEntry?.val ?? subtractIfComparable(q3YtdEntry?.val, q2YtdEntry?.val),
      options
    );
    const q4 = sanitizeDerivedQuarter(
      q4DirectEntry?.val ?? deriveFourthQuarter(fyEntry?.val, q1, q2, q3),
      options
    );

    pushQuarterResult(results, fy, 1, q1Entry || q1YtdEntry, q1);
    pushQuarterResult(results, fy, 2, q2DirectEntry || q2YtdEntry, q2);
    pushQuarterResult(results, fy, 3, q3DirectEntry || q3YtdEntry, q3);
    pushQuarterResult(results, fy, 4, q4DirectEntry || fyEntry, q4);
  }

  return results.slice(-8);
}

function normalizeDurationSeries(series) {
  return series
    .map((entry) => classifyDurationEntry(entry))
    .filter((entry) => entry.durationKind !== "unknown");
}

function classifyDurationEntry(entry) {
  const days = durationDays(entry);
  const fp = String(entry?.fp || "").toUpperCase();
  const form = String(entry?.form || "").toUpperCase();
  const quarter = quarterNumber(entry);

  let durationKind = "unknown";

  if (fp === "FY" || form === "10-K" || isFullYearDuration(days)) {
    durationKind = "full_year";
  } else if (quarter === 1) {
    durationKind = isQuarterDuration(days) ? "single_quarter" : "q1_ytd";
  } else if (quarter === 2) {
    durationKind = isQuarterDuration(days) ? "single_quarter" : isHalfYearDuration(days) ? "h1_ytd" : "unknown";
  } else if (quarter === 3) {
    durationKind = isQuarterDuration(days) ? "single_quarter" : isNineMonthDuration(days) ? "q3_ytd" : "unknown";
  } else if (quarter === 4) {
    durationKind = isQuarterDuration(days) ? "single_quarter" : isFullYearDuration(days) ? "full_year" : "unknown";
  } else if (isQuarterDuration(days)) {
    durationKind = "single_quarter";
  }

  return {
    ...entry,
    durationDays: days,
    durationKind,
    quarter,
  };
}

function isQuarterDuration(days) {
  return days != null && days >= 70 && days <= 110;
}

function isHalfYearDuration(days) {
  return days != null && days >= 160 && days <= 210;
}

function isNineMonthDuration(days) {
  return days != null && days >= 250 && days <= 300;
}

function isFullYearDuration(days) {
  return days != null && days >= 300 && days <= 380;
}

function subtractIfComparable(total, prior) {
  if (total == null || prior == null) return null;
  return total - prior;
}

function deriveFourthQuarter(fullYearTotal, q1, q2, q3) {
  if (fullYearTotal == null || q1 == null || q2 == null || q3 == null) return null;
  return fullYearTotal - q1 - q2 - q3;
}

function sanitizeDerivedQuarter(value, options = {}) {
  if (value == null || !Number.isFinite(value)) return null;
  if (options.requireNonNegative && value < 0) return null;
  return value;
}

function pushQuarterResult(results, fy, quarter, entry, value) {
  if (!entry || value == null) return;
  results.push({
    fy,
    quarter,
    end: entry.end,
    label: buildQuarterLabel(fy, quarter, entry.end),
    revenue: value,
  });
}

function buildQuarterLabel(fy, quarter, end) {
  if (quarter && fy) return `Q${quarter} FY${String(fy).slice(-2)}`;
  return end || "Quarter";
}

function latestValue(series) {
  if (!series.length) return null;
  return [...series]
    .sort((a, b) => new Date(b.end).valueOf() - new Date(a.end).valueOf())[0]?.val ?? null;
}

function annualMap(records) {
  const map = new Map();
  for (const row of records) {
    map.set(row.year, { year: row.year, end: row.end });
  }
  return map;
}

function assignAnnualMetric(map, records, key) {
  for (const row of records) {
    const target = map.get(row.year) || { year: row.year, end: row.end };
    target[key] = row.value;
    if (!target.end && row.end) target.end = row.end;
    map.set(row.year, target);
  }
}

function combineLatestValues(a, b) {
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}

function combineAnnualSeries(seriesA, seriesB) {
  const map = annualMap([...seriesA, ...seriesB]);
  assignAnnualMetric(map, seriesA, "a");
  assignAnnualMetric(map, seriesB, "b");
  return [...map.values()]
    .map((row) => ({
      year: row.year,
      end: row.end,
      value: combineLatestValues(row.a, row.b),
    }))
    .sort((a, b) => a.year.localeCompare(b.year))
    .slice(-6);
}

function extractFinancials(facts) {
  const annual = new Map();

  const revenueSeries = extractUnitSeries(facts, USD_SERIES.revenue, ["USD"]);
  const grossProfitSeries = extractUnitSeries(facts, USD_SERIES.grossProfit, ["USD"]);
  const operatingIncomeSeries = extractUnitSeries(facts, USD_SERIES.operatingIncome, ["USD"]);
  const netIncomeSeries = extractUnitSeries(facts, USD_SERIES.netIncome, ["USD"]);
  const operatingCashFlowSeries = extractUnitSeries(facts, USD_SERIES.operatingCashFlow, ["USD"]);
  const capexSeries = extractUnitSeries(facts, USD_SERIES.capex, ["USD"]);
  const rdExpenseSeries = extractUnitSeries(facts, USD_SERIES.rdExpense, ["USD"]);

  const revenueAnnual = buildAnnualDurationRecords(revenueSeries);
  const grossProfitAnnual = buildAnnualDurationRecords(grossProfitSeries);
  const operatingIncomeAnnual = buildAnnualDurationRecords(operatingIncomeSeries);
  const netIncomeAnnual = buildAnnualDurationRecords(netIncomeSeries);
  const operatingCashFlowAnnual = buildAnnualDurationRecords(operatingCashFlowSeries);
  const capexAnnual = buildAnnualDurationRecords(capexSeries);
  const rdExpenseAnnual = buildAnnualDurationRecords(rdExpenseSeries);

  const cashSeries = extractUnitSeries(facts, USD_SERIES.cash, ["USD"]);
  const assetsSeries = extractUnitSeries(facts, USD_SERIES.assets, ["USD"]);
  const liabilitiesSeries = extractUnitSeries(facts, USD_SERIES.liabilities, ["USD"]);
  const inventorySeries = extractUnitSeries(facts, USD_SERIES.inventory, ["USD"]);
  const receivablesSeries = extractUnitSeries(facts, USD_SERIES.accountsReceivable, ["USD"]);
  const currentAssetsSeries = extractUnitSeries(facts, USD_SERIES.currentAssets, ["USD"]);
  const currentLiabilitiesSeries = extractUnitSeries(facts, USD_SERIES.currentLiabilities, ["USD"]);
  const sharesSeries = extractUnitSeries(facts, SHARE_SERIES.sharesOutstanding, ["shares"]);
  const epsSeries = extractUnitSeries(facts, ["EarningsPerShareDiluted"], ["USD/shares"]);

  const debtTotalSeries = extractUnitSeries(facts, USD_SERIES.debtTotal, ["USD"]);
  const debtCurrentSeries = extractUnitSeries(facts, USD_SERIES.debtCurrent, ["USD"]);
  const debtNoncurrentSeries = extractUnitSeries(facts, USD_SERIES.debtNoncurrent, ["USD"]);

  const annualDebt = debtTotalSeries.length
    ? buildAnnualInstantRecords(debtTotalSeries)
    : combineAnnualSeries(buildAnnualInstantRecords(debtCurrentSeries), buildAnnualInstantRecords(debtNoncurrentSeries));

  const latestDebt = debtTotalSeries.length
    ? latestValue(debtTotalSeries)
    : combineLatestValues(latestValue(debtCurrentSeries), latestValue(debtNoncurrentSeries));

  assignAnnualMetric(annual, revenueAnnual, "revenue");
  assignAnnualMetric(annual, grossProfitAnnual, "grossProfit");
  assignAnnualMetric(annual, operatingIncomeAnnual, "operatingIncome");
  assignAnnualMetric(annual, netIncomeAnnual, "netIncome");
  assignAnnualMetric(annual, operatingCashFlowAnnual, "operatingCashFlow");
  assignAnnualMetric(annual, capexAnnual, "capex");
  assignAnnualMetric(annual, rdExpenseAnnual, "rdExpense");
  assignAnnualMetric(annual, buildAnnualInstantRecords(cashSeries), "cash");
  assignAnnualMetric(annual, buildAnnualInstantRecords(assetsSeries), "assets");
  assignAnnualMetric(annual, buildAnnualInstantRecords(liabilitiesSeries), "liabilities");
  assignAnnualMetric(annual, annualDebt, "debt");
  assignAnnualMetric(annual, buildAnnualInstantRecords(sharesSeries), "sharesOutstanding");

  return {
    version: 2,
    annual: [...annual.values()].sort((a, b) => a.year.localeCompare(b.year)).slice(-6),
    quarterly: buildQuarterlyDurationRecords(revenueSeries, { requireNonNegative: true }),
    latest: {
      cash: latestValue(cashSeries),
      assets: latestValue(assetsSeries),
      liabilities: latestValue(liabilitiesSeries),
      debt: latestDebt,
      sharesOutstanding: latestValue(sharesSeries),
      inventory: latestValue(inventorySeries),
      accountsReceivable: latestValue(receivablesSeries),
      currentAssets: latestValue(currentAssetsSeries),
      currentLiabilities: latestValue(currentLiabilitiesSeries),
      epsDiluted: latestValue(epsSeries),
    },
  };
}

export async function enrichCompany(ticker, displayName) {
  let cik;
  if (ISIN_RE.test(ticker)) {
    cik = displayName ? await lookupCIKByDisplayName(displayName) : null;
  } else {
    cik = await lookupCIK(ticker);
    if (!cik && displayName) cik = await lookupCIKByDisplayName(displayName);
  }
  if (!cik) return null;

  const [submissions, facts] = await Promise.all([
    secFetch(`${EDGAR_BASE}/submissions/CIK${cik}.json`),
    secFetch(`${EDGAR_BASE}/api/xbrl/companyfacts/CIK${cik}.json`),
  ]);

  if (!submissions) return null;

  const result = {
    name: submissions.name ?? null,
    cik: cik.replace(/^0+/, ""),
    sector: submissions.sicDescription ?? null,
    exchange: submissions.exchanges?.[0] ?? null,
    website: submissions.website ?? null,
    filings: [],
    financials: null,
  };

  const recent = submissions.filings?.recent;
  if (recent) {
    const forms = recent.form ?? [];
    const dates = recent.filingDate ?? [];
    const accNums = recent.accessionNumber ?? [];
    const docs = recent.primaryDocument ?? [];
    for (let i = 0; i < forms.length && result.filings.length < 12; i++) {
      if (!["10-K", "10-Q", "8-K"].includes(forms[i])) continue;
      const numericCIK = parseInt(cik, 10);
      const accClean = accNums[i]?.replace(/-/g, "") ?? "";
      result.filings.push({
        form: forms[i],
        date: dates[i],
        accessionNumber: accNums[i],
        url: `https://www.sec.gov/Archives/edgar/data/${numericCIK}/${accClean}/${docs[i] ?? ""}`,
        viewerUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${numericCIK}&type=${encodeURIComponent(forms[i])}&dateb=&owner=include&count=10`,
      });
    }
  }

  if (facts?.facts) {
    result.financials = extractFinancials(facts.facts);
  }

  return result;
}
