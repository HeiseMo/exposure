const EDGAR_BASE = "https://data.sec.gov";
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || "Exposure/1.0 exposure-app@example.com";
const HEADERS = { "User-Agent": SEC_USER_AGENT, "Accept": "application/json" };
const FETCH_TIMEOUT_MS = 30_000;

let tickerCache = null;
let tickerCacheExpiry = 0;

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
  const entry = Object.values(map).find(
    (c) => c.ticker.toUpperCase() === ticker.toUpperCase()
  );
  return entry ? String(entry.cik_str).padStart(10, "0") : null;
}

function extractSeries(facts, ...concepts) {
  for (const concept of concepts) {
    const data = facts?.["us-gaap"]?.[concept]?.units?.USD;
    if (data?.length) return data;
  }
  return [];
}

function annualValues(series) {
  const byYear = new Map();
  for (const e of series) {
    if (e.form !== "10-K" || !e.end || !e.start) continue;
    const year = e.end.slice(0, 4);
    if (!byYear.has(year) || new Date(e.end) > new Date(byYear.get(year).end)) {
      byYear.set(year, { year, value: e.val, end: e.end });
    }
  }
  return [...byYear.values()].sort((a, b) => a.year.localeCompare(b.year)).slice(-6);
}

function quarterlyValues(series) {
  const byPeriod = new Map();
  for (const e of series) {
    if (!["10-Q", "10-K"].includes(e.form) || !e.end) continue;
    if (!byPeriod.has(e.end) || new Date(e.end) > new Date(byPeriod.get(e.end).end)) {
      byPeriod.set(e.end, { period: e.end, value: e.val, form: e.form });
    }
  }
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period)).slice(-8);
}

function latestValue(series) {
  if (!series.length) return null;
  return series
    .filter((e) => e.end)
    .sort((a, b) => new Date(b.end) - new Date(a.end))[0]?.val ?? null;
}

function extractFinancials(facts) {
  const revenue = extractSeries(
    facts,
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax"
  );
  const grossProfit = extractSeries(facts, "GrossProfit");
  const operatingIncome = extractSeries(facts, "OperatingIncomeLoss");
  const netIncome = extractSeries(facts, "NetIncomeLoss");
  const cash = extractSeries(facts, "CashAndCashEquivalentsAtCarryingValue", "Cash");
  const assets = extractSeries(facts, "Assets");
  const liabilities = extractSeries(facts, "Liabilities");
  const capex = extractSeries(facts, "PaymentsToAcquirePropertyPlantAndEquipment");
  const operatingCashFlow = extractSeries(facts, "NetCashProvidedByUsedInOperatingActivities");
  const eps = facts?.["us-gaap"]?.["EarningsPerShareDiluted"]?.units?.["USD/shares"] ?? [];

  return {
    annualRevenue: annualValues(revenue),
    annualGrossProfit: annualValues(grossProfit),
    annualOperatingIncome: annualValues(operatingIncome),
    annualNetIncome: annualValues(netIncome),
    annualOperatingCashFlow: annualValues(operatingCashFlow),
    annualCapex: annualValues(capex),
    quarterlyRevenue: quarterlyValues(revenue),
    latestCash: latestValue(cash),
    latestAssets: latestValue(assets),
    latestLiabilities: latestValue(liabilities),
    latestEpsDiluted: eps.length
      ? eps.filter((e) => e.end).sort((a, b) => new Date(b.end) - new Date(a.end))[0]?.val ?? null
      : null,
  };
}

export async function enrichCompany(ticker) {
  const cik = await lookupCIK(ticker);
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

  if (facts) {
    result.financials = extractFinancials(facts);
  }

  return result;
}
