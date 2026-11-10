const BADGE = {
  live: "#3f6212",
  scan: "#57534e",
  miss: "#854d0e",
  error: "#9f1239",
};

const RANK_KEY = {
  m5: "trendingScoreM5",
  h1: "trendingScoreH1",
  h6: "trendingScoreH6",
  h24: "trendingScoreH24",
};

let tabId = null;
let ownedTab = false;
let highlightTabId = null;
let tracking = false;
let query = null;
let arming = false;
let armedAt = 0;
let locateWait = null;
let turn = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueue(task) {
  const run = turn.then(task, task);
  turn = run.then(() => {}, () => {});
  return run;
}

function listUrl(chainId, page, timeframe) {
  const rankBy = RANK_KEY[timeframe] || RANK_KEY.h6;
  const path = page <= 1 ? `https://dexscreener.com/${chainId}` : `https://dexscreener.com/${chainId}/page-${page}`;
  return `${path}?order=desc&rankBy=${rankBy}`;
}

function sameQuery(left, right) {
  if (!left || !right) return false;
  return ["name", "ticker", "ca", "base", "pair", "chainId", "timeframe"].every((key) => (left[key] || "") === (right[key] || ""));
}

function pairAddressFrom(result) {
  if (result?.pairAddress) return result.pairAddress;
  const match = String(result?.pairUrl || "").match(/dexscreener\.com\/[^/]+\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

function badgeText(rank) {
  if (rank == null || !Number.isFinite(rank)) return "";
  if (rank < 10000) return String(rank);
  if (rank < 100000) return `${(rank / 1000).toFixed(1)}k`;
  return `${Math.round(rank / 1000)}k`;
}

async function paint(result) {
  const status = result?.status || "idle";
  let text = "";
  let color = BADGE.scan;
  let title = "Find Rank";
  if (status === "live" || status === "found") {
    text = badgeText(result.rank);
    color = BADGE.live;
    title = `Find Rank — #${result.rank} ${result.symbol || ""}`.trim();
  } else if (status === "scanning") {
    text = "...";
    color = BADGE.scan;
    title = "Find Rank — scanning";
  } else if (status === "missing") {
    text = "--";
    color = BADGE.miss;
    title = "Find Rank — not on this list";
  } else if (status === "error") {
    text = "!";
    color = BADGE.error;
    title = `Find Rank — ${result.error || "connection failed"}`;
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  }
  await chrome.action.setTitle({ title });
}

async function saveResult(result) {
  await chrome.storage.local.set({ result, tracking, query });
  await paint(result);
}

async function ensureTab() {
  if (tabId != null) {
    try {
      const existing = await chrome.tabs.get(tabId);
      if (existing?.url?.startsWith("https://dexscreener.com/")) return existing;
    } catch {
      tabId = null;
    }
  }
  const open = await chrome.tabs.query({ url: "https://dexscreener.com/*" });
  if (open.length) {
    tabId = open[0].id;
    ownedTab = false;
    return open[0];
  }
  const created = await chrome.tabs.create({ url: "https://dexscreener.com/", active: false });
  tabId = created.id;
  ownedTab = true;
  return created;
}

async function waitUntilLoaded(id) {
  const current = await chrome.tabs.get(id);
  if (current.status === "complete" && current.url?.startsWith("https://dexscreener.com/")) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("DexScreener took too long to open."));
    }, 30000);
    const onUpdated = (updatedId, info, tab) => {
      if (updatedId !== id || info.status !== "complete") return;
      if (!tab.url?.startsWith("https://dexscreener.com/")) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function deliver(id, message) {
  const inject = () => chrome.scripting.executeScript({
    target: { tabId: id },
    world: "MAIN",
    files: ["page.js"],
  });
  await inject();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(id, message);
      return;
    } catch {
      if (attempt === 2) {
        await chrome.tabs.reload(id);
        await waitUntilLoaded(id);
        await inject();
      }
      await sleep(400);
    }
  }
  throw new Error("The DexScreener tab did not connect. Reload that tab, then press Track again.");
}

