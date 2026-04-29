const $ = (id) => document.getElementById(id);

const els = {
  installBtn: $("installBtn"),
  displayName: $("displayName"),
  tradeAsset: $("tradeAsset"),
  tradeType: $("tradeType"),
  tradeQuantity: $("tradeQuantity"),
  tradePrice: $("tradePrice"),
  markPrice: $("markPrice"),
  note: $("note"),
  applyTradeBtn: $("applyTradeBtn"),
  importPortfolio: $("importPortfolio"),
  replaceImportBtn: $("replaceImportBtn"),
  mergeImportBtn: $("mergeImportBtn"),
  groupId: $("groupId"),
  passphrase: $("passphrase"),
  rounding: $("rounding"),
  syncBtn: $("syncBtn"),
  syncBtn2: $("syncBtn2"),
  exportBtn: $("exportBtn"),
  clearBtn: $("clearBtn"),
  resetPortfolioBtn: $("resetPortfolioBtn"),
  resetPortfolioBtn2: $("resetPortfolioBtn2"),
  portfolioSummary: $("portfolioSummary"),
  portfolioSummaryHeader: $("portfolioSummaryHeader"),
  positions: $("positions"),
  nodeLinkDisplay: $("nodeLinkDisplay"),
  feed: $("feed"),
  template: $("feedItemTemplate"),
  navActivity: $("navActivity"),
  navSignal: $("navSignal"),
  navSettings: $("navSettings"),
  tabActivity: $("tab-activity"),
  tabSignal: $("tab-signal"),
  tabSettings: $("tab-settings"),
  togglePassphraseBtn: $("togglePassphraseBtn"),
  // Entry screen
  entryView: $("entryView"),
  entryGroupId: $("entryGroupId"),
  entryPassphrase: $("entryPassphrase"),
  enterNodeBtn: $("enterNodeBtn"),
  dashboard: $("dashboard"),
  // Desktop settings panel
  desktopSettingsBtn: $("desktopSettingsBtn"),
  closeSettingsBtn: $("closeSettingsBtn"),
  settingsBackdrop: $("settingsBackdrop"),
  lockIconBtn: $("lockIconBtn"),
  lockNodeBtn: $("lockNodeBtn"),
};

const storage = {
  get signals() {
    return readJson("exposure.signals", []);
  },
  set signals(value) {
    localStorage.setItem("exposure.signals", JSON.stringify(value));
  },
  get positions() {
    return readJson("exposure.positions", []);
  },
  set positions(value) {
    localStorage.setItem("exposure.positions", JSON.stringify(value));
  },
  get remoteIds() {
    return new Set(readJson("exposure.remoteIds", []));
  },
  set remoteIds(value) {
    localStorage.setItem("exposure.remoteIds", JSON.stringify([...value]));
  },
};

