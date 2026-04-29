import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function createStore({ dataDir, dbPath, maxEventsPerGroup, normalizeGroup }) {
  await fs.mkdir(dataDir, { recursive: true });
  const store = new ExposureStore({ dataDir, dbPath, maxEventsPerGroup, normalizeGroup });
  await store.migrateLegacyGroupFiles();
  return store;
}

class ExposureStore {
  constructor({ dataDir, dbPath, maxEventsPerGroup, normalizeGroup }) {
    this.dataDir = dataDir;
    this.dbPath = dbPath;
    this.maxEventsPerGroup = maxEventsPerGroup;
    this.normalizeGroup = normalizeGroup;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        ticker TEXT PRIMARY KEY,
        name TEXT,
        sector TEXT,
        exchange TEXT,
        cik TEXT,
        website TEXT,
        filings_json TEXT,
        financials_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        enriched_at TEXT
      );

      CREATE TABLE IF NOT EXISTS company_reports (
        id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
        report_type TEXT NOT NULL DEFAULT 'sec_analysis',
        title TEXT,
        content_html TEXT NOT NULL,
        source TEXT,
        generated_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_company_reports_ticker_generated
        ON company_reports(ticker, generated_at DESC);

      CREATE TABLE IF NOT EXISTS circles (
        group_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        owner_token_hash TEXT,
        settings_json TEXT NOT NULL DEFAULT '{}',
        settings_version INTEGER NOT NULL DEFAULT 0,
        settings_updated_at TEXT,
        settings_updated_by TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        last_event_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        server_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES circles(group_id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        blob_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(group_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_group_received_at
        ON events(group_id, received_at ASC);

      CREATE TABLE IF NOT EXISTS settings_audit (
        audit_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES circles(group_id) ON DELETE CASCADE,
        settings_json TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_settings_audit_group_changed_at
        ON settings_audit(group_id, changed_at DESC);
    `);

    ensureColumn(this.db, "company_reports", "metadata_json", "TEXT");
  }

  ensureCircle(groupId) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO circles (group_id, created_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(group_id) DO NOTHING
    `).run(groupId, now, now);
  }

  getCircle(groupId) {
    const row = this.db.prepare(`
      SELECT
        group_id,
        created_at,
        updated_at,
        claimed_at,
        owner_token_hash,
        settings_json,
        settings_version,
        settings_updated_at,
        settings_updated_by,
        event_count,
        last_event_at
      FROM circles
      WHERE group_id = ?
    `).get(groupId);

    return row ? mapCircleRow(row) : null;
  }

  getCircleMetadata(groupId) {
    const circle = this.getCircle(groupId);
    if (!circle) {
      return {
        groupId,
        createdAt: null,
        updatedAt: null,
        claimedAt: null,
        hasOwner: false,
        eventCount: 0,
        lastEventAt: null,
        settingsVersion: 0,
        settingsUpdatedAt: null,
        settingsUpdatedBy: null,
      };
    }

    return toCircleMetadata(circle);
  }

  listEvents(groupId) {
    return this.db.prepare(`
      SELECT event_id, blob_json, received_at, server_id
      FROM events
      WHERE group_id = ?
      ORDER BY received_at ASC, server_id ASC
    `).all(groupId).map((row) => ({
      id: row.event_id,
      blob: JSON.parse(row.blob_json),
      receivedAt: row.received_at,
      serverId: row.server_id,
    }));
  }

  appendEvent(groupId, { id, blob }) {
    this.ensureCircle(groupId);
    const now = new Date().toISOString();
    const serverId = crypto.randomUUID();

    const insert = this.db.prepare(`
      INSERT INTO events (server_id, group_id, event_id, blob_json, received_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(group_id, event_id) DO NOTHING
    `).run(serverId, groupId, id, JSON.stringify(blob), now);

    if (insert.changes > 0) {
      this.pruneEvents(groupId);
      this.refreshCircleEventStats(groupId);
    }

    return insert.changes > 0;
  }

  pruneEvents(groupId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE group_id = ?
    `).get(groupId);
    const pruneCount = Math.max(0, Number(row?.count || 0) - this.maxEventsPerGroup);
    if (pruneCount <= 0) return;

    this.db.prepare(`
      DELETE FROM events
      WHERE server_id IN (
        SELECT server_id
        FROM events
        WHERE group_id = ?
        ORDER BY received_at ASC, server_id ASC
        LIMIT ?
      )
    `).run(groupId, pruneCount);
  }

  refreshCircleEventStats(groupId) {
    const stats = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(received_at) AS last_event_at
      FROM events
      WHERE group_id = ?
    `).get(groupId);
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE circles
      SET event_count = ?,
          last_event_at = ?,
          updated_at = ?
      WHERE group_id = ?
    `).run(Number(stats?.count || 0), stats?.last_event_at || null, now, groupId);
  }

  claimOwner(groupId, ownerTokenHash) {
    this.ensureCircle(groupId);

    const result = this.db.prepare(`
      UPDATE circles
      SET owner_token_hash = ?,
          claimed_at = ?,
          updated_at = ?
      WHERE group_id = ?
        AND owner_token_hash IS NULL
    `).run(ownerTokenHash, new Date().toISOString(), new Date().toISOString(), groupId);

    return result.changes > 0;
  }

  verifyOwner(groupId, ownerTokenHash) {
    const row = this.db.prepare(`
      SELECT 1
      FROM circles
      WHERE group_id = ? AND owner_token_hash = ?
    `).get(groupId, ownerTokenHash);

    return Boolean(row);
  }

  getCirclePostingPolicy(groupId) {
    const circle = this.getCircle(groupId);
    if (!circle) return "any-member";
    const settings = parseSettings(circle.settingsJson);
    return settings.postingPolicy;
  }

  getSettings(groupId) {
    const circle = this.getCircle(groupId);
    if (!circle) {
      return {
        settings: {},
        metadata: this.getCircleMetadata(groupId),
      };
    }

    return {
      settings: parseSettings(circle.settingsJson),
      metadata: toCircleMetadata(circle),
    };
  }

  updateSettings(groupId, settings, actorLabel, reason = "") {
    this.ensureCircle(groupId);
    const now = new Date().toISOString();
    const current = this.getCircle(groupId);
    const nextVersion = (current?.settingsVersion || 0) + 1;
    const settingsJson = JSON.stringify(settings);

    this.db.prepare(`
      UPDATE circles
      SET settings_json = ?,
          settings_version = ?,
          settings_updated_at = ?,
          settings_updated_by = ?,
          updated_at = ?
      WHERE group_id = ?
    `).run(settingsJson, nextVersion, now, actorLabel, now, groupId);

    this.db.prepare(`
      INSERT INTO settings_audit (audit_id, group_id, settings_json, changed_at, changed_by, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), groupId, settingsJson, now, actorLabel, reason || null);

    return this.getSettings(groupId);
  }

  listSettingsAudit(groupId, limit = 20) {
    return this.db.prepare(`
      SELECT audit_id, settings_json, changed_at, changed_by, reason
      FROM settings_audit
      WHERE group_id = ?
      ORDER BY changed_at DESC
      LIMIT ?
    `).all(groupId, limit).map((row) => ({
      auditId: row.audit_id,
      changedAt: row.changed_at,
      changedBy: row.changed_by,
      reason: row.reason,
      settings: parseSettings(row.settings_json),
    }));
  }

  ensureCompany(ticker) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO companies (ticker, created_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(ticker) DO NOTHING
    `).run(ticker.toUpperCase(), now, now);
  }

  upsertCompany(ticker, data) {
    const now = new Date().toISOString();
    this.ensureCompany(ticker);
    this.db.prepare(`
      UPDATE companies
      SET name = COALESCE(?, name),
          sector = COALESCE(?, sector),
          exchange = COALESCE(?, exchange),
          cik = COALESCE(?, cik),
          website = COALESCE(?, website),
          filings_json = COALESCE(?, filings_json),
          financials_json = COALESCE(?, financials_json),
          updated_at = ?,
          enriched_at = ?
      WHERE ticker = ?
    `).run(
      data.name ?? null,
      data.sector ?? null,
      data.exchange ?? null,
      data.cik ?? null,
      data.website ?? null,
      data.filings ? JSON.stringify(data.filings) : null,
      data.financials ? JSON.stringify(data.financials) : null,
      now,
      now,
      ticker.toUpperCase()
    );
  }

  getCompany(ticker) {
    const row = this.db.prepare(`
      SELECT ticker, name, sector, exchange, cik, website,
             filings_json, financials_json, created_at, updated_at, enriched_at
      FROM companies WHERE ticker = ?
    `).get(ticker.toUpperCase());
    if (!row) return null;
    return {
      ticker: row.ticker,
      name: row.name,
      sector: row.sector,
      exchange: row.exchange,
      cik: row.cik,
      website: row.website,
      filings: row.filings_json ? JSON.parse(row.filings_json) : [],
      financials: row.financials_json ? JSON.parse(row.financials_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      enrichedAt: row.enriched_at,
    };
  }

  listCompanyReports(ticker) {
    return this.db.prepare(`
      SELECT id, ticker, report_type, title, content_html, source, generated_at
      FROM company_reports WHERE ticker = ?
      ORDER BY generated_at DESC
    `).all(ticker.toUpperCase()).map(row => ({
      id: row.id,
      ticker: row.ticker,
      reportType: row.report_type,
      title: row.title,
      contentHtml: row.content_html,
      source: row.source,
      generatedAt: row.generated_at,
    }));
  }

  addCompanyReport(ticker, { id, title, contentHtml, source, reportType = 'sec_analysis', generatedAt, metadata = null }) {
    const reportId = id || crypto.randomUUID();
    const now = generatedAt || new Date().toISOString();
    this.db.prepare(`
      INSERT INTO company_reports (id, ticker, report_type, title, content_html, source, generated_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reportId,
      ticker.toUpperCase(),
      reportType,
      title ?? null,
      contentHtml,
      source ?? null,
      now,
      metadata ? JSON.stringify(metadata) : null
    );
    return reportId;
  }

  getCompanyReportMetadata(ticker, reportId) {
    const row = this.db.prepare(`
      SELECT metadata_json
      FROM company_reports
      WHERE ticker = ? AND id = ?
    `).get(ticker.toUpperCase(), reportId);
    return row?.metadata_json ? JSON.parse(row.metadata_json) : null;
  }

  async migrateLegacyGroupFiles() {
    const entries = await fs.readdir(this.dataDir, { withFileTypes: true });
    const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));

