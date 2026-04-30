import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_TEMPLATE = (() => {
  try {
    return readFileSync(path.join(__dirname, "FINANCEREPORT.md"), "utf8");
  } catch {
    return "";
  }
})();

const PROMPT_VERSION = "finance-v1";
const FINANCIAL_SNAPSHOT_VERSION = 2;
const NARRATIVE_FALLBACK_POINT = "AI narrative is unavailable for this report version, so this section should be read alongside the deterministic SEC metrics above.";
const BASELINE_JSON_SCHEMA = `{
  "bullCase": ["point1", "point2", "point3", "point4", "point5", "point6"],
  "bearCase": ["point1", "point2", "point3", "point4", "point5", "point6"],
  "bottomLine": {
    "summary": "...",
    "keyTension": "...",
    "investorTakeaway": "..."
  }
}`;
const DEBATE_POINTS_JSON_SCHEMA = `{"points":["point1","point2","point3","point4","point5","point6"]}`;
const COMMITTEE_JSON_SCHEMA = `{"summary":"...","keyTension":"...","investorTakeaway":"..."}`;

export class FinanceError extends Error {
  constructor(message, status = 500, detail = "") {
    super(message);
    this.name = "FinanceError";
    this.status = status;
    this.detail = detail;
  }
}

export function buildNormalizedFinancials(company) {
  const financials = company?.financials;
  if (!financials) return null;

  if (financials.version === FINANCIAL_SNAPSHOT_VERSION && Array.isArray(financials.annual)) {
    return deriveFinancialSummary(financials);
  }

  return deriveFinancialSummary(normalizeLegacyFinancials(financials));
}

export function buildReportContext(company) {
  const normalizedFinancials = buildNormalizedFinancials(company);
  if (!normalizedFinancials) return null;
  const validation = normalizedFinancials.validation || buildValidationSummary(normalizedFinancials);

  return {
    company: {
      ticker: company.ticker,
      name: company.name || company.ticker,
      sector: company.sector || null,
      exchange: company.exchange || null,
      cik: company.cik || null,
      website: company.website || null,
      filings: Array.isArray(company.filings) ? company.filings : [],
    },
    financials: normalizedFinancials,
    validation,
    promptVersion: PROMPT_VERSION,
    financialSnapshotVersion: normalizedFinancials.version || FINANCIAL_SNAPSHOT_VERSION,
  };
}

export function buildFinancialPrompt(ticker, company) {
  const context = buildReportContext(company);
  if (!context || !context.validation.canGenerate) return "";
  return buildNarrativePrompt({
    mode: "baseline",
    reportContext: context,
  });
}

export async function generateCompanyReport({ company, lmUrl, model, mode = "baseline", timeoutMs }) {
  const reportContext = buildReportContext(company);
  if (!reportContext) {
    throw new FinanceError("No SEC financial data found for this ticker. It may not be a publicly traded US company.", 422);
  }
  if (!reportContext.validation.canGenerate) {
    throw new FinanceError("SEC data is incomplete for report generation. Wait for a fuller filing snapshot before generating a report.", 422);
  }

  const normalizedMode = mode === "debate" ? "debate" : "baseline";
  const narrative = await generateNarrativeWithFallback({
    reportContext,
    lmUrl,
    model,
    timeoutMs,
    mode: normalizedMode,
  });

  const contentHtml = renderReportHtml(reportContext, narrative);
  const generatedAt = new Date().toISOString();
  const source = narrative.meta.status === "ready"
    ? `lm-studio:${model}`
    : `deterministic-fallback:${model}`;

  return {
    report: {
      id: crypto.randomUUID(),
      ticker: company.ticker,
      reportType: "sec_analysis",
      title: `${company.ticker} ${normalizedMode === "debate" ? "Debate" : "Analysis"}`,
      contentHtml,
      source,
      generatedAt,
      metadata: {
        generationMode: normalizedMode,
        artifacts: narrative.artifacts || null,
        narrativeMeta: narrative.meta,
        validation: reportContext.validation,
        promptVersion: PROMPT_VERSION,
        financialSnapshotVersion: reportContext.financialSnapshotVersion,
      },
    },
    prompt: buildNarrativePrompt({
      mode: normalizedMode,
      reportContext,
      bullCase: narrative.artifacts?.bullCase || null,
      bearCase: narrative.artifacts?.bearCase || null,
    }),
    financials: reportContext.financials,
  };
}

async function generateNarrativeWithFallback({ reportContext, lmUrl, model, timeoutMs, mode }) {
  try {
    return mode === "debate"
      ? await generateDebateNarrative({ reportContext, lmUrl, model, timeoutMs })
      : await generateBaselineNarrative({ reportContext, lmUrl, model, timeoutMs });
  } catch (err) {
    return createDeterministicFallbackNarrative(reportContext, err);
  }
}

async function generateBaselineNarrative({ reportContext, lmUrl, model, timeoutMs }) {
  const prompt = buildNarrativePrompt({
    mode: "baseline",
    reportContext,
  });
  const completion = await requestStructuredCompletion({
    lmUrl,
    model,
    prompt,
    timeoutMs,
    maxTokens: 2600,
    label: "baseline narrative",
    schema: BASELINE_JSON_SCHEMA,
    normalize: normalizeBaselinePayload,
  });

  return {
    bullCase: completion.data.bullCase,
    bearCase: completion.data.bearCase,
    bottomLine: completion.data.bottomLine,
    artifacts: null,
    meta: {
      status: "ready",
      parseMode: completion.parseMode,
      retryCount: completion.retryCount,
      warnings: [],
    },
  };
}

