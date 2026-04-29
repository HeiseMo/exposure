import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createStore, validateSettings } from "./store.js";
import { enrichCompany } from "./sec.js";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPORT_TEMPLATE = (() => {
  try {
    return readFileSync(path.join(__dirname, "FINANCEREPORT.md"), "utf8");
  } catch {
    return "";
  }
})();

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dbPath = process.env.SQLITE_PATH || path.join(dataDir, "exposure.sqlite");
const port = Number(process.env.PORT || 3000);
const maxEventsPerGroup = Number(process.env.MAX_EVENTS_PER_GROUP || 5000);

const store = await createStore({
  dataDir,
  dbPath,
  maxEventsPerGroup,
  normalizeGroup,
});

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      manifestSrc: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(morgan("combined"));
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/groups/:groupId", (req, res) => {
  const groupId = normalizeGroup(req.params.groupId);
  res.json({ metadata: store.getCircleMetadata(groupId) });
});

app.get("/api/groups/:groupId/events", (req, res) => {
  const groupId = normalizeGroup(req.params.groupId);
  res.json({ events: store.listEvents(groupId), metadata: store.getCircleMetadata(groupId) });
});

app.post("/api/groups/:groupId/events", (req, res) => {
  const groupId = normalizeGroup(req.params.groupId);
  const { id, blob } = req.body || {};

  if (!isUuidLike(id)) return res.status(400).json({ error: "Invalid id" });
  if (!isEncryptedBlob(blob)) return res.status(400).json({ error: "Invalid encrypted blob" });

  const policy = store.getCirclePostingPolicy(groupId);
  if (policy === "owner-only") {
    const ownerToken = readOwnerToken(req);
    if (!ownerToken || !store.verifyOwner(groupId, hashOwnerToken(ownerToken))) {
      return res.status(403).json({ error: "This circle is owner-only. Only the owner may post events." });
    }
  }

  store.appendEvent(groupId, { id, blob });
  res.status(201).json({ ok: true, metadata: store.getCircleMetadata(groupId) });
});

app.post("/api/groups/:groupId/owner/claim", (req, res) => {
  const groupId = normalizeGroup(req.params.groupId);
  const existing = store.getCircleMetadata(groupId);
  if (existing.hasOwner) {
    return res.status(409).json({ error: "Circle owner already claimed." });
  }

  const ownerToken = crypto.randomBytes(24).toString("base64url");
  const claimed = store.claimOwner(groupId, hashOwnerToken(ownerToken));
  if (!claimed) {
    return res.status(409).json({ error: "Circle owner already claimed." });
  }

  res.status(201).json({
    ownerToken,
    metadata: store.getCircleMetadata(groupId),
  });
});

app.get("/api/groups/:groupId/settings", (req, res) => {
  const groupId = normalizeGroup(req.params.groupId);
  res.json(store.getSettings(groupId));
});

app.put("/api/groups/:groupId/settings", (req, res) => {
  const groupId = normalizeGroup(req.params.groupId);
  const ownerToken = readOwnerToken(req);
  if (!ownerToken) return res.status(401).json({ error: "Missing circle owner token." });
  if (!store.verifyOwner(groupId, hashOwnerToken(ownerToken))) {
    return res.status(403).json({ error: "Invalid circle owner token." });
  }

  const { settings, reason } = req.body || {};
  const validation = validateSettings(settings);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const actorLabel = `owner:${hashOwnerToken(ownerToken).slice(0, 12)}`;
  res.json(store.updateSettings(groupId, validation.normalized, actorLabel, sanitizeReason(reason)));
});

app.get("/api/groups/:groupId/settings/history", (req, res) => {
  const groupId = normalizeGroup(req.params.groupId);
  const ownerToken = readOwnerToken(req);
  if (!ownerToken) return res.status(401).json({ error: "Missing circle owner token." });
  if (!store.verifyOwner(groupId, hashOwnerToken(ownerToken))) {
    return res.status(403).json({ error: "Invalid circle owner token." });
  }

  res.json({
    history: store.listSettingsAudit(groupId),
    metadata: store.getCircleMetadata(groupId),
  });
});

// ── Company endpoints ──────────────────────────────────────────────────────

