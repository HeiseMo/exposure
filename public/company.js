const ticker = location.pathname.split("/").filter(Boolean)[1]?.toUpperCase() || "";

if (!ticker) {
  document.getElementById("heroName").textContent = "No ticker in URL";
}

let promptText = null;
let pendingRefreshTimer = null;

function getElement(id) {
  return document.getElementById(id);
}

async function loadCompanyPage() {
  if (!ticker) return;

  try {
    const res = await fetch(`/api/companies/${encodeURIComponent(ticker)}`);
    if (!res.ok) throw new Error("Company fetch failed");
    const { company, reports } = await res.json();
    renderHero(company);
    renderReports(reports);
  } catch {
    showToast("Failed to load company data.");
  }

  try {
    const res = await fetch(`/api/companies/${encodeURIComponent(ticker)}/financials`);
    if (res.ok) {
      const data = await res.json();
      promptText = data.prompt;
      renderFilings(data.filings || []);
      getElement("copyPromptBtn").disabled = false;
    } else {
      promptText = null;
      getElement("copyPromptBtn").disabled = true;
    }
  } catch {
    promptText = null;
    getElement("copyPromptBtn").disabled = true;
  }
}

function renderHero(company) {
  const resolvedTicker = company?.ticker || ticker;
  document.title = `${resolvedTicker} - Exposure`;
  getElement("topTicker").textContent = resolvedTicker;
  getElement("heroTicker").textContent = resolvedTicker;

  const name = company?.name || resolvedTicker;
  getElement("topName").textContent = name;
  getElement("heroName").textContent = name;

  const badges = [];
  if (company?.exchange) badges.push({ label: company.exchange, className: "badge-blue" });
  if (company?.sector) badges.push({ label: company.sector, className: "badge-dim" });
  if (!company?.enrichedAt) badges.push({ label: "Pending SEC data", className: "badge-dim" });

  getElement("heroBadges").innerHTML = badges
    .map((badge) => `<span class="badge ${badge.className}">${escapeHtml(badge.label)}</span>`)
    .join("");

  const infos = [];
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

  const pendingNotice = getElement("pendingNotice");
  pendingNotice.style.display = company?.enrichedAt ? "none" : "flex";

  if (pendingRefreshTimer) {
    clearTimeout(pendingRefreshTimer);
    pendingRefreshTimer = null;
  }

  if (!company?.enrichedAt) {
    pendingRefreshTimer = setTimeout(() => {
      loadCompanyPage().catch(() => {});
    }, 8000);
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
  button.disabled = true;
  button.textContent = "Generating...";

  try {
    const res = await fetch(`/api/companies/${encodeURIComponent(ticker)}/reports/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || "Generation failed.");
    } else {
      showToast("Report generated.");
      await loadCompanyPage();
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

loadCompanyPage().catch(() => {
  showToast("Failed to load company data.");
});