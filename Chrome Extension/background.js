const BADGE = {
  live: "#3f6212",
  scan: "#57534e",
  miss: "#854d0e",
  error: "#9f1239",
};

let tabId = null;
let ownedTab = false;
let tracking = false;
let query = null;
let arming = false;
let armedAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function deliver(id) {
  const inject = () => chrome.scripting.executeScript({
    target: { tabId: id },
    world: "MAIN",
    files: ["page.js"],
  });
  await inject();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(id, { type: "track", query });
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

async function arm() {
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
    await deliver(tab.id);
    armedAt = Date.now();
    await chrome.alarms.create("find-rank-watch", { periodInMinutes: 1 });
  } catch (error) {
    await saveResult({ status: "error", error: error.message || "Could not open DexScreener." });
  } finally {
    arming = false;
  }
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
  if (message?.source === "find-rank-page" && sender.tab?.id === tabId && tracking) {
    if (message.type === "pong") {
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
