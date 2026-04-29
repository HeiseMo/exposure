import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createStore, validateSettings } from "./store.js";
import { enrichCompany } from "./sec.js";
import { buildFinancialPrompt, buildReportContext, FinanceError, generateCompanyReport } from "./finance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dbPath = process.env.SQLITE_PATH || path.join(dataDir, "exposure.sqlite");
const port = Number(process.env.PORT || 3000);
const maxEventsPerGroup = Number(process.env.MAX_EVENTS_PER_GROUP || 5000);
const DEFAULT_LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const DEFAULT_LM_STUDIO_MODEL = process.env.LM_STUDIO_MODEL || "local-model";
const LM_STUDIO_GENERATE_TIMEOUT_MS = Number(process.env.LM_STUDIO_GENERATE_TIMEOUT_MS || 600_000);

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

app.get("/api/ai/status", async (req, res) => {
  const groupId = readOptionalGroupId(req);
  const { lmUrl, model } = resolveLmStudioConfig(groupId);

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
    const displayName = typeof req.query.name === "string" ? req.query.name.slice(0, 120) : undefined;
    setImmediate(async () => {
      try {
        const data = await enrichCompany(ticker, displayName);
        store.upsertCompany(ticker, data ?? {});
      } catch (err) {
        console.warn(`SEC enrichment failed for ${ticker}:`, err.message);
        store.upsertCompany(ticker, {});
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
  if (!company.enrichedAt) return res.status(404).json({ error: "Financial data not yet available. Check back after enrichment." });
  if (!company.financials) return res.status(422).json({ error: "No SEC financial data found for this ticker. It may not be a publicly traded US company." });
  const reportContext = buildReportContext(company);
  const prompt = buildFinancialPrompt(ticker, company);
  res.json({ ticker, financials: reportContext?.financials ?? company.financials, filings: company.filings, prompt });
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
  const mode = typeof req.body?.mode === "string" ? req.body.mode.trim().toLowerCase() : "baseline";
  if (!["baseline", "debate"].includes(mode)) {
    return res.status(400).json({ error: "Invalid mode. Expected baseline or debate." });
  }

  const groupId = readOptionalGroupId(req);
  const { lmUrl, model } = resolveLmStudioConfig(groupId);

  const company = store.getCompany(ticker);
  if (!company) return res.status(404).json({ error: "Company not found. Register it first." });

  try {
    const { report, financials, prompt } = await generateCompanyReport({
      company: { ...company, ticker },
      lmUrl,
      model,
      mode,
      timeoutMs: LM_STUDIO_GENERATE_TIMEOUT_MS,
    });

    store.addCompanyReport(ticker, report);
    res.status(201).json({
      report: {
        id: report.id,
        ticker: report.ticker,
        reportType: report.reportType,
        title: report.title,
        contentHtml: report.contentHtml,
        source: report.source,
        generatedAt: report.generatedAt,
      },
      ticker,
      financials,
      prompt,
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      const timeoutSeconds = Math.round(LM_STUDIO_GENERATE_TIMEOUT_MS / 1000);
      return res.status(504).json({ error: `LM Studio timed out after ${timeoutSeconds}s` });
    }
    if (err instanceof FinanceError) {
      return res.status(err.status || 500).json({ error: err.message, detail: err.detail || undefined });
    }
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

function normalizeGroup(value) {
  const groupId = String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!groupId) throw Object.assign(new Error("Invalid group"), { status: 400 });
  return groupId.slice(0, 80);
}

function readOptionalGroupId(req) {
  const candidate = typeof req.query.groupId === "string"
    ? req.query.groupId
    : typeof req.body?.groupId === "string"
      ? req.body.groupId
      : "";

  if (!candidate.trim()) return null;

  try {
    return normalizeGroup(candidate);
  } catch {
    return null;
  }
}

function resolveLmStudioConfig(groupId) {
  const settings = groupId ? store.getSettings(groupId)?.settings || {} : {};
  return {
    lmUrl: settings.lmStudioUrl || DEFAULT_LM_STUDIO_URL,
    model: settings.lmStudioModel || DEFAULT_LM_STUDIO_MODEL,
  };
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