async function generateDebateNarrative({ reportContext, lmUrl, model, timeoutMs }) {
  const bullCompletion = await requestStructuredCompletion({
    lmUrl,
    model,
    prompt: buildDebatePrompt("bull", reportContext),
    timeoutMs,
    maxTokens: 1800,
    label: "bull debate",
    schema: DEBATE_POINTS_JSON_SCHEMA,
    normalize: normalizeDebatePointsPayload,
  });
  const bearCompletion = await requestStructuredCompletion({
    lmUrl,
    model,
    prompt: buildDebatePrompt("bear", reportContext),
    timeoutMs,
    maxTokens: 1800,
    label: "bear debate",
    schema: DEBATE_POINTS_JSON_SCHEMA,
    normalize: normalizeDebatePointsPayload,
  });

  const bullCase = bullCompletion.data.points;
  const bearCase = bearCompletion.data.points;
  const committeeCompletion = await requestStructuredCompletion({
    lmUrl,
    model,
    prompt: buildNarrativePrompt({
      mode: "debate",
      reportContext,
      bullCase,
      bearCase,
    }),
    timeoutMs,
    maxTokens: 1600,
    label: "debate committee",
    schema: COMMITTEE_JSON_SCHEMA,
    normalize: normalizeBottomLinePayload,
  });

  return {
    bullCase,
    bearCase,
    bottomLine: committeeCompletion.data,
    artifacts: {
      bullCase,
      bearCase,
      committee: committeeCompletion.data,
    },
    meta: {
      status: "ready",
      parseMode: [
        bullCompletion.parseMode,
        bearCompletion.parseMode,
        committeeCompletion.parseMode,
      ].join(","),
      retryCount: bullCompletion.retryCount + bearCompletion.retryCount + committeeCompletion.retryCount,
      warnings: [],
    },
  };
}

async function requestStructuredCompletion({ lmUrl, model, prompt, timeoutMs, maxTokens, label, schema, normalize }) {
  const attempts = [];
  let currentPrompt = prompt;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callLmStudio({ lmUrl, model, prompt: currentPrompt, timeoutMs, maxTokens });

    try {
      const parsed = normalize(parseJsonResponse(raw, label));
      return {
        data: parsed,
        parseMode: attempt === 1 ? "strict" : "json-repair",
        retryCount: attempt - 1,
      };
    } catch (err) {
      attempts.push(`${label} attempt ${attempt}: ${err.message}`);
      if (attempt === 2) {
        throw new FinanceError(`LM Studio returned invalid JSON for ${label}`, 502, attempts.join(" | ").slice(0, 500));
      }
      currentPrompt = buildJsonRepairPrompt({ raw, schema, label });
    }
  }

  throw new FinanceError(`LM Studio returned invalid JSON for ${label}`, 502);
}

async function callLmStudio({ lmUrl, model, prompt, timeoutMs, maxTokens }) {
  let llmRes;
  try {
    llmRes = await fetch(`${lmUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
      signal: Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    if (err.name === "TimeoutError") throw err;
    throw new FinanceError("Could not reach LM Studio", 503, err.message);
  }

  if (!llmRes.ok) {
    const text = await llmRes.text().catch(() => "");
    throw new FinanceError(`LM Studio returned ${llmRes.status}`, 502, text.slice(0, 300));
  }

  const data = await llmRes.json().catch(() => ({}));
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) {
    throw new FinanceError("LM Studio returned empty content", 502);
  }
  return content;
}

function parseJsonResponse(raw, label) {
  const trimmed = unwrapModelText(raw);
  const candidates = [trimmed];
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) candidates.push(match[0]);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  throw new FinanceError(`LM Studio returned invalid JSON for ${label}`, 502, trimmed.slice(0, 400));
}

function buildJsonRepairPrompt({ raw, schema, label }) {
  return `Rewrite the following response as valid JSON only for ${label}.

Required schema:
${schema}

Rules:
- Return JSON only.
- Do not include markdown fences.
- Do not add commentary.
- Preserve only grounded statements from the source response.

Source response:
${unwrapModelText(raw)}`;
}

function unwrapModelText(raw) {
  return String(raw || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
}

function normalizeBottomLine(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    summary: normalizeParagraph(source.summary),
    keyTension: normalizeParagraph(source.keyTension),
    investorTakeaway: normalizeParagraph(source.investorTakeaway),
  };
}

function normalizeParagraph(value) {
  const text = sanitizeNarrativeText(value);
  return text || "Insufficient grounded filing data to support a strong conclusion beyond the reported SEC metrics.";
}

function normalizePointList(value, minimumLength = 6) {
  const points = Array.isArray(value)
    ? value.map((entry) => sanitizeNarrativeText(entry)).filter(Boolean)
    : [];

  const trimmed = points.slice(0, 8);
  while (trimmed.length < minimumLength) {
    trimmed.push(NARRATIVE_FALLBACK_POINT);
  }
  return trimmed;
}

function normalizeBaselinePayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Baseline payload must be an object");
  }
  return {
    bullCase: normalizePointList(input.bullCase, 6),
    bearCase: normalizePointList(input.bearCase, 6),
    bottomLine: normalizeBottomLine(input.bottomLine),
  };
}

function normalizeDebatePointsPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Debate payload must be an object");
  }
  return {
    points: normalizePointList(input.points || input.bullCase || input.bearCase, 6),
  };
}

function normalizeBottomLinePayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Bottom-line payload must be an object");
  }
  return normalizeBottomLine(input.bottomLine || input);
}

function createDeterministicFallbackNarrative(reportContext, err) {
  const companyName = reportContext.company.name || reportContext.company.ticker;
  const reason = err?.message || "AI narrative generation failed";
  return {
    bullCase: normalizePointList([
      `${companyName}'s report still includes deterministic SEC-derived KPIs, annual financials, quarterly revenue, and balance-sheet metrics.`,
      "Use the revenue, operating income, net income, cash flow, and capital spending trends as the primary evidence base.",
      "If the company has consistent multi-year operating progress, that signal remains visible even without AI commentary.",
    ], 6),
    bearCase: normalizePointList([
      "Narrative commentary was withheld because the AI response did not satisfy the required JSON contract.",
      "Missing deterministic fields are called out in the report warnings and should narrow confidence in any conclusion.",
      "Do not infer omitted metrics such as gross margin, leverage, or current ratio when the SEC dataset did not validate them.",
    ], 6),
    bottomLine: {
      summary: "Narrative unavailable. Review the deterministic SEC-derived financial sections in this report.",
      keyTension: "The financial dataset is available, but the AI narrative response was rejected because it did not meet the structured output contract.",
      investorTakeaway: "Use the KPI grid, annual summary, quarterly trend, and balance-sheet snapshot directly until a validated narrative can be regenerated.",
    },
    artifacts: null,
    meta: {
      status: "degraded",
      parseMode: "deterministic-only",
      retryCount: 1,
      warnings: [reason],
    },
  };
}

