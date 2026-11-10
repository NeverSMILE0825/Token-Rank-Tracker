const { matches } = require("../lib/match");
const { fetchPage } = require("../lib/screener");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const gta = { name: "Grand Theft Anakin", symbol: "GTA", address: "0xa7362118A42Ad52C68A694972b308cFB02E94CD2" };
const lookalike = { name: "GTA VI", symbol: "GTA6", address: "0x1111111111111111111111111111111111111111" };

assert(matches(gta, { name: "Grand Theft Anakin", ticker: "$GTA", ca: "" }), "name and ticker");
assert(!matches(lookalike, { name: "Grand Theft Anakin", ticker: "GTA", ca: "" }), "lookalike ticker");
assert(matches(gta, { name: "", ticker: "", ca: "0xA7362118A42Ad52C68A694972b308cFB02E94CD2" }), "checksum address");
assert(!matches(gta, { name: "", ticker: "", ca: "So11111111111111111111111111111111111111112" }), "different address");

fetchPage("ethereum", 1, "h24")
  .then((page) => {
    assert(page.pairs.length === 100, `expected 100 pairs, got ${page.pairs.length}`);
    const first = page.pairs[0];
    assert(first.base.symbol && first.base.name, "missing base token");
    assert(Number.isFinite(first.priceUsd), "missing price");
    assert(Number.isFinite(first.liquidityUsd), "missing liquidity");
    assert(first.pairAddress, "missing pair address");
    console.log(
      JSON.stringify(
        {
          total: page.total,
          pairs: page.pairs.length,
          top: page.pairs.slice(0, 3).map((pair) => ({
            pair: `${pair.base.symbol}/${pair.quote.symbol}`,
            name: pair.base.name,
            price: pair.priceUsd,
            liquidity: pair.liquidityUsd,
            marketCap: pair.marketCap,
            changeH24: pair.changeH24,
            volumeH24: pair.volumeH24,
            txnsH24: pair.txnsH24,
            tradersH24: pair.tradersH24,
            dex: pair.dex,
          })),
        },
        null,
        2
      )
    );
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