app.get("/api/companies/:ticker", (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: "Invalid ticker" });
  const company = store.getCompany(ticker) || { ticker, enrichedAt: null };
  const reports = store.listCompanyReports(ticker);
  res.json({ company, reports });
});

app.get("/api/ai/status", async (_req, res) => {
  const lmUrl = process.env.LM_STUDIO_URL || "http://localhost:1234";
  const model = process.env.LM_STUDIO_MODEL || "local-model";

  try {
    const statusRes = await fetch(`${lmUrl}/v1/models`, {
      signal: AbortSignal.timeout(4_000),
    });

    if (!statusRes.ok) {
      return res.status(200).json({
        ok: false,
        state: "error",
        model,
        message: `LM Studio returned ${statusRes.status}`,
      });
    }

    const data = await statusRes.json().catch(() => ({}));
    const models = Array.isArray(data?.data)
      ? data.data.map((entry) => entry?.id).filter(Boolean)
      : [];
    const configuredModelAvailable = models.length === 0 || models.includes(model);

    res.json({
      ok: true,
      state: configuredModelAvailable ? "ready" : "warning",
      model,
      models,
      message: configuredModelAvailable
        ? `LM Studio reachable${models.includes(model) ? ` · ${model}` : ""}`
        : `LM Studio reachable, but ${model} is not loaded`,
    });
  } catch (err) {
    res.json({
      ok: false,
      state: "error",
      model,
      message: "LM Studio offline",
      detail: err.message,
    });
  }
});

app.post("/api/companies/:ticker/register", (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: "Invalid ticker" });
  store.ensureCompany(ticker);
  const company = store.getCompany(ticker);
  const force = req.query.force === "1";

  if (force || !company.enrichedAt) {
    setImmediate(async () => {
      try {
        const data = await enrichCompany(ticker);
        if (data) store.upsertCompany(ticker, data);
      } catch (err) {
        console.warn(`SEC enrichment failed for ${ticker}:`, err.message);
      }
    });
  }

  res.status(201).json({ company });
});

app.get("/api/companies/:ticker/financials", (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: "Invalid ticker" });
  const company = store.getCompany(ticker);
  if (!company) return res.status(404).json({ error: "Company not found. Register it first." });
  if (!company.financials) return res.status(404).json({ error: "Financial data not yet available. Check back after enrichment." });
  const prompt = buildLLMPrompt(ticker, company);
  res.json({ ticker, financials: company.financials, filings: company.filings, prompt });
});

app.post("/api/companies/:ticker/reports", (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: "Invalid ticker" });

  const { title, contentHtml, source } = req.body || {};
  if (typeof contentHtml !== "string" || contentHtml.length < 10) {
    return res.status(400).json({ error: "contentHtml is required" });
  }

  store.ensureCompany(ticker);
  const id = store.addCompanyReport(ticker, {
    title: typeof title === "string" ? title.slice(0, 200) : `${ticker} Analysis`,
    contentHtml,
    source: typeof source === "string" ? source.slice(0, 100) : "manual",
  });

  res.status(201).json({ id, ticker });
});

app.post("/api/companies/:ticker/reports/generate", async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: "Invalid ticker" });

  const lmUrl = process.env.LM_STUDIO_URL || "http://localhost:1234";
  const model = process.env.LM_STUDIO_MODEL || "local-model";

  const company = store.getCompany(ticker);
  if (!company) return res.status(404).json({ error: "Company not found. Register it first." });

  const prompt = buildLLMPrompt(ticker, company);

  try {
    const llmRes = await fetch(`${lmUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 8192,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!llmRes.ok) {
      const text = await llmRes.text().catch(() => "");
      return res.status(502).json({ error: `LM Studio returned ${llmRes.status}`, detail: text.slice(0, 300) });
    }

    const data = await llmRes.json();
    let contentHtml = data.choices?.[0]?.message?.content ?? "";
    contentHtml = contentHtml.replace(/^```html\s*/i, "").replace(/\s*```$/i, "").trim();

    if (!contentHtml) return res.status(502).json({ error: "LM Studio returned empty content" });

    const id = store.addCompanyReport(ticker, {
      title: `${ticker} AI Analysis`,
      contentHtml,
      source: `lm-studio:${model}`,
    });

    res.status(201).json({ id, ticker });
  } catch (err) {
    if (err.name === "TimeoutError") return res.status(504).json({ error: "LM Studio timed out after 120s" });
    res.status(503).json({ error: "Could not reach LM Studio", detail: err.message });
  }
});

app.get("/company/:ticker", (_req, res) => {
  res.sendFile(path.join(publicDir, "company.html"), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
});

// ── Circle endpoints ───────────────────────────────────────────────────────

app.get("/node/:groupId", (_req, res) => {
  res.sendFile(path.join(publicDir, "node.html"), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
});

app.use(express.static(publicDir, {
  extensions: ["html"],
  setHeaders(res) {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Service-Worker-Allowed", "/");
  },
}));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Exposure running on http://localhost:${port}`);
  console.log(`SQLite store: ${dbPath}`);
});