function buildNarrativePrompt({ mode, reportContext, bullCase = null, bearCase = null }) {
  const { company, financials, validation } = reportContext;
  const templateSection = REPORT_TEMPLATE
    ? `\nReport template reference:\n${REPORT_TEMPLATE}\n`
    : "";

  const annualRows = financials.annual.map((row) => (
    `${row.year}: revenue=${formatMoney(row.revenue)}, grossProfit=${formatMoney(row.grossProfit)}, grossMargin=${formatPercent(safeDivide(row.grossProfit, row.revenue), 1)}, operatingIncome=${formatMoney(row.operatingIncome)}, netIncome=${formatMoney(row.netIncome)}, operatingCashFlow=${formatMoney(row.operatingCashFlow)}, capex=${formatMoney(row.capex)}, freeCashFlow=${formatMoney(computeFreeCashFlow(row))}, cash=${formatMoney(row.cash)}, assets=${formatMoney(row.assets)}, liabilities=${formatMoney(row.liabilities)}, debt=${formatMoney(row.debt)}`
  )).join("\n");

  const quarterlyRows = financials.quarterly.map((row) => (
    `${row.label}: revenue=${formatMoney(row.revenue)}`
  )).join("\n");

  const metricRows = financials.kpis.filter((kpi) => kpi.visible).map((kpi) => (
    `${kpi.label}: value=${kpi.valueText}, change=${kpi.changeText || "n/a"}`
  )).join("\n");

  const latestPeriod = financials.latestReportedPeriod?.label || "Latest validated filing period unavailable";
  const allowedFacts = [
    "Revenue trend and growth rates present in the provided annual and quarterly rows",
    "Gross profit and gross margin only if explicitly present in the provided rows",
    "Operating income, net income, operating cash flow, capex, and free cash flow only if explicitly present",
    "Cash, assets, liabilities, debt, shares outstanding, EPS, and current-ratio inputs only if explicitly present",
    "Comparative statements limited to the provided year-over-year or period-over-period numbers",
  ].join("\n");

  const forbiddenClaims = [
    "Do not mention market share, TAM, competitive position, moat, customers, contracts, regulation, antitrust, unionization, macro, or stock price action unless those facts are explicitly provided below.",
    "Do not mention business segments like AWS, advertising, Prime, cloud, retail, or geography unless they are explicitly provided below.",
    "If a claim cannot be tied directly to a supplied metric, omit it.",
  ].join(" ");

  const constraints = [
    "Use only the provided SEC/XBRL-derived data.",
    forbiddenClaims,
    "If data is missing, state that clearly instead of guessing.",
    "Do not recompute or override the provided KPI values.",
    `The most recent validated filing period is: ${latestPeriod}.`,
    validation.warnings.length ? `Known data limitations: ${validation.warnings.join(" ")}` : "No additional data limitations.",
  ].join(" ");

  if (mode === "debate") {
    return `You are the final investment committee writer for a filing-grounded company report.${templateSection}
Company: ${company.name} (${company.ticker})${company.sector ? `, sector ${company.sector}` : ""}${company.exchange ? `, exchange ${company.exchange}` : ""}
Most recent validated filing period: ${latestPeriod}

Deterministic KPI snapshot:
${metricRows}

Annual data:
${annualRows || "No annual data available."}

Quarterly revenue:
${quarterlyRows || "No quarterly data available."}

Allowed evidence categories:
${allowedFacts}

Bull case points:
${(bullCase || []).map((point, index) => `${index + 1}. ${point}`).join("\n")}

Bear case points:
${(bearCase || []).map((point, index) => `${index + 1}. ${point}`).join("\n")}

Return valid JSON only in this exact shape:
{"summary":"...","keyTension":"...","investorTakeaway":"..."}

${constraints}`;
  }

  return `You are a filing-grounded investment analyst.${templateSection}
Company: ${company.name} (${company.ticker})${company.sector ? `, sector ${company.sector}` : ""}${company.exchange ? `, exchange ${company.exchange}` : ""}
Most recent validated filing period: ${latestPeriod}

Deterministic KPI snapshot:
${metricRows}

Annual data:
${annualRows || "No annual data available."}

Quarterly revenue:
${quarterlyRows || "No quarterly data available."}

Allowed evidence categories:
${allowedFacts}

Return valid JSON only in this exact shape:
{
  "bullCase": ["point1", "point2", "point3", "point4", "point5", "point6"],
  "bearCase": ["point1", "point2", "point3", "point4", "point5", "point6"],
  "bottomLine": {
    "summary": "...",
    "keyTension": "...",
    "investorTakeaway": "..."
  }
}

${constraints}`;
}

function buildDebatePrompt(side, reportContext) {
  const { company, financials, validation } = reportContext;
  const annualRows = financials.annual.map((row) => (
    `${row.year}: revenue=${formatMoney(row.revenue)}, grossProfit=${formatMoney(row.grossProfit)}, grossMargin=${formatPercent(safeDivide(row.grossProfit, row.revenue), 1)}, operatingIncome=${formatMoney(row.operatingIncome)}, netIncome=${formatMoney(row.netIncome)}, operatingCashFlow=${formatMoney(row.operatingCashFlow)}, capex=${formatMoney(row.capex)}, freeCashFlow=${formatMoney(computeFreeCashFlow(row))}, cash=${formatMoney(row.cash)}, assets=${formatMoney(row.assets)}, liabilities=${formatMoney(row.liabilities)}, debt=${formatMoney(row.debt)}`
  )).join("\n");

  const quarterlyRows = financials.quarterly.map((row) => `${row.label}: revenue=${formatMoney(row.revenue)}`).join("\n");
  const latestPeriod = financials.latestReportedPeriod?.label || "Latest validated filing period unavailable";

  return `You are the ${side === "bull" ? "bullish" : "bearish"} side of an investment debate for ${company.name} (${company.ticker}).

Use only the SEC/XBRL-derived data below. The most recent validated filing period is ${latestPeriod}. Do not invent business facts, segment commentary, macro commentary, competitive positioning, regulatory claims, or price action. If support is weak, say so and keep the claim narrow.

Annual data:
${annualRows || "No annual data available."}

Quarterly revenue:
${quarterlyRows || "No quarterly data available."}

Known data limitations:
${validation.warnings.join(" ") || "None."}

Return valid JSON only:
{"points":["point1","point2","point3","point4","point5","point6"]}

Write exactly 6 to 8 concise points with strong grounding in the supplied numbers. Every point must directly reference only the supplied financial evidence or explicitly mention that the evidence is limited.`;
}