    for (const entry of jsonFiles) {
      const filePath = path.join(this.dataDir, entry.name);

      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const groupId = this.normalizeGroup(parsed.groupId || entry.name.replace(/\.json$/, ""));
        const events = Array.isArray(parsed.events) ? parsed.events : [];

        this.ensureCircle(groupId);
        for (const event of events) {
          if (!event?.id || !event?.blob) continue;
          this.db.prepare(`
            INSERT INTO events (server_id, group_id, event_id, blob_json, received_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(group_id, event_id) DO NOTHING
          `).run(
            event.serverId || crypto.randomUUID(),
            groupId,
            event.id,
            JSON.stringify(event.blob),
            event.receivedAt || new Date().toISOString(),
          );
        }

        this.refreshCircleEventStats(groupId);
      } catch (error) {
        console.warn(`Skipping legacy group import for ${entry.name}:`, error.message);
      }
    }
  }
}

const POSTING_POLICIES = ["any-member", "owner-only"];
const DEFAULT_SETTINGS = {
  name: "",
  postingPolicy: "any-member",
  lmStudioUrl: "",
  lmStudioModel: "",
};

export function validateSettings(input) {
  if (!isPlainObject(input)) {
    return { valid: false, error: "Settings must be a JSON object." };
  }

  const normalized = { ...DEFAULT_SETTINGS };

  if ("name" in input) {
    if (typeof input.name !== "string") {
      return { valid: false, error: "name must be a string." };
    }
    normalized.name = input.name.trim().slice(0, 60);
  }

  if ("postingPolicy" in input) {
    if (!POSTING_POLICIES.includes(input.postingPolicy)) {
      return { valid: false, error: `postingPolicy must be one of: ${POSTING_POLICIES.join(", ")}.` };
    }
    normalized.postingPolicy = input.postingPolicy;
  }

  if ("lmStudioUrl" in input) {
    if (typeof input.lmStudioUrl !== "string") {
      return { valid: false, error: "lmStudioUrl must be a string." };
    }

    const lmStudioUrl = normalizeLmStudioUrl(input.lmStudioUrl);
    if (lmStudioUrl == null) {
      return { valid: false, error: "lmStudioUrl must be a valid http(s) URL." };
    }
    normalized.lmStudioUrl = lmStudioUrl;
  }

  if ("lmStudioModel" in input) {
    if (typeof input.lmStudioModel !== "string") {
      return { valid: false, error: "lmStudioModel must be a string." };
    }
    normalized.lmStudioModel = input.lmStudioModel.trim().slice(0, 120);
  }

  const unknown = Object.keys(input).filter(k => !(k in DEFAULT_SETTINGS));
  if (unknown.length) {
    return { valid: false, error: `Unknown settings keys: ${unknown.join(", ")}.` };
  }

  return { valid: true, normalized };
}

