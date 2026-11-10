const WINDOWS = { m5: "Trending 5M", h1: "Trending 1H", h6: "Trending 6H", h24: "Trending 24H" };
const form = document.querySelector("#form");
const error = document.querySelector("#error");
const readout = document.querySelector("#readout");
const status = document.querySelector("#status");
const live = document.querySelector("#live");

function field(id) {
  return document.querySelector(`#${id}`);
}

function showError(message) {
  error.hidden = !message;
  error.textContent = message || "";
}

function money(value) {
  if (value == null || !Number.isFinite(value)) return "";
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  return `$${value.toPrecision(3)}`;
}

function render(result, tracking) {
  const on = Boolean(tracking) && result && result.status !== "idle";
  live.textContent = result?.status === "live" ? "Live" : on ? "Scanning" : "Ready";
  live.classList.toggle("on", result?.status === "live");
  if (!result || result.status === "idle") {
    readout.hidden = true;
    status.hidden = true;
    return;
  }
  if (result.status === "scanning") {
    readout.hidden = true;
    status.hidden = false;
    const page = result.totalPages ? ` page ${result.page || 1} of ${result.totalPages}` : "";
    status.textContent = `Reading the trending list${page}.`;
    return;
  }
  if (result.status === "missing") {
    readout.hidden = true;
    status.hidden = false;
    status.textContent = "That pair is not on this chain’s trending list right now.";
    return;
  }
  if (result.status === "error") {
    readout.hidden = true;
    status.hidden = false;
    status.textContent = result.error || "DexScreener did not answer.";
    return;
  }
  status.hidden = true;
  readout.hidden = false;
  const rank = document.querySelector("#rank");
  rank.textContent = `#${Number(result.rank).toLocaleString()}`;
  rank.href = result.pairUrl || "https://dexscreener.com/";
  document.querySelector("#window").textContent = WINDOWS[result.timeframe] || "Trending";
  document.querySelector("#pair").textContent = `${result.symbol || "—"} / ${result.quote || ""}`.trim();
  const price = money(result.priceUsd);
  document.querySelector("#detail").textContent = [result.name, price, result.reason].filter(Boolean).join(" · ");
}

function readForm() {
  return {
    name: field("name").value.trim(),
    ticker: field("ticker").value.trim(),
    ca: field("ca").value.trim(),
    base: field("base").value.trim(),
    pair: field("pair").value.trim(),
    chainId: field("chain").value,
    timeframe: field("timeframe").value,
    live: true,
  };
}

function fill(settings) {
  if (!settings) return;
  for (const id of ["name", "ticker", "ca", "base", "pair", "timeframe"]) {
    if (settings[id]) field(id).value = settings[id];
  }
  if (settings.chainId) field("chain").value = settings.chainId;
}

async function loadChains() {
  const response = await fetch(chrome.runtime.getURL("chains.json"));
  const data = await response.json();
  const select = field("chain");
  const popular = data.chains.filter((chain) => chain.popular);
  const rest = data.chains.filter((chain) => !chain.popular);
  for (const chain of [...popular, ...rest]) {
    const option = document.createElement("option");
    option.value = chain.id;
    option.textContent = chain.name;
    select.append(option);
  }
  select.value = "ethereum";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  showError("");
  const query = readForm();
  if (!query.name && !query.ticker && !query.ca && !query.base && !query.pair) {
    showError("Enter a token name, ticker, contract, base token, or pair address.");
    return;
  }
  highlightState = null;
  chrome.runtime.sendMessage({ type: "track", query });
  render({ status: "scanning", page: 1, totalPages: 0 }, true);
});

let highlightState = null;

function renderHighlight(highlight) {
  highlightState = highlight || null;
  if (!highlight || highlight.status === "idle") return;
  status.hidden = false;
  if (highlight.status === "scanning") {
    const page = highlight.totalPages ? ` page ${highlight.page || 1} of ${highlight.totalPages}` : "";
    status.textContent = `Finding the row${page}.`;
    return;
  }
  if (highlight.status === "shown") {
    status.textContent = `Highlighted #${Number(highlight.rank).toLocaleString()} on the list.`;
    return;
  }
  if (highlight.status === "missing") {
    status.textContent = "That pair is not on this chain’s trending list right now.";
    return;
  }
  if (highlight.status === "error") status.textContent = highlight.error || "Could not highlight that pair.";
}

document.querySelector("#stop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop" });
  highlightState = null;
  render({ status: "idle" }, false);
});

document.querySelector("#highlight").addEventListener("click", () => {
  showError("");
  const next = readForm();
  if (!next.name && !next.ticker && !next.ca && !next.base && !next.pair) {
    showError("Enter a token name, ticker, contract, base token, or pair address.");
    return;
  }
  chrome.runtime.sendMessage({ type: "highlight", query: next });
  renderHighlight({ status: "scanning", page: 1, totalPages: 0 });
});

document.querySelector("#rank").addEventListener("click", (event) => {
  event.preventDefault();
  const url = event.currentTarget.href;
  if (url) chrome.tabs.create({ url });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.result || changes.tracking || changes.highlight) {
    chrome.storage.local.get(["result", "tracking", "highlight"]).then((stored) => {
      render(stored.result, stored.tracking);
      if (stored.highlight) renderHighlight(stored.highlight);
    });
  }
});

loadChains()
  .then(() => chrome.storage.local.get(["query", "result", "tracking", "highlight"]))
  .then((stored) => {
    fill(stored.query);
    render(stored.result, stored.tracking);
    if (stored.highlight) renderHighlight(stored.highlight);
  })
  .catch(() => showError("The chain list did not load."));