function normalizeLegacyFinancials(financials) {
  const annualByYear = new Map();
  const mergeLegacySeries = (series, key) => {
    for (const entry of Array.isArray(series) ? series : []) {
      const year = String(entry?.year || "");
      if (!year) continue;
      const row = annualByYear.get(year) || { year };
      row[key] = toNumber(entry?.value);
      if (entry?.end) row.end = entry.end;
      annualByYear.set(year, row);
    }
  };

  mergeLegacySeries(financials.annualRevenue, "revenue");
  mergeLegacySeries(financials.annualGrossProfit, "grossProfit");
  mergeLegacySeries(financials.annualOperatingIncome, "operatingIncome");
  mergeLegacySeries(financials.annualNetIncome, "netIncome");
  mergeLegacySeries(financials.annualOperatingCashFlow, "operatingCashFlow");
  mergeLegacySeries(financials.annualCapex, "capex");

  const annual = [...annualByYear.values()]
    .sort((a, b) => String(a.year).localeCompare(String(b.year)))
    .slice(-6);

  const quarterly = (Array.isArray(financials.quarterlyRevenue) ? financials.quarterlyRevenue : [])
    .map((entry, index) => ({
      fy: null,
      quarter: null,
      label: entry?.period || `Quarter ${index + 1}`,
      end: entry?.period || null,
      revenue: toNumber(entry?.value),
    }))
    .slice(-8);

  return {
    version: 1,
    annual,
    quarterly,
    latest: {
      cash: toNumber(financials.latestCash),
      assets: toNumber(financials.latestAssets),
      liabilities: toNumber(financials.latestLiabilities),
      debt: null,
      sharesOutstanding: null,
      inventory: null,
      accountsReceivable: null,
      currentAssets: null,
      currentLiabilities: null,
      epsDiluted: toNumber(financials.latestEpsDiluted),
    },
  };
}

function deriveFinancialSummary(financials) {
  const annual = [...(financials.annual || [])]
    .map((row) => ({
      year: String(row.year),
      end: row.end || null,
      revenue: toNumber(row.revenue),
      grossProfit: toNumber(row.grossProfit),
      operatingIncome: toNumber(row.operatingIncome),
      netIncome: toNumber(row.netIncome),
      operatingCashFlow: toNumber(row.operatingCashFlow),
      capex: toNumber(row.capex),
      cash: toNumber(row.cash),
      assets: toNumber(row.assets),
      liabilities: toNumber(row.liabilities),
      debt: toNumber(row.debt),
      sharesOutstanding: toNumber(row.sharesOutstanding),
      rdExpense: toNumber(row.rdExpense),
    }))
    .sort((a, b) => a.year.localeCompare(b.year))
    .slice(-6);

  const quarterly = [...(financials.quarterly || [])]
    .map((row) => ({
      fy: row.fy || null,
      quarter: row.quarter || null,
      label: row.label || buildQuarterLabel(row.fy, row.quarter, row.end),
      end: row.end || null,
      revenue: toNumber(row.revenue),
    }))
    .filter((row) => row.revenue != null)
    .sort((a, b) => String(a.end || "").localeCompare(String(b.end || "")))
    .slice(-8);

  const latestAnnual = annual.at(-1) || null;
  const previousAnnual = annual.length > 1 ? annual.at(-2) : null;
  const latestQuarter = quarterly.at(-1) || null;
  const latestReportedPeriod = pickLatestReportedPeriod({ latestAnnual, latestQuarter });
  const latest = {
    cash: toNumber(financials.latest?.cash),
    assets: toNumber(financials.latest?.assets),
    liabilities: toNumber(financials.latest?.liabilities),
    debt: toNumber(financials.latest?.debt),
    sharesOutstanding: toNumber(financials.latest?.sharesOutstanding),
    inventory: toNumber(financials.latest?.inventory),
    accountsReceivable: toNumber(financials.latest?.accountsReceivable),
    currentAssets: toNumber(financials.latest?.currentAssets),
    currentLiabilities: toNumber(financials.latest?.currentLiabilities),
    epsDiluted: toNumber(financials.latest?.epsDiluted),
  };

  if (latest.cash == null && latestAnnual?.cash != null) latest.cash = latestAnnual.cash;
  if (latest.assets == null && latestAnnual?.assets != null) latest.assets = latestAnnual.assets;
  if (latest.liabilities == null && latestAnnual?.liabilities != null) latest.liabilities = latestAnnual.liabilities;
  if (latest.debt == null && latestAnnual?.debt != null) latest.debt = latestAnnual.debt;
  if (latest.sharesOutstanding == null && latestAnnual?.sharesOutstanding != null) latest.sharesOutstanding = latestAnnual.sharesOutstanding;

  const validation = buildValidationSummary({ annual, quarterly, latestAnnual, previousAnnual, latest });
  const kpis = buildKpiCards({ latestAnnual, previousAnnual, latest, latestQuarter, latestReportedPeriod });
  const ratios = buildRatios({ latestAnnual, previousAnnual, latest });
  const balanceSnapshot = buildBalanceSnapshot({ latestAnnual, latest });

  return {
    version: financials.version || FINANCIAL_SNAPSHOT_VERSION,
    annual,
    quarterly,
    latestAnnual,
    previousAnnual,
    latestQuarter,
    latestReportedPeriod,
    latest,
    kpis,
    ratios,
    balanceSnapshot,
    validation,
  };
}

