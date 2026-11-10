const { BY_ID } = require("./chains");
const { matches, matchReason } = require("./match");
const { TIMEFRAMES, fetchPageRetry, openFeed, pageUrl, pairUrl, Pool } = require("./screener");

const pool = new Pool(3);
const MAX_CHAINS = 8;
const MAX_OTHERS = 8;

function explainFailure(reason) {
  const text = String(reason || "unknown").replace(/\s+/g, " ").slice(0, 120);
  if (/timeout/i.test(text)) {
    return "DexScreener timed out on this PC. Allow Find Rank through the firewall, then press Track rank again.";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return "This PC could not find DexScreener. Check the internet connection, then press Track rank again.";
  }
  if (/CERT|UNABLE_TO|self signed/i.test(text)) {
    return "Security software on this PC blocked DexScreener. Allow Find Rank, then press Track rank again.";
  }
  if (/403|401/.test(text)) {
    return "DexScreener refused this PC. Press Track rank again.";
  }
  if (/closed 1006|ECONN|EAI_|socket|network/i.test(text)) {
    return "DexScreener dropped the connection on this PC. Allow Find Rank through the firewall, then press Track rank again.";
  }
  return `This PC could not reach DexScreener (${text}). Check the firewall, proxy, or VPN, then press Track rank again.`;
}

function normalizeQuery(raw) {
  const name = String(raw?.name || "").trim();
  const ticker = String(raw?.ticker || "").trim();
  const ca = String(raw?.ca || "").trim();
  const timeframe = TIMEFRAMES.includes(raw?.timeframe) ? raw.timeframe : "h6";
  const findAll = Boolean(raw?.findAll);
  const live = raw?.live !== false;
  const chains = [];
  const seen = new Set();
  for (const id of raw?.chains || []) {
    if (!BY_ID.has(id) || seen.has(id)) continue;
    seen.add(id);
    chains.push(id);
    if (chains.length >= MAX_CHAINS) break;
  }
  if (!name && !ticker && !ca) {
    throw new Error("Enter a token name, ticker, or contract.");
  }
  if (!chains.length) throw new Error("Pick at least one chain.");
  return { name, ticker, ca, timeframe, findAll, live, chains };
}

function hitsOnPage(payload, page, query) {
  const reason = matchReason(query);
  const hits = [];
  payload.pairs.forEach((pair, index) => {
    if (!matches(pair.base, query)) return;
    hits.push({
      rank: (page - 1) * 100 + index + 1,
      page,
      index,
      pair,
      reason,
    });
  });
  return hits;
}

function present(hit, chainId, timeframe, total) {
  const { pair } = hit;
  const pageCount = Math.max(1, Math.ceil((total || 0) / 100));
  return {
    rank: hit.rank,
    page: hit.page,
    pageCount,
    rangeStart: (hit.page - 1) * 100 + 1,
    rangeEnd: Math.min(hit.page * 100, total || hit.page * 100),
    total: total || null,
    symbol: pair.base.symbol,
    name: pair.base.name,
    address: pair.base.address,
    quoteSymbol: pair.quote.symbol,
    dex: pair.dex,
    label: pair.label,
    priceUsd: pair.priceUsd,
    liquidityUsd: pair.liquidityUsd,
    marketCap: pair.marketCap || pair.fdv,
    volumeH24: pair.volumeH24,
    changeM5: pair.changeM5,
    changeH1: pair.changeH1,
    changeH6: pair.changeH6,
    changeH24: pair.changeH24,
    txnsH24: pair.txnsH24,
    tradersH24: pair.tradersH24,
    createdAt: pair.createdAt,
    pairUrl: pair.pairAddress ? pairUrl(chainId, pair.pairAddress) : null,
    listUrl: pageUrl(chainId, hit.page, timeframe),
    reason: hit.reason,
  };
}

function blankState() {
  return {
    status: "scanning",
    page: 0,
    totalPages: 0,
    totalPairs: 0,
    scannedPairs: 0,
    match: null,
    others: [],
    error: null,
    updatedAt: null,
    live: false,
    watchId: 0,
    feeds: [],
    watchPages: [],
    cache: new Map(),
    recovering: false,
    lastPublish: 0,
    lastRank: null,
  };
}