function normalizeTicker(value) {
  const t = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9.]/g, "");
  return t.length > 0 && t.length <= 12 ? t : null;
}

function formatMoney(val) {
  if (val == null) return "N/A";
  const abs = Math.abs(val);
  const sign = val < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${(abs / 1e3).toFixed(0)}K`;
}

function buildLLMPrompt(ticker, company) {
  const { name, sector, exchange, financials: f } = company;

  const annualTable = (f?.annualRevenue ?? []).map((r, i) => {
    const gp = f?.annualGrossProfit?.[i];
    const op = f?.annualOperatingIncome?.[i];
    const ni = f?.annualNetIncome?.[i];
    const ocf = f?.annualOperatingCashFlow?.[i];
    const capex = f?.annualCapex?.[i];
    const gpMargin = r.value && gp?.value ? ` (${((gp.value / r.value) * 100).toFixed(1)}% margin)` : "";
    return `  ${r.year}: Revenue ${formatMoney(r.value)}, Gross Profit ${formatMoney(gp?.value)}${gpMargin}, Operating Income ${formatMoney(op?.value)}, Net Income ${formatMoney(ni?.value)}, Operating Cash Flow ${formatMoney(ocf?.value)}, CapEx ${formatMoney(capex?.value)}`;
  }).join("\n");

  const qTable = (f?.quarterlyRevenue ?? []).slice(-4).map((q) =>
    `  ${q.period}: Revenue ${formatMoney(q.value)}`
  ).join("\n");

  const templateSection = REPORT_TEMPLATE
    ? `\n---\nREPORT STRUCTURE GUIDE (follow exactly):\n${REPORT_TEMPLATE}\n---\n`
    : "";

  return `You are a financial analyst. Generate a comprehensive investment analysis HTML report for ${name ?? ticker} (${ticker})${sector ? `, sector: ${sector}` : ""}${exchange ? `, exchange: ${exchange}` : ""}.
${templateSection}
ANNUAL FINANCIAL DATA (from SEC filings):
${annualTable || "  No annual data available."}

RECENT QUARTERLY REVENUE:
${qTable || "  No quarterly data available."}

LATEST BALANCE SHEET:
  Cash: ${formatMoney(f?.latestCash)}
  Total Assets: ${formatMoney(f?.latestAssets)}
  Total Liabilities: ${formatMoney(f?.latestLiabilities)}
  Net Assets: ${f?.latestAssets != null && f?.latestLiabilities != null ? formatMoney(f.latestAssets - f.latestLiabilities) : "N/A"}

Output ONLY the HTML document. No markdown fences, no explanation.`;
}

function normalizeGroup(value) {
  const groupId = String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!groupId) throw Object.assign(new Error("Invalid group"), { status: 400 });
  return groupId.slice(0, 80);
}

function isUuidLike(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(value);
}

function isEncryptedBlob(blob) {
  return blob &&
    blob.v === 1 &&
    blob.alg === "AES-GCM" &&
    typeof blob.salt === "string" &&
    typeof blob.iv === "string" &&
    typeof blob.data === "string" &&
    blob.salt.length < 200 &&
    blob.iv.length < 200 &&
    blob.data.length < 50000;
}

function hashOwnerToken(ownerToken) {
  return crypto.createHash("sha256").update(ownerToken).digest("hex");
}

function readOwnerToken(req) {
  return req.get("x-circle-owner-token") || "";
}

function sanitizeReason(reason) {
  if (typeof reason !== "string") return "";
  return reason.trim().slice(0, 200);
}