function buildValidationSummary({ annual, quarterly, latestAnnual, previousAnnual, latest }) {
  const requiredFields = [
    ["latestAnnual.revenue", latestAnnual?.revenue],
    ["latestAnnual.operatingIncome", latestAnnual?.operatingIncome],
    ["latestAnnual.netIncome", latestAnnual?.netIncome],
    ["latestAnnual.operatingCashFlow", latestAnnual?.operatingCashFlow],
  ];
  const optionalFields = [
    ["latestAnnual.grossProfit", latestAnnual?.grossProfit],
    ["latest.cash", latest?.cash],
    ["latest.assets", latest?.assets],
    ["latest.liabilities", latest?.liabilities],
    ["latest.debt", latest?.debt],
    ["latest.sharesOutstanding", latest?.sharesOutstanding],
    ["latest.currentAssets", latest?.currentAssets],
    ["latest.currentLiabilities", latest?.currentLiabilities],
    ["latestAnnual.rdExpense", latestAnnual?.rdExpense],
  ];

  const missingCritical = requiredFields.filter(([, value]) => value == null).map(([label]) => label);
  const missingOptional = optionalFields.filter(([, value]) => value == null).map(([label]) => label);
  const warnings = [];

  if (annual.length < 3) warnings.push("Historical annual coverage is limited.");
  if (quarterly.length < 4) warnings.push("Quarterly revenue coverage is limited.");
  if (missingOptional.includes("latestAnnual.grossProfit")) warnings.push("Gross profit data is unavailable, so gross margin metrics are suppressed.");
  if (missingOptional.includes("latest.debt")) warnings.push("Debt data is unavailable, so leverage conclusions are suppressed.");
  if (missingOptional.includes("latest.sharesOutstanding")) warnings.push("Shares outstanding data is unavailable.");
  if (missingOptional.includes("latest.currentAssets") || missingOptional.includes("latest.currentLiabilities")) {
    warnings.push("Working-capital inputs are incomplete, so current-ratio metrics are suppressed.");
  }
  if (latestAnnual && previousAnnual == null) warnings.push("Prior-year comparison is unavailable for some change metrics.");

  return {
    canGenerate: annual.length >= 2 && missingCritical.length === 0,
    missingCritical,
    missingOptional,
    warnings,
  };
}

function buildKpiCards({ latestAnnual, previousAnnual, latest, latestQuarter, latestReportedPeriod }) {
  return [
    buildCard(
      latestQuarter ? `Latest Reported Revenue (${latestQuarter.label})` : "Latest Revenue",
      latestQuarter?.revenue ?? latestAnnual?.revenue,
      latestQuarter
        ? quarterReferenceText(latestQuarter)
        : yoyText(latestAnnual?.revenue, previousAnnual?.revenue)
    ),
    buildTextCard("Latest Reported Period", latestReportedPeriod?.label || "—", Boolean(latestReportedPeriod?.label)),
    buildCard("Gross Profit", latestAnnual?.grossProfit, yoyText(latestAnnual?.grossProfit, previousAnnual?.grossProfit)),
    buildCard("Gross Margin", safeDivide(latestAnnual?.grossProfit, latestAnnual?.revenue), marginDeltaText(latestAnnual, previousAnnual, "grossProfit"), "percent"),
    buildCard("Operating Income", latestAnnual?.operatingIncome, yoyText(latestAnnual?.operatingIncome, previousAnnual?.operatingIncome)),
    buildCard("Net Income", latestAnnual?.netIncome, yoyText(latestAnnual?.netIncome, previousAnnual?.netIncome)),
    buildCard("Cash & Equivalents", latest.cash, yoyText(latestAnnual?.cash, previousAnnual?.cash)),
    buildCard("Total Debt", latest.debt, yoyText(latestAnnual?.debt, previousAnnual?.debt), "money", latest.debt == null ? null : latest.debt < 1_000_000 ? "Near debt-free" : null),
    buildCard("Shares Outstanding", latest.sharesOutstanding, yoyText(latestAnnual?.sharesOutstanding, previousAnnual?.sharesOutstanding), "shares"),
  ].filter((card) => card.visible);
}

function buildRatios({ latestAnnual, previousAnnual, latest }) {
  const grossMargin = safeDivide(latestAnnual?.grossProfit, latestAnnual?.revenue);
  const operatingMargin = safeDivide(latestAnnual?.operatingIncome, latestAnnual?.revenue);
  const netMargin = safeDivide(latestAnnual?.netIncome, latestAnnual?.revenue);
  const revenueGrowth = safeGrowth(latestAnnual?.revenue, previousAnnual?.revenue);
  const freeCashFlow = computeFreeCashFlow(latestAnnual);
  const rdShare = safeDivide(latestAnnual?.rdExpense, latestAnnual?.revenue);
  const currentRatio = safeDivide(latest.currentAssets, latest.currentLiabilities);
  const equity = latest.assets != null && latest.liabilities != null ? latest.assets - latest.liabilities : null;
  const debtToEquity = safeDivide(latest.debt, equity);
  const cashRunway = freeCashFlow != null && freeCashFlow < 0 ? safeDivide(latest.cash, Math.abs(freeCashFlow)) : null;

  return [
    buildMetricItem("Revenue Growth (YoY)", formatPercent(revenueGrowth, 1), revenueGrowth != null),
    buildMetricItem("Gross Margin", formatPercent(grossMargin, 1), grossMargin != null),
    buildMetricItem("Operating Margin", formatPercent(operatingMargin, 1), operatingMargin != null),
    buildMetricItem("Net Margin", formatPercent(netMargin, 1), netMargin != null),
    buildMetricItem("R&D as % of Revenue", formatPercent(rdShare, 1), rdShare != null),
    buildMetricItem("Operating Cash Flow", formatMoney(latestAnnual?.operatingCashFlow), latestAnnual?.operatingCashFlow != null),
    buildMetricItem("Free Cash Flow", formatMoney(freeCashFlow), freeCashFlow != null),
    buildMetricItem("Current Ratio", formatMultiple(currentRatio), currentRatio != null),
    buildMetricItem("Debt-to-Equity", formatMultiple(debtToEquity), debtToEquity != null),
    buildMetricItem("Cash Runway", cashRunway == null ? "&mdash;" : `${cashRunway.toFixed(1)} years`, cashRunway != null),
  ].filter((item) => item.visible);
}

