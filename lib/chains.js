const { chains: CHAINS } = require("../docs/chains.json");

const BY_ID = new Map(CHAINS.map((chain) => [chain.id, chain]));

module.exports = { CHAINS, BY_ID };
