const form = document.querySelector("#form");
const board = document.querySelector("#board");
const conn = document.querySelector("#conn");
const formError = document.querySelector("#form-error");
const cap = document.querySelector("#cap");
const trackButton = document.querySelector("#track");
const stopButton = document.querySelector("#stop");
const popularGrid = document.querySelector("#popular-grid");
const allGrid = document.querySelector("#all-grid");
const chainSearch = document.querySelector("#chain-search");
const more = document.querySelector("#more");

const MAX_CHAINS = 8;
const selected = new Set(["ethereum"]);
const results = new Map();
const history = new Map();
const chainNames = new Map();

let socket = null;
let running = false;
let liveSession = false;
let activeQuery = null;
let chainCatalog = [];

const REASON = {
  contract: "Matched contract",
  "name+ticker": "Matched name + ticker",
  ticker: "Matched ticker",
  name: "Matched name",
};

function setConn(text, kind) {
  conn.textContent = text;
  conn.className = `conn${kind ? ` ${kind}` : ""}`;
}

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem("find-rank") || "{}");
  } catch {
    return {};
  }
}

function field(id) {
  return document.querySelector(`#${id}`);
}

function saveQuery() {
  const data = {
    name: field("name").value.trim(),
    ticker: field("ticker").value.trim(),
    ca: field("ca").value.trim(),
    timeframe: new FormData(form).get("timeframe"),
    live: form.live.checked,
    findAll: form.findAll.checked,
    chains: [...selected],
  };
  localStorage.setItem("find-rank", JSON.stringify(data));
  return data;
}

function chainButton(chain) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chain";
  button.textContent = chain.name;
  button.dataset.id = chain.id;
  button.setAttribute("aria-pressed", selected.has(chain.id) ? "true" : "false");
  button.addEventListener("click", () => toggleChain(chain.id, button));
  return button;
}

function toggleChain(id, button) {
  if (selected.has(id)) {
    selected.delete(id);
    button.setAttribute("aria-pressed", "false");
  } else if (selected.size >= MAX_CHAINS) {
    cap.classList.add("warn");
    cap.textContent = "Eight chains is the limit for one live pass. Clear one, then add another.";
    return;
  } else {
    selected.add(id);
    button.setAttribute("aria-pressed", "true");
    cap.classList.remove("warn");
    cap.textContent = "Up to 8 chains at once. Add the token name with the ticker so lookalikes are skipped. A contract address wins over both.";
  }
  syncPressed();
}

function syncPressed() {
  for (const button of document.querySelectorAll(".chain")) {
    button.setAttribute("aria-pressed", selected.has(button.dataset.id) ? "true" : "false");
  }
}

function renderChains(chains) {
  chainCatalog = chains;
  popularGrid.replaceChildren();
  allGrid.replaceChildren();
  for (const chain of chains) {
    chainNames.set(chain.id, chain.name);
    const button = chainButton(chain);
    if (chain.popular) popularGrid.append(button);
    allGrid.append(chainButton(chain));
  }
}

function applySaved(saved) {
  if (saved.name) field("name").value = saved.name;
  if (saved.ticker) field("ticker").value = saved.ticker;
  if (saved.ca) field("ca").value = saved.ca;
  if (saved.timeframe) {
    const radio = form.querySelector(`input[value="${saved.timeframe}"]`);
    if (radio) radio.checked = true;
  }
  if (typeof saved.live === "boolean") field("live").checked = saved.live;
  if (typeof saved.findAll === "boolean") field("findAll").checked = saved.findAll;
  if (Array.isArray(saved.chains) && saved.chains.length) {
    selected.clear();
    for (const id of saved.chains.slice(0, MAX_CHAINS)) selected.add(id);
    syncPressed();
  }
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function compact(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const amount = Math.abs(value);
  if (amount >= 1e9) return `${sign}$${(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `${sign}$${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 1e3) return `${sign}$${(amount / 1e3).toFixed(amount >= 1e4 ? 1 : 1)}K`;
  return `${sign}$${amount.toFixed(amount >= 1 ? 2 : 0)}`;
}

function money(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  const digits = Math.min(10, Math.max(4, Math.ceil(-Math.log10(value)) + 2));
  return `$${value.toFixed(digits)}`;
}

function signed(value) {
  const n = Number.isFinite(value) ? value : 0;
  if (!n) return "0%";
  const body = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2);
  if (n > 0) return `+${body}%`;
  return `${body}%`;
}

function tone(value) {
  if (value == null || !Number.isFinite(value) || value === 0) return "";
  return value > 0 ? "up" : "down";
}