function pickLatestReportedPeriod({ latestAnnual, latestQuarter }) {
  const annualEnd = latestAnnual?.end ? new Date(latestAnnual.end).valueOf() : Number.NEGATIVE_INFINITY;
  const quarterEnd = latestQuarter?.end ? new Date(latestQuarter.end).valueOf() : Number.NEGATIVE_INFINITY;

  if (quarterEnd > annualEnd && latestQuarter) {
    return {
      type: "quarter",
      label: latestQuarter.label || latestQuarter.end || "Latest quarter",
      end: latestQuarter.end || null,
    };
  }
  if (latestAnnual) {
    return {
      type: "annual",
      label: latestAnnual.year ? `FY ${latestAnnual.year}` : "Latest fiscal year",
      end: latestAnnual.end || null,
    };
  }
  return null;
}

function quarterReferenceText(latestQuarter) {
  if (!latestQuarter) return "—";
  if (latestQuarter.end) {
    return `Most recent filing period ended ${latestQuarter.end}`;
  }
  return "Most recent filing period";
}

function buildBalanceSnapshot({ latestAnnual, latest }) {
  const cash = latest.cash;
  const debt = latest.debt;
  const assets = latest.assets;
  const liabilities = latest.liabilities;
  const equity = assets != null && liabilities != null ? assets - liabilities : null;
  const netCash = cash != null && debt != null ? cash - debt : null;

  return [
    buildMetricItem("Cash & Equivalents", formatMoney(cash), cash != null),
    buildMetricItem("Total Debt", formatMoney(debt), debt != null),
    buildMetricItem("Net Cash", formatMoney(netCash), netCash != null),
    buildMetricItem("Total Assets", formatMoney(assets), assets != null),
    buildMetricItem("Total Liabilities", formatMoney(liabilities), liabilities != null),
    buildMetricItem("Stockholders' Equity", formatMoney(equity), equity != null),
    buildMetricItem("Inventory", formatMoney(latest.inventory), latest.inventory != null),
    buildMetricItem("Accounts Receivable", formatMoney(latest.accountsReceivable), latest.accountsReceivable != null),
    buildMetricItem("Latest EPS Diluted", latest.epsDiluted == null ? "&mdash;" : latest.epsDiluted.toFixed(2), latest.epsDiluted != null),
    buildMetricItem("Latest Fiscal Year", latestAnnual?.year || "&mdash;", Boolean(latestAnnual?.year)),
  ].filter((item) => item.visible);
}

