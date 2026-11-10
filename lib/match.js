function normSymbol(value) {
  return String(value || "")
    .trim()
    .replace(/^\$+/, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/\s+/g, " ");
}

function sameAddress(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.toLowerCase().startsWith("0x") || b.toLowerCase().startsWith("0x")) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

function matches(token, query) {
  if (!token) return false;
  if (query.ca) return sameAddress(token.address, query.ca);
  const wantSymbol = normSymbol(query.ticker);
  const wantName = normName(query.name);
  const symbol = normSymbol(token.symbol);
  const name = normName(token.name);
  if (wantSymbol && wantName) {
    return symbol === wantSymbol && (name === wantName || name.includes(wantName));
  }
  if (wantSymbol) return symbol === wantSymbol;
  if (wantName.length < 3) return name === wantName && wantName.length > 0;
  return name === wantName || name.includes(wantName);
}

function matchReason(query) {
  if (query.ca) return "contract";
  if (query.ticker && query.name) return "name+ticker";
  if (query.ticker) return "ticker";
  return "name";
}

module.exports = { matches, matchReason, normName, normSymbol };