function viewOf(state) {
  return {
    status: state.status,
    page: state.page,
    totalPages: state.totalPages,
    totalPairs: state.totalPairs,
    scannedPairs: state.scannedPairs,
    match: state.match,
    others: state.others,
    error: state.error,
    updatedAt: state.updatedAt,
    live: state.live,
  };
}

function neighborPages(page, totalPages) {
  const pages = [];
  const last = Math.max(1, totalPages || page);
  for (let cursor = page - 1; cursor <= page + 1; cursor += 1) {
    if (cursor >= 1 && cursor <= last) pages.push(cursor);
  }
  return pages.length ? pages : [1];
}

function createSession(ws, raw) {
  const query = normalizeQuery(raw);
  const controller = new AbortController();
  const session = {
    ws,
    query,
    signal: controller.signal,
    chains: new Map(),
    stop() {
      controller.abort();
      for (const state of this.chains.values()) stopFeeds(state);
    },
    send(message) {
      if (ws.readyState === 1) ws.send(JSON.stringify(message));
    },
  };
  for (const chainId of query.chains) session.chains.set(chainId, blankState());
  return session;
}

function publish(session, chainId, force) {
  const state = session.chains.get(chainId);
  const rank = state.match?.rank ?? null;
  const now = Date.now();
  if (!force && rank === state.lastRank && now - state.lastPublish < 700) return;
  state.lastRank = rank;
  state.lastPublish = now;
  session.send({
    type: "chain",
    chainId,
    chainName: BY_ID.get(chainId).name,
    ...viewOf(state),
  });
}

function stopFeeds(state) {
  for (const feed of state.feeds) feed.stop();
  state.feeds = [];
  state.live = false;
  state.cache = new Map();
}

function remember(state, best, others, total) {
  state.match = present(best, state.chainId, state.timeframe, total);
  state.others = others.slice(0, MAX_OTHERS).map((hit) => present(hit, state.chainId, state.timeframe, total));
  state.page = best.page;
  state.updatedAt = Date.now();
  state.error = null;
}

async function scanChain(session, chainId) {
  const state = session.chains.get(chainId);
  state.chainId = chainId;
  state.timeframe = session.query.timeframe;
  state.status = state.match ? "recovering" : "scanning";
  state.error = null;
  if (!state.match) {
    state.others = [];
    state.page = 0;
    state.scannedPairs = 0;
  }
  publish(session, chainId, true);

  const first = await pool.run(() => fetchPageRetry(chainId, 1, session.query.timeframe, session.signal));
  if (session.signal.aborted) return;

  const total = first.total || first.pairs.length;
  const totalPages = Math.max(1, Math.ceil(total / 100));
  state.totalPairs = total;
  state.totalPages = totalPages;

  let best = null;
  let others = [];
  const take = (page, payload) => {
    state.page = page;
    state.scannedPairs = Math.min(total, (page - 1) * 100 + payload.pairs.length);
    const hits = hitsOnPage(payload, page, session.query);
    if (!hits.length) return;
    if (!best) {
      best = hits[0];
      others = hits.slice(1);
      state.status = session.query.findAll ? "scanning" : "found";
      remember(state, best, others, total);
      return;
    }
    if (session.query.findAll || hits[0].page === best.page) {
      others = others.concat(hits);
      remember(state, best, others, total);
    }
  };

  take(1, first);
  publish(session, chainId, true);

  let page = 2;
  while (page <= totalPages && (session.query.findAll || !best)) {
    if (session.signal.aborted) return;
    const batch = [];
    for (let cursor = page; cursor < page + 2 && cursor <= totalPages; cursor += 1) batch.push(cursor);
    const results = await Promise.all(
      batch.map((cursor) => pool.run(() => fetchPageRetry(chainId, cursor, session.query.timeframe, session.signal)))
    );
    if (session.signal.aborted) return;
    batch.forEach((cursor, index) => take(cursor, results[index]));
    publish(session, chainId, true);
    page += batch.length;
  }

  if (session.signal.aborted) return;
  if (best) {
    state.status = "found";
    remember(state, best, others, total);
  } else {
    state.status = "missing";
    state.match = null;
    state.others = [];
    state.scannedPairs = total;
    state.updatedAt = Date.now();
  }
  publish(session, chainId, true);
}