function renderReportHtml(reportContext, narrative) {
  const { company, financials, validation } = reportContext;
  const annualColumns = financials.annual.slice(-5);
  const quarterSeries = financials.quarterly.slice(-8);
  const maxQuarterRevenue = Math.max(...quarterSeries.map((row) => Math.abs(row.revenue || 0)), 0);
  const reportDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const visibleKpis = financials.kpis.filter((kpi) => kpi.visible);
  const balanceSnapshot = financials.balanceSnapshot.filter((item) => item.visible);
  const ratioItems = financials.ratios.filter((item) => item.visible);
  const validationWarnings = [...validation.warnings];
  const narrativeWarnings = Array.isArray(narrative.meta?.warnings) ? narrative.meta.warnings : [];

  const annualTable = annualColumns.length >= 3
    ? `
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            ${annualColumns.map((row) => `<th>${escapeHtml(row.year)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${renderAnnualMetricRow("Revenue", annualColumns, (row) => row.revenue)}
          ${renderAnnualMetricRow("Revenue YoY", annualColumns, (row, index) => index === 0 ? null : safeGrowth(row.revenue, annualColumns[index - 1]?.revenue), "percent")}
          ${renderAnnualMetricRow("Gross Profit", annualColumns, (row) => row.grossProfit)}
          ${renderAnnualMetricRow("Gross Margin", annualColumns, (row) => safeDivide(row.grossProfit, row.revenue), "percent")}
          ${renderAnnualMetricRow("Operating Income", annualColumns, (row) => row.operatingIncome)}
          ${renderAnnualMetricRow("Net Income", annualColumns, (row) => row.netIncome)}
          ${renderAnnualMetricRow("Operating Cash Flow", annualColumns, (row) => row.operatingCashFlow)}
          ${renderAnnualMetricRow("CapEx", annualColumns, (row) => row.capex)}
          ${renderAnnualMetricRow("Free Cash Flow", annualColumns, (row) => computeFreeCashFlow(row))}
          ${renderAnnualMetricRow("Cash & Equivalents", annualColumns, (row) => row.cash)}
          ${renderAnnualMetricRow("Total Assets", annualColumns, (row) => row.assets)}
          ${renderAnnualMetricRow("Total Liabilities", annualColumns, (row) => row.liabilities)}
        </tbody>
      </table>
    `
    : `<div class="empty-note">Insufficient historical data</div>`;

  const quarterlySection = quarterSeries.length
    ? `
      <section>
        <h2>Quarterly Revenue Trend</h2>
        <div class="quarterly-list">
          ${quarterSeries.map((row) => {
            const width = maxQuarterRevenue > 0 ? Math.max((Math.abs(row.revenue || 0) / maxQuarterRevenue) * 100, 6) : 0;
            return `
              <div class="quarter-row">
                <div class="quarter-label">${escapeHtml(row.label)}</div>
                <div class="quarter-bar-shell"><div class="quarter-bar" style="width:${width.toFixed(1)}%"></div></div>
                <div class="quarter-value">${formatMoney(row.revenue)}</div>
              </div>
            `;
          }).join("")}
        </div>
      </section>
    `
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(company.name)} (${escapeHtml(company.ticker)}) Investment Analysis</title>
  <style>
    :root {
      --bg: #0a0a0f;
      --panel: #141420;
      --panel-2: #10101a;
      --border: #2a2a3a;
      --text: #e0e0e0;
      --muted: #9aa0b5;
      --accent: #6495ed;
      --positive: #4ade80;
      --negative: #f87171;
      --warning: #fbbf24;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.6;
      padding: 32px 18px 56px;
    }
    .wrap { max-width: 1120px; margin: 0 auto; }
    .header-card, .section-card, .callout, .debate-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
    }
    .header-card { padding: 28px; }
    h1 { margin: 0 0 10px; font-size: 2.1rem; }
    .subtitle { color: var(--muted); margin-top: 10px; }
    .badge-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 0.85rem;
      font-weight: 600;
      border: 1px solid var(--border);
      background: #1a1a2e;
      color: var(--accent);
    }
    .badge.secondary { color: var(--text); background: #12121b; }
    .meta-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .meta-card {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      background: #10101a;
    }
    .meta-card-label {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .meta-card-value {
      margin-top: 8px;
      font-size: 1.1rem;
      font-weight: 600;
    }
    section { margin-top: 26px; }
    h2 {
      color: var(--accent);
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
      margin: 0 0 16px;
      font-size: 1.25rem;
    }
    .section-card { padding: 20px; }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
    }
    .kpi-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .kpi-card:hover, .section-card:hover, .debate-card:hover { transform: translateY(-1px); border-color: #3a3a50; }
    .kpi-label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    .kpi-value { font-size: 2rem; font-weight: 700; margin-top: 10px; }
    .kpi-change { margin-top: 8px; font-size: 0.95rem; }
    .positive { color: var(--positive); }
    .negative { color: var(--negative); }
    .neutral { color: var(--text); }
    table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 10px; }
    th, td { padding: 12px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { background: #1a1a2e; color: var(--accent); }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .quarterly-list { display: flex; flex-direction: column; gap: 12px; }
    .quarter-row { display: grid; grid-template-columns: 90px 1fr 110px; gap: 12px; align-items: center; }
    .quarter-bar-shell { height: 14px; background: #11111a; border-radius: 999px; overflow: hidden; border: 1px solid var(--border); }
    .quarter-bar { height: 100%; background: linear-gradient(90deg, #0ea86d, #4ade80); }
    .metric-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 10px 24px;
    }
    .metric-item {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .metric-item span:first-child { color: var(--muted); }
    .note-list { display: flex; flex-direction: column; gap: 10px; }
    .note-item {
      padding: 12px 14px;
      border-radius: 10px;
      background: #10101a;
      border: 1px solid rgba(251, 191, 36, 0.16);
      color: var(--text);
    }
    .debate-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .debate-card { padding: 18px; }
    .debate-card.bull { border-color: rgba(74, 222, 128, 0.25); }
    .debate-card.bear { border-color: rgba(248, 113, 113, 0.25); }
    .debate-card h3 { margin: 0 0 12px; }
    .debate-card ul { margin: 0; padding-left: 0; list-style: none; }
    .debate-card li { margin: 10px 0; padding-left: 24px; position: relative; }
    .debate-card li::before {
      position: absolute;
      left: 0;
      top: 0;
      font-weight: 700;
    }
    .debate-card.bull li::before { content: "\\2713"; color: var(--positive); }
    .debate-card.bear li::before { content: "\\2717"; color: var(--negative); }
    .callout {
      border-color: rgba(255, 193, 7, 0.3);
      padding: 20px;
    }
    .callout h3 { margin: 0 0 12px; color: var(--warning); }
    .callout p { margin: 12px 0; }
    .footer {
      color: var(--muted);
      margin-top: 20px;
      font-size: 0.92rem;
      text-align: center;
    }
    .empty-note {
      color: var(--muted);
      padding: 14px 0 0;
    }
    @media (max-width: 720px) {
      body { padding: 18px 12px 40px; }
      .quarter-row { grid-template-columns: 1fr; }
      .quarter-value { text-align: left; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header-card">
      <h1>${escapeHtml(company.name)}</h1>
      <div class="badge-row">
        <span class="badge">${escapeHtml(company.ticker)}</span>
        <span class="badge secondary">${escapeHtml([company.sector, company.exchange].filter(Boolean).join(" / ") || "SEC Filing Data")}</span>
      </div>
      <div class="subtitle">Investment Analysis · Based on SEC Filings</div>
      <div class="meta-strip">
        <div class="meta-card">
          <div class="meta-card-label">Most Recent Filing Period</div>
          <div class="meta-card-value">${escapeHtml(financials.latestReportedPeriod?.label || "Unavailable")}</div>
        </div>
        <div class="meta-card">
          <div class="meta-card-label">Latest Quarterly Revenue</div>
          <div class="meta-card-value">${financials.latestQuarter?.revenue != null ? formatMoney(financials.latestQuarter.revenue) : "&mdash;"}</div>
        </div>
      </div>
    </div>

    <section>
      <h2>KPI Grid</h2>
      <div class="kpi-grid">
        ${visibleKpis.map((kpi) => `
          <div class="kpi-card">
            <div class="kpi-label">${escapeHtml(kpi.label)}</div>
            <div class="kpi-value ${kpi.valueClass}">${kpi.valueText}</div>
            <div class="kpi-change ${kpi.changeClass}">${escapeHtml(kpi.changeText || "—")}</div>
          </div>
        `).join("")}
      </div>
    </section>

    ${(validationWarnings.length || narrativeWarnings.length) ? `
      <section>
        <h2>Report Notes</h2>
        <div class="section-card">
          <div class="note-list">
            ${validationWarnings.map((warning) => `<div class="note-item">${escapeHtml(warning)}</div>`).join("")}
            ${narrativeWarnings.map((warning) => `<div class="note-item">${escapeHtml(warning)}</div>`).join("")}
          </div>
        </div>
      </section>
    ` : ""}

    <section>
      <h2>Annual Financial Summary</h2>
      <div class="section-card">${annualTable}</div>
    </section>

    ${quarterlySection}

    ${balanceSnapshot.length ? `
      <section>
        <h2>Balance Sheet Snapshot</h2>
        <div class="section-card">
          <div class="metric-list">
            ${balanceSnapshot.map((item) => `
              <div class="metric-item">
                <span>${escapeHtml(item.label)}</span>
                <span>${item.valueText}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </section>
    ` : ""}

    ${ratioItems.length ? `
      <section>
        <h2>Key Financial Ratios</h2>
        <div class="section-card">
          <div class="metric-list">
            ${ratioItems.map((item) => `
              <div class="metric-item">
                <span>${escapeHtml(item.label)}</span>
                <span>${item.valueText}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </section>
    ` : ""}

    <section>
      <h2>Bull Case / Bear Case</h2>
      <div class="debate-grid">
        <div class="debate-card bull">
          <h3>Bull Case</h3>
          <ul>${narrative.bullCase.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>
        </div>
        <div class="debate-card bear">
          <h3>Bear Case</h3>
          <ul>${narrative.bearCase.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>
        </div>
      </div>
    </section>

    <section>
      <h2>Bottom Line Verdict</h2>
      <div class="callout">
        <h3>&#9889; Bottom Line</h3>
        <p>${escapeHtml(narrative.bottomLine.summary)}</p>
        <p>${escapeHtml(narrative.bottomLine.keyTension)}</p>
        <p>${escapeHtml(narrative.bottomLine.investorTakeaway)}</p>
      </div>
    </section>

    <div class="footer">
      <div>Data sourced from SEC EDGAR filings via XBRL API · data.sec.gov</div>
      <div>Generated ${escapeHtml(reportDate)} · Not investment advice</div>
    </div>
  </div>
</body>
</html>`;
}

function renderAnnualMetricRow(label, annualColumns, valueGetter, format = "money") {
  const values = annualColumns.map((row, index) => valueGetter(row, index));
  if (!values.some((value) => value != null)) return "";
  return `
    <tr>
      <td>${escapeHtml(label)}</td>
      ${values.map((value) => {
        return `<td class="${classForValue(format === "percent" ? percentToDisplay(value) : value)}">${formatCellValue(value, format)}</td>`;
      }).join("")}
    </tr>
  `;
}

function formatCellValue(value, format) {
  if (format === "percent") return formatPercent(value, 1);
  if (format === "shares") return formatShares(value);
  return formatMoney(value);
}

function buildCard(label, value, changeText, format = "money", fallbackText = null) {
  const visible = value != null || fallbackText != null;
  const valueText = fallbackText || (format === "percent" ? formatPercent(value, 1) : format === "shares" ? formatShares(value) : formatMoney(value));
  return {
    label,
    valueText,
    valueClass: classForValue(format === "percent" ? percentToDisplay(value) : value),
    changeText: changeText || "—",
    changeClass: classForChange(changeText),
    visible,
  };
}

function buildTextCard(label, valueText, visible) {
  return {
    label,
    valueText,
    valueClass: "neutral",
    changeText: "—",
    changeClass: "neutral",
    visible,
  };
}

function buildMetricItem(label, valueText, visible) {
  return { label, valueText, visible };
}

function sanitizeNarrativeText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/[<>]/.test(text)) return "";
  if (/<!doctype html|<html|<body|<style|--[a-z-]+\s*:|meta charset|viewport/i.test(text)) return "";
  if (/^[.#][a-z0-9_-]+\s*\{/i.test(text)) return "";
  return text;
}

function buildQuarterLabel(fy, quarter, end) {
  if (quarter && fy) return `Q${quarter} FY${String(fy).slice(-2)}`;
  if (end) return end;
  return "Quarter";
}

function yoyText(current, previous) {
  const growth = safeGrowth(current, previous);
  if (growth == null) return "—";
  const direction = growth > 0 ? "up" : growth < 0 ? "down" : "flat";
  return direction === "flat" ? "Stable" : `${growth > 0 ? "Up" : "Down"} ${Math.abs(growth * 100).toFixed(1)}% YoY`;
}

function marginDeltaText(latestAnnual, previousAnnual, key) {
  const current = safeDivide(latestAnnual?.[key], latestAnnual?.revenue);
  const previous = safeDivide(previousAnnual?.[key], previousAnnual?.revenue);
  if (current == null || previous == null) return "—";
  const deltaBps = Math.round((current - previous) * 10_000);
  if (deltaBps === 0) return "Stable";
  return `${deltaBps > 0 ? "Up" : "Down"} ${Math.abs(deltaBps)} bps YoY`;
}

function classForChange(text) {
  if (!text || text === "—" || text === "Stable") return "neutral";
  if (/^up\b/i.test(text)) return "positive";
  if (/^down\b/i.test(text)) return "negative";
  return "neutral";
}

function classForValue(value) {
  if (value == null) return "neutral";
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function computeFreeCashFlow(row) {
  if (!row) return null;
  if (row.operatingCashFlow == null || row.capex == null) return null;
  return row.operatingCashFlow - Math.abs(row.capex);
}

function formatMoney(value) {
  if (value == null || Number.isNaN(value)) return "&mdash;";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatShares(value) {
  if (value == null || Number.isNaN(value)) return "&mdash;";
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  return value.toFixed(0);
}

function formatPercent(value, digits = 1) {
  if (value == null || Number.isNaN(value)) return "&mdash;";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatMultiple(value) {
  if (value == null || Number.isNaN(value)) return "&mdash;";
  return `${value.toFixed(2)}x`;
}

function safeDivide(a, b) {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

function safeGrowth(current, previous) {
  if (current == null || previous == null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

function percentToDisplay(value) {
  if (value == null) return null;
  return value * 100;
}

function toNumber(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return Number.isFinite(value) ? value : Number.isFinite(Number(value)) ? Number(value) : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
