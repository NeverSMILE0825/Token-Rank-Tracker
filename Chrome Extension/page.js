(() => {
  if (window.__findRank) return;
  window.__findRank = true;

  const RANK_KEY = {
    m5: "trendingScoreM5",
    h1: "trendingScoreH1",
    h6: "trendingScoreH6",
    h24: "trendingScoreH24",
  };

  function post(payload) {
    window.postMessage({ source: "find-rank-page", ...payload }, "*");
  }

  function readVarint(buf, offset) {
    let value = 0n;
    let shift = 0n;
    let i = offset;
    while (i < buf.length && shift <= 63n) {
      const byte = BigInt(buf[i]);
      i += 1;
      value |= (byte & 0x7fn) << shift;
      if ((byte & 0x80n) === 0n) {
        const asNumber = value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number(value);
        return { value: asNumber, offset: i };
      }
      shift += 7n;
    }
    throw new Error("truncated varint");
  }

  function readDoubleLE(buf, offset) {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat64(offset, true);
  }

  function readFloatLE(buf, offset) {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat32(offset, true);
  }

  function isText(buf) {
    if (!buf.length) return true;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] < 32) return false;
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buf);
      return true;
    } catch {
      return false;
    }
  }

  function readFields(buf) {
    const fields = [];
    let offset = 0;
    while (offset < buf.length) {
      const tag = readVarint(buf, offset);
      offset = tag.offset;
      const field = tag.value >>> 3;
      const wire = tag.value & 7;
      if (!field) break;
      if (wire === 0) {
        const next = readVarint(buf, offset);
        offset = next.offset;
        fields.push({ field, value: next.value });
      } else if (wire === 1) {
        if (offset + 8 > buf.length) break;
        fields.push({ field, value: readDoubleLE(buf, offset) });
        offset += 8;
      } else if (wire === 5) {
        if (offset + 4 > buf.length) break;
        fields.push({ field, value: readFloatLE(buf, offset) });
        offset += 4;
      } else if (wire === 2) {
        const len = readVarint(buf, offset);
        offset = len.offset;
        if (offset + len.value > buf.length) break;
        const slice = buf.subarray(offset, offset + len.value);
        offset += len.value;
        fields.push({
          field,
          value: isText(slice) ? new TextDecoder("utf-8").decode(slice) : slice,
        });
      } else {
        break;
      }
    }
    return fields;
  }

  function asMessage(entry) {
    if (!entry || !(entry.value instanceof Uint8Array)) return [];
    return readFields(entry.value);
  }

  function firstNumber(fields, field) {
    const entry = fields.find((item) => item.field === field && typeof item.value === "number");
    return entry ? entry.value : null;
  }

  function firstString(fields, field) {
    const entry = fields.find((item) => item.field === field && typeof item.value === "string");
    return entry ? entry.value : null;
  }

  function nestedNumber(fields, field) {
    const direct = firstNumber(fields, field);
    if (direct != null) return direct;
    const inner = asMessage(fields.find((item) => item.field === field));
    if (!inner.length) return null;
    const asText = firstString(inner, 1);
    if (asText != null && asText !== "" && Number.isFinite(Number(asText))) return Number(asText);
    return firstNumber(inner, 1);
  }

  function slotEntry(fields, field, index) {
    return asMessage(fields.find((item) => item.field === field)).find((item) => item.field === index) || null;
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
    return {
      chainId: firstString(fields, 6),
      dex: firstString(fields, 7),
      label: firstString(fields, 8),
      pairAddress: firstString(fields, 9),
      base,
      quote,
      priceUsd: nestedNumber(fields, 13),
      marketCap: nestedNumber(fields, 23) || nestedNumber(fields, 24),
    };
  }

  function parsePayload(buf) {
    const top = readFields(buf);
    const root = top.find((item) => item.field === 1 && item.value instanceof Uint8Array);
    if (!root) return { total: 0, pairs: [] };
    const inner = readFields(root.value);
    const totalField = inner.find((item) => item.field === 3 && typeof item.value === "number");
    const pairs = inner
      .filter((item) => item.field === 2 && item.value instanceof Uint8Array)
      .map((item) => parsePair(item.value))
      .filter(Boolean);
    return { total: totalField ? totalField.value : pairs.length, pairs };
  }

  function normSymbol(value) {
    return String(value || "").trim().replace(/^\$+/, "").replace(/\s+/g, "").toUpperCase();
  }

  function normName(value) {
    return String(value || "").trim().toLowerCase().replace(/\$/g, "").replace(/\s+/g, " ");
  }

  function sameAddress(left, right) {
    const a = String(left || "").trim();
    const b = String(right || "").trim();
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.toLowerCase().startsWith("0x") || b.toLowerCase().startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
    return false;
  }

  function matches(token, wanted) {
    if (!token) return false;
    if (wanted.ca) return sameAddress(token.address, wanted.ca);
    const wantSymbol = normSymbol(wanted.ticker);
    const wantName = normName(wanted.name);
    const symbol = normSymbol(token.symbol);
    const name = normName(token.name);
    if (wantSymbol && wantName) return symbol === wantSymbol && (name === wantName || name.includes(wantName));
    if (wantSymbol) return symbol === wantSymbol;
    if (wantName.length < 3) return name === wantName && wantName.length > 0;
    return name === wantName || name.includes(wantName);
  }

  function matchesPair(pair, wanted) {
    if (!pair?.base) return false;
    if (wanted.pair && !sameAddress(pair.pairAddress, wanted.pair)) return false;
    if (wanted.base && !sameAddress(pair.base.address, wanted.base)) return false;
    if (wanted.pair || wanted.base) {
      if (wanted.ca && !sameAddress(pair.base.address, wanted.ca)) return false;
      return true;
    }
    return matches(pair.base, wanted);
  }

  function reasonFor(wanted) {
    if (wanted.pair) return "Matched pair";
    if (wanted.base) return "Matched base token";
    if (wanted.ca) return "Matched contract";
    if (wanted.ticker && wanted.name) return "Matched name + ticker";
    if (wanted.ticker) return "Matched ticker";
    return "Matched name";
  }

  function socketUrl(chainId, page, timeframe) {
    const tf = RANK_KEY[timeframe] ? timeframe : "h6";
    const query = `rankBy[key]=${RANK_KEY[tf]}&rankBy[order]=desc&filters[chainIds][0]=${encodeURIComponent(chainId)}`;
    return `wss://io.dexscreener.com/dex/screener/v7/pairs/${tf}/${page}?${query}`;
  }

  function pageUrl(chainId, page, timeframe) {
    const rankBy = RANK_KEY[timeframe] || RANK_KEY.h6;
    const path = page <= 1 ? `https://dexscreener.com/${chainId}` : `https://dexscreener.com/${chainId}/page-${page}`;
    return `${path}?order=desc&rankBy=${rankBy}`;
  }

  function pageIsComplete(payload, page) {
    const total = payload?.total || payload?.pairs?.length || 0;
    const pages = Math.max(1, Math.ceil(total / 100));
    const count = payload?.pairs?.length || 0;
    if (!count && total > 0) return false;
    if (page < pages && count !== 100) return false;
    return true;
  }

  function fetchPage(chainId, page, timeframe) {
    const url = socketUrl(chainId, page, timeframe);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error("timeout")), 25000);
      ws.binaryType = "arraybuffer";
      ws.onerror = () => finish(reject, new Error("connection failed"));
      ws.onmessage = (event) => {
        const buf = new Uint8Array(event.data);
        if (buf.length < 500) return;
        try {
          finish(resolve, parsePayload(buf));
        } catch (error) {
          finish(reject, error);
        }
      };
    });
  }

  async function fetchPageRetry(chainId, page, timeframe, alive) {
    let lastError = new Error("no data");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!alive()) throw new Error("aborted");
      try {
        const payload = await fetchPage(chainId, page, timeframe);
        if (pageIsComplete(payload, page)) return payload;
        lastError = new Error("incomplete");
      } catch (error) {
        if (error.message === "aborted") throw error;
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
    throw lastError;
  }

  function findHit(payload, page, wanted) {
    for (let index = 0; index < payload.pairs.length; index += 1) {
      const pair = payload.pairs[index];
      if (!matchesPair(pair, wanted)) continue;
      return { rank: (page - 1) * 100 + index + 1, page, pair };
    }
    return null;
  }

  let generation = 0;
  const feeds = [];
  let lastRank = null;
  let lastPost = 0;

  function stopFeeds() {
    while (feeds.length) {
      try { feeds.pop()(); } catch { /* already closed */ }
    }
  }

  function openFeed(chainId, page, timeframe, onSnapshot, alive) {
    let stopped = false;
    let socket = null;
    let timer = null;
    const connect = () => {
      if (stopped || !alive()) return;
      socket = new WebSocket(socketUrl(chainId, page, timeframe));
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event) => {
        const buf = new Uint8Array(event.data);
        if (buf.length < 500) return;
        try {
          const payload = parsePayload(buf);
          if (pageIsComplete(payload, page)) onSnapshot(payload, page);
        } catch {
          /* wait for the next snapshot */
        }
      };
      socket.onclose = () => {
        if (!stopped && alive()) timer = setTimeout(connect, 800);
      };
    };
    connect();
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* already closed */ }
    };
    feeds.push(stop);
  }

  function publishHit(hit, wanted, chainId, timeframe, total) {
    const now = Date.now();
    if (hit.rank === lastRank && now - lastPost < 2000) return;
    lastRank = hit.rank;
    lastPost = now;
    const pair = hit.pair;
    post({
      type: "rank",
      status: "live",
      rank: hit.rank,
      page: hit.page,
      totalPages: Math.max(1, Math.ceil((total || 0) / 100)),
      symbol: pair.base.symbol,
      name: pair.base.name,
      quote: pair.quote.symbol,
      priceUsd: pair.priceUsd,
      marketCap: pair.marketCap,
      reason: reasonFor(wanted),
      timeframe,
      chainId,
      pairUrl: pair.pairAddress ? `https://dexscreener.com/${chainId}/${pair.pairAddress}` : pageUrl(chainId, hit.page, timeframe),
    });
  }

  function watch(chainId, timeframe, wanted, page, totalPages, id, total) {
    stopFeeds();
    const alive = () => id === generation;
    const pages = [];
    for (let cursor = page - 1; cursor <= page + 1; cursor += 1) {
      if (cursor >= 1 && cursor <= totalPages) pages.push(cursor);
    }
    let misses = 0;
    for (const cursor of pages) {
      openFeed(chainId, cursor, timeframe, (payload, cursorPage) => {
        if (!alive()) return;
        const hit = findHit(payload, cursorPage, wanted);
        if (!hit) {
          if (cursorPage !== page) return;
          misses += 1;
          if (misses >= 2) track(wanted);
          return;
        }
        misses = 0;
        publishHit(hit, wanted, chainId, timeframe, payload.total || total);
      }, alive);
    }
  }

  async function track(wanted) {
    const id = ++generation;
    stopFeeds();
    lastRank = null;
    const alive = () => id === generation;
    const chainId = wanted.chainId || "ethereum";
    const timeframe = RANK_KEY[wanted.timeframe] ? wanted.timeframe : "h6";
    try {
      post({ type: "status", status: "scanning", page: 1, totalPages: 0, timeframe, chainId });
      const first = await fetchPageRetry(chainId, 1, timeframe, alive);
      if (!alive()) return;
      const total = first.total || first.pairs.length;
      const totalPages = Math.min(120, Math.max(1, Math.ceil(total / 100)));
      let hit = findHit(first, 1, wanted);
      if (hit) {
        publishHit(hit, wanted, chainId, timeframe, total);
        watch(chainId, timeframe, wanted, hit.page, totalPages, id, total);
        return;
      }
      for (let page = 2; page <= totalPages; page += 2) {
        if (!alive()) return;
        const batch = [page];
        if (page + 1 <= totalPages) batch.push(page + 1);
        post({ type: "status", status: "scanning", page, totalPages, timeframe, chainId });
        const payloads = await Promise.all(batch.map((cursor) => fetchPageRetry(chainId, cursor, timeframe, alive)));
        if (!alive()) return;
        for (let index = 0; index < batch.length; index += 1) {
          hit = findHit(payloads[index], batch[index], wanted);
          if (!hit) continue;
          publishHit(hit, wanted, chainId, timeframe, payloads[index].total || total);
          watch(chainId, timeframe, wanted, hit.page, totalPages, id, payloads[index].total || total);
          return;
        }
      }
      if (alive()) post({ type: "status", status: "missing", timeframe, chainId });
    } catch (error) {
      if (!alive() || error.message === "aborted") return;
      post({ type: "status", status: "error", error: error.message || "connection failed", timeframe, chainId });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "find-rank-ext") return;
    const message = data.message || {};
    if (message.type === "stop") {
      generation += 1;
      stopFeeds();
      return;
    }
    if (message.type === "ping") {
      post({ type: "pong", status: lastRank ? "live" : "scanning" });
      return;
    }
    if (message.type === "track" && message.query) track(message.query);
  });
})();