function boot() {
  // Pre-fill settings from localStorage
  els.displayName.value = localStorage.getItem("exposure.displayName") || "";
  els.groupId.value = localStorage.getItem("exposure.groupId") || "friends";
  els.rounding.value = localStorage.getItem("exposure.rounding") || "0.5";

  // Pre-fill entry screen with saved group ID
  els.entryGroupId.value = localStorage.getItem("exposure.groupId") || "";

  migrateLegacyData();
  renderPortfolio();
  renderFeed();
  updateNodeLink();

  // Settings form listeners
  els.displayName.addEventListener("input", () => localStorage.setItem("exposure.displayName", els.displayName.value.trim()));
  els.groupId.addEventListener("input", () => {
    localStorage.setItem("exposure.groupId", normalizeGroup(els.groupId.value));
    updateNodeLink();
  });
  els.rounding.addEventListener("change", () => {
    localStorage.setItem("exposure.rounding", els.rounding.value);
    renderPortfolio();
    renderFeed();
  });

  // Segmented BUY/SELL toggle
  document.getElementById("tradeTypeGroup").addEventListener("click", e => {
    const btn = e.target.closest(".segment-btn");
    if (!btn) return;
    document.querySelectorAll("#tradeTypeGroup .segment-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    els.tradeType.value = btn.dataset.value;
  });

  // Copy node link
  document.getElementById("copyNodeLinkBtn").addEventListener("click", () => {
    const text = els.nodeLinkDisplay.textContent.trim();
    if (text.startsWith("http")) {
      navigator.clipboard.writeText(text)
        .then(() => toast("Node link copied."))
        .catch(() => toast("Copy failed — try selecting the link manually."));
    }
  });

  // Trade + portfolio actions
  els.applyTradeBtn.addEventListener("click", applyTrade);
  els.replaceImportBtn.addEventListener("click", () => importPortfolio("replace"));
  els.mergeImportBtn.addEventListener("click", () => importPortfolio("merge"));
  els.clearBtn.addEventListener("click", clearFeed);
  els.exportBtn.addEventListener("click", exportFeed);
  els.syncBtn.addEventListener("click", syncFeed);
  els.syncBtn2.addEventListener("click", syncFeed);
  els.resetPortfolioBtn.addEventListener("click", resetPortfolio);
  els.resetPortfolioBtn2.addEventListener("click", resetPortfolio);
  els.positions.addEventListener("click", handlePositionsClick);

  // Passphrase visibility toggle
  els.togglePassphraseBtn.addEventListener("click", () => {
    const isPassword = els.passphrase.type === "password";
    els.passphrase.type = isPassword ? "text" : "password";
    els.togglePassphraseBtn.querySelector(".material-symbols-outlined").textContent =
      isPassword ? "visibility" : "visibility_off";
  });

  // Mobile tab switching
  ["navActivity", "navSignal", "navSettings"].forEach(id => {
    els[id].addEventListener("click", () => switchTab(els[id].dataset.tab));
  });

  // Desktop settings panel
  els.desktopSettingsBtn.addEventListener("click", () => switchTab("settings"));
  els.closeSettingsBtn.addEventListener("click", () => switchTab("signal"));
  els.settingsBackdrop.addEventListener("click", () => switchTab("signal"));

  // Lock button (mobile settings tab) + topbar lock icon
  els.lockNodeBtn.addEventListener("click", lockNode);
  els.lockIconBtn.addEventListener("click", () => {
    if (confirm("Lock this node? Your passphrase will be cleared.")) lockNode();
  });

  // Entry screen
  els.enterNodeBtn.addEventListener("click", enterNode);
  els.entryGroupId.addEventListener("keydown", e => { if (e.key === "Enter") els.entryPassphrase.focus(); });
  els.entryPassphrase.addEventListener("keydown", e => { if (e.key === "Enter") enterNode(); });

  // Check if already unlocked this session (skip entry screen)
  if (sessionStorage.getItem("exposure.unlocked")) {
    showDashboard();
  }

  setupInstallPrompt();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js");
  }
}

function isDesktop() {
  return window.matchMedia("(min-width: 768px)").matches;
}