function markRow(pairAddress, symbol, name) {
  const boxId = "find-rank-highlight-box";
  let box = document.getElementById(boxId);
  if (!box) {
    box = document.createElement("div");
    box.id = boxId;
    box.style.position = "fixed";
    box.style.pointerEvents = "none";
    box.style.zIndex = "2147483646";
    box.style.boxSizing = "border-box";
    box.style.border = "3px solid #ff2a2a";
    box.style.borderRadius = "4px";
    box.style.background = "rgba(255, 42, 42, 0.12)";
    box.style.display = "none";
    document.documentElement.appendChild(box);
  }
  if (!box.dataset.bound) {
    box.dataset.bound = "1";
    const sync = () => {
      if (box.__row && box.__row.isConnected) place(box.__row);
      else box.style.display = "none";
    };
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
  }

  function clipOf(row) {
    let left = 0;
    let top = 0;
    let right = window.innerWidth;
    let bottom = window.innerHeight;
    let el = row.parentElement;
    while (el && el !== document.documentElement) {
      const style = getComputedStyle(el);
      const overflow = `${style.overflow}${style.overflowX}${style.overflowY}`;
      if (/auto|scroll|hidden/.test(overflow)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20) {
          left = Math.max(left, rect.left);
          top = Math.max(top, rect.top);
          right = Math.min(right, rect.right);
          bottom = Math.min(bottom, rect.bottom);
        }
      }
      el = el.parentElement;
    }
    return { left, top, right, bottom };
  }

  function place(row) {
    const rowRect = row.getBoundingClientRect();
    const clip = clipOf(row);
    const left = Math.max(rowRect.left, clip.left);
    const top = Math.max(rowRect.top, clip.top);
    const right = Math.min(rowRect.right, clip.right);
    const bottom = Math.min(rowRect.bottom, clip.bottom);
    const width = right - left;
    const height = bottom - top;
    if (width < 8 || height < 8) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
  }

  const wantAddress = String(pairAddress || "").toLowerCase();
  const wantSymbol = String(symbol || "").replace(/^\$+/, "").replace(/\s+/g, "").toUpperCase();
  const wantName = String(name || "").trim().toLowerCase();
  const started = Date.now();
  const widest = (rows) => rows.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null;
  const find = () => {
    const links = [...document.querySelectorAll("a[href]")];
    let row = wantAddress
      ? widest(links.filter((link) => (link.getAttribute("href") || "").toLowerCase().includes(wantAddress)))
      : null;
    if (!row && wantSymbol) {
      row = widest(links.filter((link) => {
        const text = link.innerText || "";
        const symbolOk = text.toUpperCase().replace(/\s+/g, "").includes(wantSymbol);
        const nameOk = !wantName || text.toLowerCase().includes(wantName);
        return symbolOk && nameOk && text.trim().startsWith("#");
      }));
    }
    if (!row) return null;
    box.__row = row;
    row.scrollIntoView({ block: "center", inline: "nearest" });
    place(row);
    requestAnimationFrame(() => place(row));
    return { ok: true, text: (row.innerText || "").slice(0, 220) };
  };
  return new Promise((resolve) => {
    const tick = () => {
      const found = find();
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - started > 12000) {
        resolve({ ok: false });
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function openList(url) {
  if (highlightTabId != null && highlightTabId !== tabId) {
    try {
      return await chrome.tabs.update(highlightTabId, { url, active: true });
    } catch {
      highlightTabId = null;
    }
  }
  const created = await chrome.tabs.create({ url, active: true });
  highlightTabId = created.id;
  return created;
}

async function showOnList(found) {
  const chainId = found.chainId || "ethereum";
  const timeframe = found.timeframe || "h6";
  const pages = [found.page || 1];
  if ((found.page || 1) > 1) pages.push(found.page - 1);
  pages.push((found.page || 1) + 1);
  let last = { ok: false };
  for (const page of pages) {
    const tab = await openList(listUrl(chainId, page, timeframe));
    highlightTabId = tab.id;
    await waitUntilLoaded(tab.id);
    const [drawn] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: markRow,
      args: [pairAddressFrom(found), found.symbol || "", found.name || ""],
    });
    last = drawn?.result || { ok: false };
    if (last.ok) return { ...last, page };
  }
  return last;
}

async function rememberHighlight(highlight) {
  await chrome.storage.local.set({ highlight });
}

async function highlight(nextQuery) {
  return enqueue(async () => {
    const stored = await chrome.storage.local.get(["result", "query"]);
    await chrome.storage.local.set({ query: nextQuery });
    await rememberHighlight({ status: "scanning", page: 1, totalPages: 0 });
    let found = null;
    if (stored.result?.status === "live" && sameQuery(stored.query, nextQuery) && pairAddressFrom(stored.result)) {
      found = stored.result;
    } else {
      const tab = await ensureTab();
      await waitUntilLoaded(tab.id);
      const pending = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          locateWait = null;
          reject(new Error("DexScreener did not answer. Press Highlight again."));
        }, 90000);
        locateWait = (message) => {
          clearTimeout(timer);
          locateWait = null;
          resolve(message);
        };
      });
      await deliver(tab.id, { type: "locate", query: nextQuery });
      const message = await pending;
      if (message.status === "missing") throw new Error("That pair is not on this chain’s trending list right now.");
      if (message.status === "error" || message.type === "locate-status") {
        throw new Error(message.error || "DexScreener did not answer.");
      }
      found = message;
    }
    const drawn = await showOnList(found);
    if (!drawn.ok) throw new Error("The list opened, but that pair was not on the page.");
    await rememberHighlight({
      status: "shown",
      rank: found.rank,
      symbol: found.symbol,
      name: found.name,
      page: drawn.page,
    });
    return { rank: found.rank, page: drawn.page };
  });
}