function startWatch(session, chainId) {
  const state = session.chains.get(chainId);
  if (!state?.match || session.signal.aborted || !session.query.live) return;
  stopFeeds(state);
  const watchId = state.watchId + 1;
  state.watchId = watchId;
  const pages = neighborPages(state.match.page, state.totalPages);
  state.watchPages = pages;
  state.live = true;
  state.feeds = pages.map((page) =>
    openFeed(chainId, page, session.query.timeframe, {
      onSnapshot: (payload) => onSnapshot(session, chainId, watchId, page, payload),
    })
  );
  publish(session, chainId, true);
}

function onSnapshot(session, chainId, watchId, page, payload) {
  const state = session.chains.get(chainId);
  if (!state || state.watchId !== watchId || session.signal.aborted) return;
  state.cache.set(page, payload);
  if (payload.total) {
    state.totalPairs = payload.total;
    state.totalPages = Math.max(1, Math.ceil(payload.total / 100));
  }

  let best = null;
  let others = [];
  const pages = [...state.cache.keys()].sort((a, b) => a - b);
  for (const cursor of pages) {
    const hits = hitsOnPage(state.cache.get(cursor), cursor, session.query);
    if (!hits.length) continue;
    if (!best) {
      best = hits[0];
      others = hits.slice(1);
    } else {
      others = others.concat(hits);
    }
  }

  if (best) {
    const previousPage = state.match?.page;
    state.status = "found";
    remember(state, best, others, state.totalPairs);
    const nextPages = neighborPages(best.page, state.totalPages);
    const moved = previousPage !== best.page || nextPages.join() !== state.watchPages.join();
    publish(session, chainId, previousPage !== best.page);
    if (moved) startWatch(session, chainId);
    return;
  }

  if (state.watchPages.every((cursor) => state.cache.has(cursor))) {
    recover(session, chainId, watchId);
  }
}

async function recover(session, chainId, watchId) {
  const state = session.chains.get(chainId);
  if (!state || state.recovering || state.watchId !== watchId) return;
  state.recovering = true;
  state.status = "recovering";
  publish(session, chainId, true);
  stopFeeds(state);
  try {
    await scanChain(session, chainId);
  } catch (error) {
    if (session.signal.aborted || error.message === "aborted") return;
    state.status = "error";
    state.error = "The rank moved and the rescan failed.";
    publish(session, chainId, true);
  } finally {
    state.recovering = false;
  }
  if (session.signal.aborted) return;
  if (state.match && session.query.live) startWatch(session, chainId);
}

async function run(session) {
  session.send({
    type: "started",
    query: {
      name: session.query.name,
      ticker: session.query.ticker,
      ca: session.query.ca,
      timeframe: session.query.timeframe,
      live: session.query.live,
      findAll: session.query.findAll,
      chains: session.query.chains,
    },
  });

  await Promise.all(
    session.query.chains.map(async (chainId) => {
      try {
        await scanChain(session, chainId);
      } catch (error) {
        if (session.signal.aborted || error.message === "aborted") return;
        const state = session.chains.get(chainId);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (session.signal.aborted) return;
          await scanChain(session, chainId);
        } catch (again) {
          if (session.signal.aborted || again.message === "aborted") return;
          const reason = String(again.message || error.message || "unknown");
          state.status = "error";
          state.error = explainFailure(reason);
          state.updatedAt = Date.now();
          publish(session, chainId, true);
        }
      }
    })
  );

  if (session.signal.aborted) return;
  if (session.query.live) {
    for (const chainId of session.query.chains) {
      if (session.chains.get(chainId).match) startWatch(session, chainId);
    }
    const timer = setInterval(() => {
      if (session.signal.aborted) return;
      for (const chainId of session.query.chains) {
        const state = session.chains.get(chainId);
        if (state.status !== "missing" || state.totalPages > 120 || state.recovering) continue;
        state.recovering = true;
        scanChain(session, chainId)
          .catch(() => {})
          .finally(() => {
            state.recovering = false;
            if (!session.signal.aborted && state.match) startWatch(session, chainId);
          });
      }
    }, 90000);
    session.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    session.send({ type: "live" });
  } else {
    session.send({ type: "idle" });
  }
}

module.exports = { createSession, run, normalizeQuery, MAX_CHAINS };