function switchTab(name) {
  if (isDesktop()) {
    // Desktop: both columns always visible; settings is a sliding panel
    els.tabSignal.classList.add("active");
    els.tabActivity.classList.add("active");
    const openSettings = name === "settings";
    els.tabSettings.classList.toggle("panel-open", openSettings);
    els.settingsBackdrop.classList.toggle("visible", openSettings);
  } else {
    // Mobile: show only the active tab
    ["activity", "signal", "settings"].forEach(tab => {
      document.getElementById(`tab-${tab}`).classList.toggle("active", tab === name);
      document.getElementById(`nav${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.toggle("active", tab === name);
    });
    // Ensure settings panel overlay is closed on mobile
    els.tabSettings.classList.remove("panel-open");
    els.settingsBackdrop.classList.remove("visible");
  }
  if (name !== "settings") sessionStorage.setItem("exposure.activeTab", name);
}

function enterNode() {
  const groupId = normalizeGroup(els.entryGroupId.value);
  if (!groupId) return toast("Enter a group identifier.");

  // Sync entry values to settings inputs
  els.groupId.value = groupId;
  els.passphrase.value = els.entryPassphrase.value;
  localStorage.setItem("exposure.groupId", groupId);
  updateNodeLink();

  sessionStorage.setItem("exposure.unlocked", "1");
  showDashboard();
}

function showDashboard() {
  els.entryView.classList.add("hidden");
  els.dashboard.classList.remove("hidden");
  switchTab(isDesktop() ? "signal" : (sessionStorage.getItem("exposure.activeTab") || "signal"));
}

function lockNode() {
  els.passphrase.value = "";
  els.entryPassphrase.value = "";
  sessionStorage.removeItem("exposure.unlocked");
  sessionStorage.removeItem("exposure.activeTab");
  // Close settings if open
  els.tabSettings.classList.remove("panel-open");
  els.settingsBackdrop.classList.remove("visible");
  els.dashboard.classList.add("hidden");
  els.entryView.classList.remove("hidden");
}

function updateNodeLink() {
  const groupId = normalizeGroup(els.groupId.value);
  els.nodeLinkDisplay.textContent = groupId
    ? `${location.origin}/node/${groupId}`
    : "Enter a group name above to generate the node link.";
}

function migrateLegacyData() {
  if (localStorage.getItem("exposure.positions.migrated")) return;
  localStorage.setItem("exposure.positions.migrated", "1");
  if (localStorage.getItem("exposure.seeded")) {
    localStorage.removeItem("exposure.seeded");
  }
}

function applyTrade() {
  const author = els.displayName.value.trim() || "Anonymous";
  const asset = els.tradeAsset.value.trim().toUpperCase();
  const tradeType = els.tradeType.value;
  const quantity = parseNumber(els.tradeQuantity.value);
  const tradePrice = parseNumber(els.tradePrice.value);
  const markPriceInput = parseNumber(els.markPrice.value);
  const note = els.note.value.trim();

  if (!asset) return toast("Add an asset ticker or name.");
  if (!(quantity > 0)) return toast("Add a share amount greater than zero.");
  if (!(tradePrice > 0)) return toast("Add an execution price greater than zero.");

  const positions = storage.positions;
  const previousExposures = computeExposureMap(positions);
  const previousPosition = positions.find((position) => position.asset === asset);
  const currentQuantity = previousPosition?.quantity || 0;

  if (tradeType === "SELL" && quantity > currentQuantity) {
    return toast("You cannot sell more shares than you hold locally.");
  }

  const nextPositions = updatePositionsAfterTrade({
    positions,
    asset,
    tradeType,
    quantity,
    tradePrice,
    markPrice: markPriceInput > 0 ? markPriceInput : undefined,
  });

  const nextExposures = computeExposureMap(nextPositions);
  const signal = createSignal({
    author,
    asset,
    tradeType,
    quantity,
    previousExposure: previousExposures.get(asset) || 0,
    newExposure: nextExposures.get(asset) || 0,
    note,
  });

  storage.positions = nextPositions;
  storage.signals = [signal, ...storage.signals];
  clearTradeForm();
  renderPortfolio();
  renderFeed();
  toast("Local portfolio updated. Press Sync to share the percentage move.");
}

function importPortfolio(mode) {
  const rows = parseImportedPositions(els.importPortfolio.value);
  if (!rows.length) return toast("Add at least one holding to import.");

  const nextPositions = mode === "replace"
    ? rows
    : mergeImportedPositions(storage.positions, rows);

  storage.positions = sortPositions(nextPositions);
  els.importPortfolio.value = "";
  renderPortfolio();
  toast(mode === "replace" ? "Local portfolio replaced." : "Import merged into local portfolio.");
}

function parseImportedPositions(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const positions = [];

  for (const line of lines) {
    const cells = line.split(/[,\t]/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 3) {
      toast(`Import line needs at least asset, shares, and average price: ${line}`);
      return [];
    }

    const asset = cells[0].toUpperCase();
    const quantity = parseNumber(cells[1]);
    const avgPrice = parseNumber(cells[2]);
    const markPrice = cells[3] ? parseNumber(cells[3]) : avgPrice;

    if (!asset || !(quantity > 0) || !(avgPrice >= 0) || !(markPrice >= 0)) {
      toast(`Invalid import line: ${line}`);
      return [];
    }

    positions.push({
      asset,
      quantity,
      avgPrice,
      markPrice,
      updatedAt: new Date().toISOString(),
    });
  }

  return sortPositions(positions);
}

function mergeImportedPositions(currentPositions, importedPositions) {
  const byAsset = new Map(currentPositions.map((position) => [position.asset, { ...position }]));
  for (const position of importedPositions) {
    byAsset.set(position.asset, position);
  }
  return [...byAsset.values()];
}

function updatePositionsAfterTrade({ positions, asset, tradeType, quantity, tradePrice, markPrice }) {
  const next = positions.map((position) => ({ ...position }));
  const index = next.findIndex((position) => position.asset === asset);
  const existing = index >= 0 ? next[index] : null;
  const currentQuantity = existing?.quantity || 0;
  const currentAvgPrice = existing?.avgPrice || 0;
  const currentMarkPrice = existing?.markPrice || currentAvgPrice || tradePrice;

  if (tradeType === "BUY") {
    const nextQuantity = currentQuantity + quantity;
    const avgPrice = nextQuantity > 0
      ? ((currentQuantity * currentAvgPrice) + (quantity * tradePrice)) / nextQuantity
      : tradePrice;
    const updated = {
      asset,
      quantity: nextQuantity,
      avgPrice,
      markPrice: markPrice || tradePrice || currentMarkPrice,
      updatedAt: new Date().toISOString(),
    };

    if (index >= 0) next[index] = updated;
    else next.push(updated);
  }

  if (tradeType === "SELL") {
    const nextQuantity = currentQuantity - quantity;
    if (nextQuantity <= 0) {
      if (index >= 0) next.splice(index, 1);
    } else {
      next[index] = {
        asset,
        quantity: nextQuantity,
        avgPrice: currentAvgPrice,
        markPrice: markPrice || tradePrice || currentMarkPrice,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  return sortPositions(next);
}

function createSignal({ author, asset, tradeType, quantity, previousExposure, newExposure, note }) {
  const delta = Math.abs(newExposure - previousExposure);
  const roundedPrevious = roundExposure(previousExposure);
  const roundedNew = roundExposure(newExposure);

  return {
    id: crypto.randomUUID(),
    author,
    asset,
    action: deriveSignalAction(tradeType, roundedPrevious, roundedNew),
    moveSize: delta > 0 ? `${formatPoints(roundExposure(delta))} pts` : "",
    newExposure: roundedNew,
    note,
    createdAt: new Date().toISOString(),
    meta: {
      sharesChanged: quantity,
      previousExposure: roundedPrevious,
    },
  };
}

function deriveSignalAction(tradeType, previousExposure, newExposure) {
  if (tradeType === "BUY" && previousExposure === 0 && newExposure > 0) return "Opened";
  if (tradeType === "SELL" && previousExposure > 0 && newExposure === 0) return "Closed";
  if (tradeType === "BUY") return "Added";
  if (tradeType === "SELL") return "Trimmed";
  return "Updated";
}

function renderPortfolio() {
  const positions = sortPositions(storage.positions);
  const exposures = computeExposureMap(positions);
  const totalValue = positions.reduce((sum, p) => sum + p.quantity * effectiveMarkPrice(p), 0);
  const totalCostBasis = positions.reduce((sum, p) => sum + p.quantity * p.avgPrice, 0);
  const totalPnL = totalValue - totalCostBasis;

  // Portfolio summary header
  if (positions.length && totalValue > 0) {
    els.portfolioSummaryHeader.classList.remove("hidden");
    const pnlClass = totalPnL >= 0 ? "position-pnl-positive" : "position-pnl-negative";
    const pnlSign = totalPnL >= 0 ? "+" : "";
    els.portfolioSummaryHeader.innerHTML = `
      <div>
        <div class="summary-stat-label">Market Value</div>
        <div class="summary-stat-value">${formatAmount(totalValue)}</div>
      </div>
      <div>
        <div class="summary-stat-label">Cost Basis</div>
        <div class="summary-stat-value">${formatAmount(totalCostBasis)}</div>
      </div>
      <div>
        <div class="summary-stat-label">Unrealized P&amp;L</div>
        <div class="summary-stat-value ${pnlClass}">${pnlSign}${formatAmount(totalPnL)}</div>
      </div>
    `;
  } else {
    els.portfolioSummaryHeader.classList.add("hidden");
  }

  if (!positions.length) {
    els.portfolioSummary.textContent = "No local holdings yet. Add trades above — only percentages are shared.";
    els.positions.innerHTML = `<div class="feed-empty">No local holdings yet.</div>`;
    return;
  }

  if (totalValue <= 0) {
    els.portfolioSummary.textContent = "Holdings stored locally. Set a mark or average price above zero to calculate exposure.";
  } else {
    els.portfolioSummary.textContent = `${positions.length} holding${positions.length === 1 ? "" : "s"} tracked locally. Prices stay on this device.`;
  }

  els.positions.innerHTML = positions.map((position) => {
    const exposure = exposures.get(position.asset) || 0;
    const markPx = effectiveMarkPrice(position);
    const marketValue = position.quantity * markPx;
    const costBasis = position.quantity * position.avgPrice;
    const pnl = marketValue - costBasis;
    const pnlClass = pnl >= 0 ? "position-pnl-positive" : "position-pnl-negative";
    const pnlSign = pnl >= 0 ? "+" : "";

    return `
      <article class="position-card" data-asset="${escapeAttribute(position.asset)}">
        <div class="position-head">
          <div>
            <div class="position-asset font-grotesk">${escapeHtml(position.asset)}</div>
            <div class="position-exposure">${formatExposure(exposure)} of portfolio</div>
          </div>
          <div class="position-value-block">
            <div class="position-market-value">${formatAmount(marketValue)}</div>
            <div class="position-pnl ${pnlClass}">${pnlSign}${formatAmount(pnl)}</div>
          </div>
        </div>
        <div class="position-grid">
          <div>
            <label>Shares</label>
            <input class="position-input" data-field="quantity" inputmode="decimal" value="${escapeAttribute(formatEditableNumber(position.quantity))}" />
          </div>
          <div>
            <label>Avg buy-in</label>
            <input class="position-input" data-field="avgPrice" inputmode="decimal" value="${escapeAttribute(formatEditableNumber(position.avgPrice))}" />
          </div>
          <div>
            <label>Mark price</label>
            <input class="position-input" data-field="markPrice" inputmode="decimal" value="${escapeAttribute(formatEditableNumber(position.markPrice))}" />
          </div>
          <div>
            <label>Market value</label>
            <div class="position-stat">${formatAmount(marketValue)}</div>
          </div>
          <div>
            <label>Cost basis</label>
            <div class="position-stat">${formatAmount(costBasis)}</div>
          </div>
          <div>
            <label>Unrealized P&amp;L</label>
            <div class="position-stat ${pnlClass}">${pnlSign}${formatAmount(pnl)}</div>
          </div>
        </div>
        <div class="position-actions">
          <button class="secondary" data-action="save">Save edit</button>
          <button class="ghost danger" data-action="delete">Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderFeed() {
  const signals = storage.signals;
  els.feed.innerHTML = "";

  if (!signals.length) {
    els.feed.innerHTML = `<div class="feed-empty">No percentage signals yet. Apply a local move first.</div>`;
    return;
  }

  for (const signal of signals) {
    const node = els.template.content.cloneNode(true);
    const item = node.querySelector(".feed-item");
    const avatar = node.querySelector(".avatar");
    const tickerBadge = node.querySelector(".feed-ticker-badge");
    const line = node.querySelector(".feed-line");
    const note = node.querySelector(".feed-note");
    const meta = node.querySelector(".feed-meta");

    avatar.textContent = initials(signal.author);
    tickerBadge.textContent = signal.asset;
    line.innerHTML = `<strong>${escapeHtml(signal.author)}</strong> ${escapeHtml(signal.action.toLowerCase())}${signal.moveSize ? ` <span class="move-size">by ${escapeHtml(signal.moveSize)}</span>` : ""}. <span class="feed-exposure">New exposure: <strong class="accent-dim">${escapeHtml(formatExposure(signal.newExposure))}</strong></span>`;
    note.textContent = signal.note || "";
    meta.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(signal.createdAt));

    item.title = "Only percentage-based signals are shared.";
    els.feed.appendChild(node);
  }
}

function handlePositionsClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const card = button.closest("[data-asset]");
  const asset = card?.dataset.asset;
  if (!asset) return;

  if (button.dataset.action === "save") {
    savePositionCard(card, asset);
    return;
  }

  if (button.dataset.action === "delete") {
    deletePosition(asset);
  }
}

function savePositionCard(card, asset) {
  const quantity = parseNumber(card.querySelector('[data-field="quantity"]').value);
  const avgPrice = parseNumber(card.querySelector('[data-field="avgPrice"]').value);
  const markPrice = parseNumber(card.querySelector('[data-field="markPrice"]').value);

  if (!(quantity >= 0)) return toast("Shares must be zero or higher.");
  if (!(avgPrice >= 0)) return toast("Average price must be zero or higher.");
  if (!(markPrice >= 0)) return toast("Mark price must be zero or higher.");

  const positions = storage.positions.map((position) => ({ ...position }));
  const index = positions.findIndex((position) => position.asset === asset);
  if (index < 0) return;

  if (quantity === 0) {
    positions.splice(index, 1);
  } else {
    positions[index] = {
      asset,
      quantity,
      avgPrice,
      markPrice,
      updatedAt: new Date().toISOString(),
    };
  }

  storage.positions = sortPositions(positions);
  renderPortfolio();
  toast("Local holding updated.");
}

function deletePosition(asset) {
  if (!confirm(`Delete ${asset} from this device's local holdings?`)) return;
  storage.positions = storage.positions.filter((position) => position.asset !== asset);
  renderPortfolio();
  toast("Local holding removed.");
}

function resetPortfolio() {
  if (!confirm("Reset all local holdings on this device? The shared percentage feed will stay untouched.")) return;
  storage.positions = [];
  renderPortfolio();
  toast("Local portfolio reset.");
}

function clearTradeForm() {
  els.tradeAsset.value = "";
  els.tradeQuantity.value = "";
  els.tradePrice.value = "";
  els.markPrice.value = "";
  els.note.value = "";
  els.tradeType.value = "BUY";
  document.querySelectorAll("#tradeTypeGroup .segment-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.value === "BUY");
  });
}

function clearFeed() {
  if (!confirm("Clear the local percentage feed on this device? Remote encrypted events remain on your VPS.")) return;
  storage.signals = [];
  storage.remoteIds = new Set();
  renderFeed();
}

async function syncFeed() {
  const groupId = normalizeGroup(els.groupId.value);
  const passphrase = els.passphrase.value;
  if (!groupId) return toast("Add a group name.");
  if (passphrase.length < 8) return toast("Use a group passphrase of at least 8 characters.");

  const signals = storage.signals;
  const remoteIds = storage.remoteIds;

  for (const signal of signals) {
    if (remoteIds.has(signal.id)) continue;
    const encrypted = await encryptJson(signal, passphrase, groupId);
    const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: signal.id, blob: encrypted }),
    });
    if (!res.ok) return toast("Upload failed.");
    remoteIds.add(signal.id);
  }

  const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/events`);
  if (!res.ok) return toast("Download failed.");

  const remote = await res.json();
  const byId = new Map(storage.signals.map((signal) => [signal.id, signal]));

  for (const event of remote.events || []) {
    remoteIds.add(event.id);
    if (byId.has(event.id)) continue;
    try {
      const signal = await decryptJson(event.blob, passphrase, groupId);
      byId.set(signal.id, signal);
    } catch {
      console.warn("Could not decrypt event", event.id);
    }
  }

  storage.remoteIds = remoteIds;
  storage.signals = [...byId.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderFeed();
  toast("Synced encrypted percentage feed.");
}

async function exportFeed() {
  const groupId = normalizeGroup(els.groupId.value);
  const passphrase = els.passphrase.value;
  if (passphrase.length < 8) return toast("Use a group passphrase first.");

  const encrypted = [];
  for (const signal of storage.signals) {
    encrypted.push({ id: signal.id, blob: await encryptJson(signal, passphrase, groupId || "friends") });
  }

  const payload = {
    app: "Exposure",
    version: 1,
    groupId,
    exportedAt: new Date().toISOString(),
    events: encrypted,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: `exposure-${groupId || "feed"}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

