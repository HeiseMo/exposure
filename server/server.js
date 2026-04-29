import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createStore, validateSettings } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
