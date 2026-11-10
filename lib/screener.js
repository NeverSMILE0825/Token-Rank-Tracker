const WebSocket = require("ws");
const { readFields, fieldsNamed, asMessage, firstNumber, firstString } = require("./proto");

const RANK_KEY = {
  m5: "trendingScoreM5",
  h1: "trendingScoreH1",
  h6: "trendingScoreH6",
  h24: "trendingScoreH24",
};

const TIMEFRAMES = Object.keys(RANK_KEY);

function pageUrl(chainId, page, timeframe) {
  const rankBy = RANK_KEY[timeframe] || RANK_KEY.h24;
  const path = page <= 1 ? `https://dexscreener.com/${chainId}` : `https://dexscreener.com/${chainId}/page-${page}`;
  return `${path}?order=desc&rankBy=${rankBy}`;
}

function pairUrl(chainId, pairAddress) {
  return `https://dexscreener.com/${chainId}/${pairAddress}`;
}

function socketUrl(chainId, page, timeframe) {
  const tf = RANK_KEY[timeframe] ? timeframe : "h24";
  const rankBy = RANK_KEY[tf];
  const query = `rankBy[key]=${rankBy}&rankBy[order]=desc&filters[chainIds][0]=${encodeURIComponent(chainId)}`;
  return `wss://io.dexscreener.com/dex/screener/v7/pairs/${tf}/${page}?${query}`;
}

function nestedNumber(fields, field) {
  const direct = firstNumber(fields, field);
  if (direct != null) return direct;
  const entry = fields.find((item) => item.field === field);
  const inner = asMessage(entry);
  if (!inner.length) return null;
  const asText = firstString(inner, 1);
  if (asText != null && asText !== "" && Number.isFinite(Number(asText))) return Number(asText);
  return firstNumber(inner, 1);
}

function messageAt(fields, field) {
  return asMessage(fields.find((item) => item.field === field));
}

function slotEntry(fields, field, index) {
  return messageAt(fields, field).find((item) => item.field === index) || null;
}

function slotNumber(fields, field, index) {
  const chosen = slotEntry(fields, field, index);
  if (!chosen) return null;
  if (typeof chosen.value === "number") return chosen.value;
  const inner = asMessage(chosen);
  const text = firstString(inner, 1);
  if (text != null && text !== "" && Number.isFinite(Number(text))) return Number(text);
  return firstNumber(inner, 1);
}

function readToken(entry) {
  const fields = asMessage(entry);
  if (!fields.length) return null;
  const address = firstString(fields, 1);
  const name = firstString(fields, 2);
  const symbol = firstString(fields, 3);
  if (!address || !symbol) return null;
  return { address, name: name || symbol, symbol };
}

function parsePair(buf) {
  const fields = readFields(buf);
  const base = readToken(fields.find((item) => item.field === 10));
  const quote = readToken(fields.find((item) => item.field === 11));
  if (!base || !quote) return null;

  const tx = asMessage(slotEntry(fields, 14, 4));
  const buys = firstNumber(tx, 1) || 0;
  const sells = firstNumber(tx, 2) || 0;
  const tradersH24 = slotNumber(fields, 17, 4);
  const volumeH24 = slotNumber(fields, 18, 4);
  const changeH24 = slotNumber(fields, 21, 4);
  const changeH6 = slotNumber(fields, 21, 3);
  const changeH1 = slotNumber(fields, 21, 2);
  const changeM5 = slotNumber(fields, 21, 1);

  return {
    chainId: firstString(fields, 6),
    dex: firstString(fields, 7),
    label: firstString(fields, 8),
    pairAddress: firstString(fields, 9),
    base,
    quote,
    priceUsd: nestedNumber(fields, 13),
    liquidityUsd: nestedNumber(fields, 22),
    marketCap: nestedNumber(fields, 23),
    fdv: nestedNumber(fields, 24),
    volumeH24,
    changeH24,
    changeH6,
    changeH1,
    changeM5,
    txnsH24: buys + sells,
    tradersH24,
    createdAt: nestedNumber(fields, 25),
  };
}

function parsePayload(buf) {
  const top = readFields(buf);
  const root = top.find((item) => item.field === 1 && Buffer.isBuffer(item.value));
  if (!root) return { total: 0, pairs: [] };
  const inner = readFields(root.value);
  const totalField = inner.find((item) => item.field === 3 && typeof item.value === "number");
  const pairs = fieldsNamed(inner, 2)
    .filter((item) => Buffer.isBuffer(item.value))
    .map((item) => parsePair(item.value))
    .filter(Boolean);
  return { total: totalField ? totalField.value : pairs.length, pairs };
}

function fetchPage(chainId, page, timeframe, signal) {
  const url = socketUrl(chainId, page, timeframe);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const ws = new WebSocket(url, {
      headers: {
        Origin: "https://dexscreener.com",
        "User-Agent": "FindRank/1.0",
      },
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("timeout")), 20000);
    const onAbort = () => finish(reject, new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.on("error", (error) => finish(reject, error));
    ws.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 500) return;
      try {
        finish(resolve, parsePayload(buf));
      } catch (error) {
        finish(reject, error);
      }
    });
  });
}

function pageIsComplete(payload, page) {
  const total = payload?.total || payload?.pairs?.length || 0;
  const pages = Math.max(1, Math.ceil(total / 100));
  const count = payload?.pairs?.length || 0;
  if (!count && total > 0) return false;
  if (page < pages && count !== 100) return false;
  return true;
}

async function fetchPageRetry(chainId, page, timeframe, signal) {
  let lastError = new Error("no data");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const payload = await fetchPage(chainId, page, timeframe, signal);
      if (!pageIsComplete(payload, page)) {
        lastError = new Error("incomplete");
      } else {
        return payload;
      }
    } catch (error) {
      if (signal?.aborted || error.message === "aborted") throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    if (signal?.aborted) throw new Error("aborted");
  }
  throw lastError;
}

function openFeed(chainId, page, timeframe, handlers) {
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let lastSnapshot = Date.now();

  const connect = () => {
    if (stopped) return;
    lastSnapshot = Date.now();
    socket = new WebSocket(socketUrl(chainId, page, timeframe), {
      headers: {
        Origin: "https://dexscreener.com",
        "User-Agent": "FindRank/1.0",
      },
    });
    socket.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 500) return;
      lastSnapshot = Date.now();
      try {
        const payload = parsePayload(buf);
        if (!pageIsComplete(payload, page)) return;
        handlers.onSnapshot(payload);
      } catch (error) {
        handlers.onError?.(error);
      }
    });
    socket.on("close", () => {
      if (stopped) return;
      reconnectTimer = setTimeout(connect, 800);
    });
    socket.on("error", () => {
      try {
        socket.terminate();
      } catch {
        /* close handler reconnects */
      }
    });
  };

  connect();
  const watchdog = setInterval(() => {
    if (stopped || Date.now() - lastSnapshot < 10000) return;
    try {
      socket?.terminate();
    } catch {
      /* close handler reconnects */
    }
  }, 4000);
  return {
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(watchdog);
      try {
        socket?.terminate();
      } catch {
        /* already closed */
      }
    },
  };
}

class Pool {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.limit && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}

module.exports = {
  RANK_KEY,
  TIMEFRAMES,
  pageUrl,
  pairUrl,
  parsePayload,
  fetchPage,
  fetchPageRetry,
  openFeed,
  Pool,
};