async function arm() {
  if (!tracking || !query || arming) return;
  return enqueue(async () => {
  if (!tracking || !query || arming) return;
  arming = true;
  try {
    const tab = await ensureTab();
    await waitUntilLoaded(tab.id);
    if (ownedTab) {
      try {
        await chrome.tabs.update(tab.id, { pinned: true });
      } catch {
        /* pinning is optional */
      }
    }
    await deliver(tab.id, { type: "track", query });
    armedAt = Date.now();
    await chrome.alarms.create("find-rank-watch", { periodInMinutes: 1 });
  } catch (error) {
    await saveResult({ status: "error", error: error.message || "Could not open DexScreener." });
  } finally {
    arming = false;
  }
  });
}

async function start(nextQuery) {
  query = nextQuery;
  tracking = true;
  await chrome.storage.local.set({ query, tracking: true });
  await saveResult({ status: "scanning", page: 1, totalPages: 0 });
  await arm();
}

async function stop() {
  tracking = false;
  await chrome.alarms.clear("find-rank-watch");
  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "stop" });
    } catch {
      /* tab already closed */
    }
  }
  await saveResult({ status: "idle" });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "track" && message.query && sender.id === chrome.runtime.id && !sender.tab) {
    start(message.query);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "highlight" && message.query && sender.id === chrome.runtime.id && !sender.tab) {
    highlight(message.query)
      .then((info) => sendResponse({ ok: true, ...info }))
      .catch(async (error) => {
        await rememberHighlight({ status: "error", error: error.message || "Could not highlight that pair." });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (message?.type === "stop" && !sender.tab) {
    stop();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.source === "find-rank-content" && message.type === "ready") {
    if (tracking && sender.tab?.id === tabId && Date.now() - armedAt > 4000) arm();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.source === "find-rank-page" && sender.tab?.id === tabId) {
    if (message.type === "pong") {
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "locate-status") {
      rememberHighlight({
        status: message.status,
        page: message.page,
        totalPages: message.totalPages,
        error: message.error,
      });
      if (message.status === "missing" || message.status === "error") locateWait?.(message);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "located") {
      locateWait?.(message);
      sendResponse({ ok: true });
      return false;
    }
    if (!tracking) {
      sendResponse({ ok: true });
      return false;
    }
    const { source: _source, ...result } = message;
    saveResult(result);
    sendResponse({ ok: true });
  }
  return false;
});

chrome.tabs.onRemoved.addListener((closedId) => {
  if (closedId !== tabId) return;
  tabId = null;
  ownedTab = false;
  if (tracking) arm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "find-rank-watch" || !tracking) return;
  try {
    if (tabId == null) {
      await arm();
      return;
    }
    const tab = await chrome.tabs.get(tabId);
    if (tab.discarded || !tab.url?.startsWith("https://dexscreener.com/")) {
      await arm();
      return;
    }
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    tabId = null;
    await arm();
  }
});

chrome.storage.local.get(["tracking", "query", "result"]).then((stored) => {
  tracking = Boolean(stored.tracking);
  query = stored.query || null;
  if (stored.result) paint(stored.result);
  if (tracking && query) arm();
});
