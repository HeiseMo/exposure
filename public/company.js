const ticker = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "").toUpperCase();
const displayName = new URLSearchParams(location.search).get("name") || "";

if (!ticker) {
  document.getElementById("heroName").textContent = "No ticker in URL";
}

let promptText = null;
let pendingRefreshTimer = null;
let pollingAttemptCount = 0;
let aiStatusLoaded = false;
let currentReports = [];

const FINANCIALS_RETRYABLE_STATUSES = new Set([404, 425, 503, 504]);
const FINANCIALS_NOT_FOUND_STATUS = 422;
const DEFAULT_GROUP_ID = "friends";
const IS_LOCALHOST = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);

function getElement(id) {
  return document.getElementById(id);
}

function disableLocalServiceWorker() {
  if (!("serviceWorker" in navigator) || !IS_LOCALHOST) return;

  navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .catch(() => {});

  if (window.caches) {
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .catch(() => {});
  }
}

function normalizeGroup(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function getActiveGroupId() {
  const params = new URLSearchParams(location.search);
  const fromUrl = normalizeGroup(params.get("groupId") || "");
  if (fromUrl) return fromUrl;

  const fromStorage = normalizeGroup(localStorage.getItem("exposure.groupId") || "");
  return fromStorage || DEFAULT_GROUP_ID;
}

function setStatus(kind, state, message) {
  const pill = getElement(`${kind}StatusPill`);
  const text = getElement(`${kind}StatusText`);
  if (!pill || !text) return;

  pill.className = `status-pill status-${state}`;
  text.textContent = message;
}

function clearPendingRefreshTimer() {
  if (pendingRefreshTimer) {
    clearTimeout(pendingRefreshTimer);
    pendingRefreshTimer = null;
  }
}

function scheduleReload(delayMs = 8000) {
  clearPendingRefreshTimer();
  pendingRefreshTimer = setTimeout(() => {
    loadCompanyPage({ silent: true }).catch(() => {});
  }, delayMs);
}

function setPendingState(message, visible = true) {
  const pendingNotice = getElement("pendingNotice");
  const pendingNoticeText = getElement("pendingNoticeText");
  if (pendingNoticeText && message) pendingNoticeText.textContent = message;
  pendingNotice.style.display = visible ? "flex" : "none";
}

function syncActionButtons({ hasFinancials = false, isLoading = false } = {}) {
  const copyPromptButton = getElement("copyPromptBtn");
  const generateButton = getElement("generateBtn");
  const retryButton = getElement("retrySecBtn");
  const modeSelect = getElement("reportModeSelect");

  copyPromptButton.disabled = !hasFinancials;
  generateButton.disabled = isLoading || !hasFinancials;
  generateButton.title = hasFinancials ? "" : "Waiting for SEC financial data";
  if (retryButton) retryButton.disabled = isLoading;
  if (modeSelect) modeSelect.disabled = isLoading || !hasFinancials;
}

function getSelectedReportMode() {
  const select = getElement("reportModeSelect");
  return select?.value === "debate" ? "debate" : "baseline";
}

async function ensureCompanyRegistered(force = false) {
  const params = new URLSearchParams();
  if (force) params.set("force", "1");
  if (displayName) params.set("name", displayName);
  const qs = params.toString();
  const registerResponse = await fetch(`/api/companies/${encodeURIComponent(ticker)}/register${qs ? `?${qs}` : ""}`, {
    method: "POST",
  });

  if (!registerResponse.ok) {
    let detail = "Ticker registration failed.";
    try {
      const payload = await registerResponse.json();
      detail = payload.error || detail;
    } catch {
      // Ignore non-JSON bodies.
    }
    throw new Error(detail);
  }

  return registerResponse.json();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { response, payload };
}

async function refreshAiStatus() {
  setStatus("ai", "loading", aiStatusLoaded ? "AI status: refreshing" : "AI status: checking");

  try {
    const params = new URLSearchParams({ groupId: getActiveGroupId() });
    const { response, payload } = await fetchJson(`/api/ai/status?${params.toString()}`);
    if (!response.ok || !payload) {
      setStatus("ai", "error", "AI status: unavailable");
      aiStatusLoaded = true;
      return;
    }

    const state = payload.state || (payload.ok ? "ready" : "error");
    if (state === "ready") {
      setStatus("ai", "ready", "AI status: ready");
    } else if (state === "warning") {
      setStatus("ai", "warning", "AI status: reachable, model not loaded");
    } else {
      setStatus("ai", "error", "AI status: offline");
    }
  } catch {
    setStatus("ai", "error", "AI status: offline");
  }

  aiStatusLoaded = true;
}

async function retrySecFetch() {
  setStatus("sec", "loading", "SEC status: retrying");
  setPendingState("Retrying SEC EDGAR fetch for this ticker.", true);
  promptText = null;
  pollingAttemptCount = 0;
  syncActionButtons({ hasFinancials: false, isLoading: true });

  try {
    await ensureCompanyRegistered(true);
    await loadCompanyPage();
    showToast("SEC retry started.");
  } catch (error) {
    setStatus("sec", "error", "SEC status: retry failed");
    setPendingState("Could not restart SEC enrichment for this ticker.", true);
    syncActionButtons({ hasFinancials: false, isLoading: false });
    showToast(error.message || "SEC retry failed.");
  }
}

async function loadCompanyPage() {
  if (!ticker) return;

  syncActionButtons({ hasFinancials: Boolean(promptText), isLoading: false });
  if (!aiStatusLoaded) refreshAiStatus().catch(() => {});

  let company = null;
  let reports = [];

  try {
    const { payload } = await ensureCompanyRegistered();
    company = payload?.company || null;
    reports = payload?.reports || [];
    setStatus("sec", "loading", "SEC status: requested");
  } catch (error) {
    setPendingState("Could not register this ticker for SEC lookup.", true);
    setStatus("sec", "error", "SEC status: request failed");
    syncActionButtons({ hasFinancials: false, isLoading: false });
    showToast(error.message || "Failed to start SEC lookup.");
    return;
  }

  try {
    const { response, payload } = await fetchJson(`/api/companies/${encodeURIComponent(ticker)}`);
    if (!response.ok) throw new Error(payload?.error || "Company fetch failed");
    company = payload?.company || company;
    reports = payload?.reports || reports;
    renderHero(company);
    renderReports(reports);
  } catch (error) {
    renderHero(company || { ticker });
    renderReports(reports);
    setPendingState("Preparing company page while SEC data loads.", true);
    showToast(error.message || "Failed to load company data.");
  }

  try {
    const { response, payload } = await fetchJson(`/api/companies/${encodeURIComponent(ticker)}/financials`);
    if (response.ok) {
      const data = payload || {};
      promptText = data.prompt;
      renderFilings(data.filings || []);
      pollingAttemptCount = 0;
      clearPendingRefreshTimer();
      setPendingState("", false);
      setStatus("sec", "ready", `SEC status: ready${(data.filings || []).length ? ` · ${(data.filings || []).length} filings` : ""}`);
      syncActionButtons({ hasFinancials: true, isLoading: false });
      return;
    }

    promptText = null;
    renderFilings([]);
    syncActionButtons({ hasFinancials: false, isLoading: false });

    if (response.status === FINANCIALS_NOT_FOUND_STATUS) {
      setStatus("sec", "error", "SEC status: not found");
      setPendingState(payload?.error || "No SEC data found for this ticker.", true);
      showToast(payload?.error || "No SEC data found for this ticker.");
      return;
    }

    if (FINANCIALS_RETRYABLE_STATUSES.has(response.status)) {
      pollingAttemptCount += 1;
      setStatus("sec", "loading", "SEC status: loading");
      setPendingState("SEC filings are still loading.", true);
      scheduleReload(Math.min(8000 + pollingAttemptCount * 2000, 20000));
      return;
    }

    setStatus("sec", "error", "SEC status: unavailable");
    setPendingState(payload?.error || "SEC data is unavailable for this ticker right now.", true);
    showToast(payload?.error || "SEC data is unavailable right now.");
  } catch {
    promptText = null;
    renderFilings([]);
    syncActionButtons({ hasFinancials: false, isLoading: false });
    pollingAttemptCount += 1;
    setStatus("sec", "loading", "SEC status: loading");
    setPendingState("SEC filings are still loading.", true);
    scheduleReload(Math.min(8000 + pollingAttemptCount * 2000, 20000));
  }
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{10}$/;

function renderHero(company) {
  const resolvedTicker = company?.ticker || ticker;
  const isISIN = ISIN_RE.test(resolvedTicker);

  // For ISIN pages: company name is the primary label, ISIN is secondary
  // For ticker pages: ticker is the primary label, company name is secondary
  const secName = company?.name || null;
  const primaryLabel = isISIN ? (secName || displayName || resolvedTicker) : resolvedTicker;
  const secondaryLabel = isISIN ? resolvedTicker : (secName || "");

  document.title = `${primaryLabel} - Exposure`;
  getElement("topTicker").textContent = primaryLabel;
  getElement("heroTicker").textContent = primaryLabel;
  getElement("topName").textContent = secondaryLabel;
  getElement("heroName").textContent = secondaryLabel;

  const badges = [];
  if (company?.exchange) badges.push({ label: company.exchange, className: "badge-blue" });
  if (company?.sector) badges.push({ label: company.sector, className: "badge-dim" });
  if (!company?.enrichedAt) badges.push({ label: "Pending SEC data", className: "badge-dim" });

  getElement("heroBadges").innerHTML = badges
    .map((badge) => `<span class="badge ${badge.className}">${escapeHtml(badge.label)}</span>`)
    .join("");

  const infos = [];
  if (isISIN) {
    infos.push({ label: "ISIN", value: escapeHtml(resolvedTicker) });
  }
  if (company?.cik) {
    infos.push({
      label: "CIK",
      value: `<a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${escapeHtml(company.cik)}&type=&dateb=&owner=include&count=40&search_text=" target="_blank" rel="noopener">${escapeHtml(company.cik)}</a>`,
    });
  }
  if (company?.website) {
    infos.push({
      label: "Website",
      value: `<a href="${escapeHtml(company.website)}" target="_blank" rel="noopener">${escapeHtml(company.website.replace(/^https?:\/\//, ""))}</a>`,
    });
  }
  if (company?.createdAt) {
    infos.push({ label: "Tracked since", value: escapeHtml(new Date(company.createdAt).toLocaleDateString()) });
  }
  if (company?.enrichedAt) {
    infos.push({ label: "Last enriched", value: escapeHtml(new Date(company.enrichedAt).toLocaleDateString()) });
  }

  getElement("heroInfoRow").innerHTML = infos
    .map((info) => `<div class="info-item"><span class="info-label">${info.label}</span><span class="info-value">${info.value}</span></div>`)
    .join("");

  if (!company?.enrichedAt) {
    setStatus("sec", "loading", "SEC status: loading");
    setPendingState("Fetching SEC EDGAR data for this ticker.", true);
  } else {
    clearPendingRefreshTimer();
    setStatus("sec", "ready", "SEC status: ready");
    setPendingState("", false);
  }
}

function renderFilings(filings) {
  const section = getElement("filingsSection");
  if (!filings.length) {
    section.style.display = "none";
    getElement("filingsList").innerHTML = "";
    return;
  }

  section.style.display = "";
  const formClass = { "10-K": "form-10k", "10-Q": "form-10q", "8-K": "form-8k" };
  getElement("filingsList").innerHTML = filings.map((filing) => `
    <div class="filing-row">
      <span class="filing-form ${formClass[filing.form] || "badge-dim"}">${escapeHtml(filing.form)}</span>
      <span class="filing-date">${escapeHtml(filing.date)}</span>
      <a class="filing-link" href="${escapeHtml(filing.url)}" target="_blank" rel="noopener">${escapeHtml(filing.accessionNumber)}</a>
    </div>
  `).join("");
}

function renderReports(reports) {
  const list = getElement("reportsList");
  currentReports = Array.isArray(reports) ? reports.slice() : [];
  if (!reports.length) {
    list.innerHTML = '<div class="empty-state">No reports yet. Generate one above.</div>';
    return;
  }

  list.innerHTML = reports.map((report, index) => `
    <div class="report-card${index === 0 ? " open" : ""}" data-id="${escapeHtml(report.id)}">
      <div class="report-header" role="button" tabindex="0" aria-expanded="${index === 0 ? "true" : "false"}">
        <div class="report-title">${escapeHtml(report.title || `${report.ticker} Analysis`)}</div>
        <div class="report-meta">
          <span>${escapeHtml(new Date(report.generatedAt).toLocaleDateString())}</span>
          ${report.source ? `<span class="badge badge-dim">${escapeHtml(report.source)}</span>` : ""}
        </div>
        <span class="chevron">▾</span>
      </div>
      <div class="report-body">
        <iframe class="report-iframe" srcdoc="${escapeAttribute(report.contentHtml)}" sandbox="allow-same-origin" loading="lazy"></iframe>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".report-header").forEach((header) => {
    header.addEventListener("click", () => toggleReportCard(header.closest(".report-card")));
    header.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleReportCard(header.closest(".report-card"));
      }
    });
  });

  list.querySelectorAll(".report-iframe").forEach((iframe) => {
    iframe.addEventListener("load", () => {
      try {
        const height = iframe.contentDocument?.body?.scrollHeight;
        if (height > 100) iframe.style.height = `${height}px`;
      } catch {
        // Ignore cross-document sizing failures.
      }
    });
  });
}

function toggleReportCard(card) {
  if (!card) return;
  card.classList.toggle("open");
  const header = card.querySelector(".report-header");
  if (header) header.setAttribute("aria-expanded", String(card.classList.contains("open")));
}

async function copyPrompt() {
  if (!promptText) {
    showToast("No prompt available - waiting for SEC data.");
    return;
  }

  try {
    await navigator.clipboard.writeText(promptText);
    showToast("Prompt copied to clipboard.");
  } catch {
    showToast("Copy failed - check console for prompt.");
    console.log(promptText);
  }
}

async function generateReport() {
  const button = getElement("generateBtn");
  if (!promptText) {
    showToast("SEC data is still loading. Wait for filings before generating a report.");
    return;
  }

  button.disabled = true;
  button.textContent = "Generating...";

  try {
    const res = await fetch(`/api/companies/${encodeURIComponent(ticker)}/reports/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: getActiveGroupId(), mode: getSelectedReportMode() }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (data?.error === "Could not reach LM Studio") {
        setStatus("ai", "error", "AI status: offline");
        showToast("Local AI is offline. SEC filings work without it, but report generation needs LM Studio.");
      } else if (String(data?.error || "").includes("timed out")) {
        setStatus("ai", "warning", "AI status: timed out");
        showToast(data.error || "Generation failed.");
      } else {
        setStatus("ai", "warning", "AI status: not ready");
        showToast(data.error || "Generation failed.");
      }
    } else {
      setStatus("ai", "ready", "AI status: ready");
      if (data?.report) {
        renderReports([data.report, ...currentReports.filter((report) => report.id !== data.report.id)]);
      }
      showToast("Report generated.");
      try {
        await loadCompanyPage();
      } catch {
        showToast("Report saved, but the page refresh failed.");
      }
    }
  } catch {
    showToast("Request failed.");
  } finally {
    button.disabled = false;
    button.textContent = "Generate Report";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

function showToast(message) {
  const toast = getElement("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => toast.classList.remove("show"), 3000);
}

getElement("copyPromptBtn").addEventListener("click", copyPrompt);
getElement("generateBtn").addEventListener("click", generateReport);
getElement("retrySecBtn").addEventListener("click", retrySecFetch);

syncActionButtons({ hasFinancials: false, isLoading: false });
disableLocalServiceWorker();

loadCompanyPage().catch(() => {
  showToast("Failed to load company data.");
});
