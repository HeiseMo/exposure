import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const port = Number(process.env.PORT || 3000);
const maxEventsPerGroup = Number(process.env.MAX_EVENTS_PER_GROUP || 5000);

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

app.get("/api/groups/:groupId/events", async (req, res) => {
  const groupId = normalizeGroup(req.params.groupId);
  const events = await readGroup(groupId);
  res.json({ events });
});

app.post("/api/groups/:groupId/events", async (req, res) => {
  const groupId = normalizeGroup(req.params.groupId);
  const { id, blob } = req.body || {};

  if (!isUuidLike(id)) return res.status(400).json({ error: "Invalid id" });
  if (!isEncryptedBlob(blob)) return res.status(400).json({ error: "Invalid encrypted blob" });

  const events = await readGroup(groupId);
  if (!events.some(event => event.id === id)) {
    events.push({
      id,
      blob,
      receivedAt: new Date().toISOString(),
      serverId: crypto.randomUUID(),
    });
  }

  const trimmed = events.slice(-maxEventsPerGroup);
  await writeGroup(groupId, trimmed);
  res.status(201).json({ ok: true });
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
  },
}));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

await fs.mkdir(dataDir, { recursive: true });

app.listen(port, () => {
  console.log(`Exposure running on http://localhost:${port}`);
});

function normalizeGroup(value) {
  const groupId = String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!groupId) throw Object.assign(new Error("Invalid group"), { status: 400 });
  return groupId.slice(0, 80);
}

function groupPath(groupId) {
  return path.join(dataDir, `${groupId}.json`);
}

async function readGroup(groupId) {
  try {
    const raw = await fs.readFile(groupPath(groupId), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeGroup(groupId, events) {
  const tmp = `${groupPath(groupId)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ groupId, events }, null, 2));
  await fs.rename(tmp, groupPath(groupId));
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