function computeExposureMap(positions) {
  const total = positions.reduce((sum, position) => sum + position.quantity * effectiveMarkPrice(position), 0);
  const map = new Map();
  for (const position of positions) {
    const value = position.quantity * effectiveMarkPrice(position);
    map.set(position.asset, total > 0 ? roundExposure((value / total) * 100) : 0);
  }
  return map;
}

function effectiveMarkPrice(position) {
  return position.markPrice > 0 ? position.markPrice : position.avgPrice;
}

function sortPositions(positions) {
  return [...positions].sort((a, b) => a.asset.localeCompare(b.asset));
}

function setupInstallPrompt() {
  let deferredPrompt;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    els.installBtn.classList.remove("hidden");
  });

  els.installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    els.installBtn.classList.add("hidden");
  });
}

async function encryptJson(value, passphrase, groupId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt, groupId);
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    v: 1,
    alg: "AES-GCM",
    kdf: "PBKDF2-SHA256-250000",
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptJson(blob, passphrase, groupId) {
  const salt = fromBase64(blob.salt);
  const iv = fromBase64(blob.iv);
  const data = fromBase64(blob.data);
  const key = await deriveKey(passphrase, salt, groupId);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function deriveKey(passphrase, salt, groupId) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${groupId}:${passphrase}`),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function parseNumber(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  return normalized ? Number(normalized) : Number.NaN;
}

function roundExposure(value) {
  const step = Number(els.rounding.value || 0.5);
  return Math.round(value / step) * step;
}

function formatExposure(value) {
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatAmount(value) {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPoints(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatEditableNumber(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 6, useGrouping: false });
}

function normalizeGroup(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function initials(name) {
  return String(name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

boot();