function age(unix) {
  if (!unix) return "—";
  const seconds = Math.max(0, Date.now() / 1000 - unix);
  const steps = [
    ["y", 31536000],
    ["mo", 2592000],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ];
  for (const [unit, size] of steps) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`;
  }
  return "now";
}

function shortAddress(value) {
  if (!value) return "";
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatRank(rank) {
  return Number(rank).toLocaleString();
}

function rememberRank(chainId, rank) {
  const points = history.get(chainId) || [];
  const last = points[points.length - 1];
  const now = Date.now();
  if (!last || last.rank !== rank || now - last.t > 8000) {
    points.push({ t: now, rank });
    if (points.length > 48) points.shift();
    history.set(chainId, points);
  }
}

function spark(chainId) {
  const points = history.get(chainId) || [];
  if (points.length < 2) return "";
  const ranks = points.map((point) => point.rank);
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);
  const span = Math.max(1, max - min);
  const width = 148;
  const height = 42;
  const d = ranks
    .map((rank, index) => {
      const x = (index / (ranks.length - 1)) * width;
      const y = 2 + ((rank - min) / span) * (height - 4);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="${d}"/></svg>`;
}

function movement(chainId) {
  const points = history.get(chainId) || [];
  if (points.length < 2) return "";
  const diff = points[points.length - 2].rank - points[points.length - 1].rank;
  if (!diff) return "";
  if (diff > 0) return `<div class="delta up">Climbed ${diff.toLocaleString()}</div>`;
  return `<div class="delta down">Dropped ${Math.abs(diff).toLocaleString()}</div>`;
}

function progress(state) {
  if (!state.totalPairs) return 8;
  return Math.max(4, Math.min(100, (state.scannedPairs / state.totalPairs) * 100));
}

function statusLine(state) {
  if (state.status === "error") return state.error || "Could not read this chain.";
  if (state.status === "recovering") return "Rank left the watched pages. Scanning again.";
  if (state.status === "missing") {
    const total = state.totalPairs ? formatRank(state.totalPairs) : "the";
    return `Not in the top ${total} trending pairs.`;
  }
  if (state.status === "scanning" && state.match) return "Best rank is in. Checking later pages for other pools.";
  if (state.status === "scanning" && state.totalPages) return `Scanning page ${state.page || 1} of ${state.totalPages}`;
  if (state.status === "scanning") return "Opening the trending list";
  if (state.live) return "Live";
  return "Snapshot";
}

function changeRow(match) {
  const bits = [
    ["5M", match.changeM5],
    ["1H", match.changeH1],
    ["6H", match.changeH6],
    ["24H", match.changeH24],
  ];
  return bits
    .map(([label, value]) => `<span>${label} <b class="${tone(value)}">${signed(value)}</b></span>`)
    .join("");
}

function card(chainId) {
  const state = results.get(chainId) || { status: "scanning", page: 0, totalPages: 0, totalPairs: 0, scannedPairs: 0 };
  const name = esc(chainNames.get(chainId) || chainId);
  const statusClass = state.status === "error" ? "bad" : state.live ? "live" : "";
  const match = state.match;
  if (!match) {
    return `<article class="card">
      <div class="card-top"><div class="chain-name">${name}</div><div class="status ${statusClass}">${esc(statusLine(state))}</div></div>
      <p class="scan-copy">${state.status === "missing" ? "It is not on this chain’s trending list right now." : "Reading pairs in order, 100 at a time."}</p>
      <div class="bar"><i style="width:${state.status === "missing" || state.status === "error" ? 100 : progress(state)}%"></i></div>
    </article>`;
  }

  const dex = [match.dex, match.label].filter(Boolean).join(" ");
  const others = (state.others || [])
    .map(
      (other) =>
        `<a href="${esc(other.pairUrl)}" target="_blank" rel="noreferrer"><span>#${formatRank(other.rank)}</span><b>${esc(other.symbol)} / ${esc(other.quoteSymbol)}</b></a>`
    )
    .join("");

  return `<article class="card">
    <div class="card-top">
      <div class="chain-name">${name}</div>
      <div class="status ${statusClass}">${esc(statusLine(state))}</div>
    </div>
    <div class="rank-row">
      <div>
        <div class="rank"><small>#</small>${formatRank(match.rank)}</div>
        ${movement(chainId)}
      </div>
      ${spark(chainId)}
    </div>
    <div class="pair-line">
      <strong>${esc(match.symbol)} / ${esc(match.quoteSymbol)}</strong>
      ${dex ? `<span class="badge">${esc(dex)}</span>` : ""}
      <span class="why">${esc(REASON[match.reason] || "Match")}</span>
    </div>
    <div class="token-name">${esc(match.name)} · page ${match.page} · pairs ${formatRank(match.rangeStart)}–${formatRank(match.rangeEnd)}</div>
    <div class="metrics">
      <div class="metric"><span>Price</span><b>${money(match.priceUsd)}</b></div>
      <div class="metric"><span>24H</span><b class="${tone(match.changeH24)}">${signed(match.changeH24)}</b></div>
      <div class="metric"><span>Liquidity</span><b>${compact(match.liquidityUsd)}</b></div>
      <div class="metric"><span>Mkt cap</span><b>${compact(match.marketCap)}</b></div>
    </div>
    <div class="changes">${changeRow(match)}</div>
    <div class="foot">
      <div class="addr">${esc(shortAddress(match.address))} · vol ${compact(match.volumeH24)} · ${formatRank(match.txnsH24 || 0)} txns · age ${age(match.createdAt)}</div>
      <div class="links">
        <a href="${esc(match.pairUrl)}" target="_blank" rel="noreferrer">Pair</a>
        <a href="${esc(match.listUrl)}" target="_blank" rel="noreferrer">List page</a>
        <button type="button" class="mini" data-copy="${esc(match.pairUrl)}">Copy link</button>
      </div>
    </div>
    ${others ? `<div class="others"><p>Other pools</p>${others}</div>` : ""}
    ${state.status === "scanning" ? `<div class="bar"><i style="width:${progress(state)}%"></i></div>` : ""}
  </article>`;
}