function parseSettings(settingsJson) {
  try {
    const raw = JSON.parse(settingsJson || "{}");
    if (!isPlainObject(raw)) return { ...DEFAULT_SETTINGS };
    return {
      name: typeof raw.name === "string" ? raw.name : DEFAULT_SETTINGS.name,
      postingPolicy: POSTING_POLICIES.includes(raw.postingPolicy)
        ? raw.postingPolicy
        : DEFAULT_SETTINGS.postingPolicy,
      lmStudioUrl: typeof raw.lmStudioUrl === "string" ? raw.lmStudioUrl : DEFAULT_SETTINGS.lmStudioUrl,
      lmStudioModel: typeof raw.lmStudioModel === "string" ? raw.lmStudioModel : DEFAULT_SETTINGS.lmStudioModel,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function normalizeLmStudioUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function mapCircleRow(row) {
  return {
    groupId: row.group_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    ownerTokenHash: row.owner_token_hash,
    settingsJson: row.settings_json,
    settingsVersion: Number(row.settings_version || 0),
    settingsUpdatedAt: row.settings_updated_at,
    settingsUpdatedBy: row.settings_updated_by,
    eventCount: Number(row.event_count || 0),
    lastEventAt: row.last_event_at,
  };
}

function toCircleMetadata(circle) {
  return {
    groupId: circle.groupId,
    createdAt: circle.createdAt,
    updatedAt: circle.updatedAt,
    claimedAt: circle.claimedAt,
    hasOwner: Boolean(circle.ownerTokenHash),
    eventCount: circle.eventCount,
    lastEventAt: circle.lastEventAt,
    settingsVersion: circle.settingsVersion,
    settingsUpdatedAt: circle.settingsUpdatedAt,
    settingsUpdatedBy: circle.settingsUpdatedBy,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