function renderBoard() {
  if (!activeQuery) {
    board.innerHTML = `<div class="empty">
      <p class="empty-kicker">Trending list</p>
      <h2>Where does your token sit right now?</h2>
      <p>Find Rank walks the same pages as DexScreener — 1–100, 101–200, 201–300 — on Ethereum, Solana, Robinhood, BNB Chain, Base, and the rest. The number you get is the row number on that list.</p>
    </div>`;
    document.title = "Find Rank";
    return;
  }
  const cards = activeQuery.chains.map((id) => card(id)).join("");
  const solo = activeQuery.chains.length === 1 ? " solo" : "";
  board.innerHTML = `<div class="grid${solo}">${cards}</div>`;
  const found = activeQuery.chains.map((id) => results.get(id)?.match).find(Boolean);
  document.title = found ? `Find Rank — #${formatRank(found.rank)} ${found.symbol}` : "Find Rank";
}

function setRunning(next) {
  running = next;
  trackButton.disabled = next;
  stopButton.disabled = !next;
  trackButton.textContent = next ? "Tracking" : "Track rank";
}

function showError(message) {
  formError.hidden = !message;
  formError.textContent = message || "";
}

const onGithubPages = location.hostname.endsWith("github.io");

function connect() {
  if (onGithubPages) {
    const hosted = document.querySelector("#hosted");
    hosted.hidden = false;
    hosted.textContent = "This is the live interface. Rank lookups run in the local app, because DexScreener refuses list requests that do not come from dexscreener.com. On this computer run npm start and open http://127.0.0.1:4173.";
    setConn("Preview", "ready");
    return;
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws`);
  socket.addEventListener("open", () => {
    setConn(liveSession ? "Live" : "Ready", liveSession ? "live" : "ready");
    if (activeQuery && running) socket.send(JSON.stringify({ type: "track", ...activeQuery }));
  });
  socket.addEventListener("close", () => {
    setConn("Reconnecting", "bad");
    setTimeout(connect, 1000);
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "error") {
      showError(message.error);
      setRunning(false);
      liveSession = false;
      setConn("Ready", "ready");
      return;
    }
    if (message.type === "started") {
      activeQuery = message.query;
      results.clear();
      for (const id of message.query.chains) results.set(id, { status: "scanning" });
      renderBoard();
      return;
    }
    if (message.type === "chain") {
      results.set(message.chainId, message);
      if (message.match) rememberRank(message.chainId, message.match.rank);
      renderBoard();
      return;
    }
    if (message.type === "live") {
      liveSession = true;
      setConn("Live", "live");
      setRunning(true);
      return;
    }
    if (message.type === "idle") {
      liveSession = false;
      setRunning(false);
      setConn("Ready", "ready");
    }
  });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  showError("");
  const query = saveQuery();
  if (!query.name && !query.ticker && !query.ca) {
    showError("Enter a token name, ticker, or contract.");
    return;
  }
  if (!query.chains.length) {
    showError("Pick at least one chain.");
    return;
  }
  if (onGithubPages) {
    showError("Live ranks are available in the local app. Start it with npm start, then open http://127.0.0.1:4173.");
    return;
  }
  activeQuery = query;
  history.clear();
  results.clear();
  liveSession = query.live;
  setRunning(true);
  setConn(query.live ? "Scanning" : "Scanning", "ready");
  renderBoard();
  if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: "track", ...query }));
});

stopButton.addEventListener("click", () => {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: "stop" }));
  liveSession = false;
  setRunning(false);
  setConn("Ready", "ready");
});

document.querySelector("#popular").addEventListener("click", () => {
  selected.clear();
  for (const chain of chainCatalog.filter((item) => item.popular).slice(0, MAX_CHAINS)) selected.add(chain.id);
  syncPressed();
});

document.querySelector("#clear").addEventListener("click", () => {
  selected.clear();
  syncPressed();
});

chainSearch.addEventListener("input", () => {
  const query = chainSearch.value.trim().toLowerCase();
  if (query) more.open = true;
  for (const button of allGrid.querySelectorAll(".chain")) {
    const visible = button.textContent.toLowerCase().includes(query) || button.dataset.id.includes(query);
    button.hidden = !visible;
  }
});

board.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    const previous = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = previous;
    }, 1000);
  } catch {
    button.textContent = "Copy failed";
  }
});

const saved = loadSaved();
fetch("chains.json")
  .then((response) => response.json())
  .then((payload) => {
    renderChains(payload.chains);
    applySaved(saved);
  })
  .catch(() => {
    showError("Could not load the chain list.");
  });

connect();
renderBoard();
