// Chain registry, classification threshold and the quote-token set (see ARCHITECTURE.md §3.2).
export const THRESHOLD_USD = 100_000_000;
export const DAYS = 61;                 // closed UTC days kept (60 needed for the 30d-over-30d change)
export const BOUNDARY = [50_000_000, 200_000_000]; // sensitivity band around the threshold

export const CHAINS = [
  { key: 'ethereum',  display: 'Ethereum',        llama: 'Ethereum',       cg: 'ethereum',            gt: 'eth',       dune: 'ethereum',  evm: true },
  { key: 'solana',    display: 'Solana',          llama: 'Solana',         cg: 'solana',              gt: 'solana',    dune: 'solana',    evm: false },
  { key: 'base',      display: 'Base',            llama: 'Base',           cg: 'base',                gt: 'base',      dune: 'base',      evm: true },
  { key: 'bnb',       display: 'BNB Chain',       llama: 'BSC',            cg: 'binance-smart-chain', gt: 'bsc',       dune: 'bnb',       evm: true },
  { key: 'arbitrum',  display: 'Arbitrum',        llama: 'Arbitrum',       cg: 'arbitrum-one',        gt: 'arbitrum',  dune: 'arbitrum',  evm: true },
  { key: 'hyperevm',  display: 'HyperEVM',        llama: 'Hyperliquid L1', cg: 'hyperevm',            gt: 'hyperevm',  dune: 'hyperevm',  evm: true,
    // DefiLlama's "Hyperliquid L1" mixes HyperEVM AMMs with the HyperCore orderbook and double counts "Unit".
    llamaFilter: { category: ['Dexs'], excludeProtocols: ['Hyperliquid Spot Orderbook'] },
    extraSeries: { hypercore_spot_orderbook: ['Hyperliquid Spot Orderbook'] } },
  { key: 'robinhood', display: 'Robinhood Chain', llama: 'Robinhood Chain', cg: 'robinhood',          gt: 'robinhood', dune: 'robinhood', evm: true },
];

// Native / wrapped-native / LST / BTC-wrapper CoinGecko ids. Always part of the quote set Q.
export const NATIVE_IDS = new Set([
  'bitcoin', 'wrapped-bitcoin', 'coinbase-wrapped-btc', 'tbtc', 'unit-bitcoin',
  'ethereum', 'weth', 'staked-ether', 'wrapped-steth', 'wrapped-eeth', 'coinbase-wrapped-staked-eth', 'rocket-pool-eth', 'unit-ethereum',
  'solana', 'wrapped-solana', 'jito-staked-sol', 'msol', 'blazestake-staked-sol', 'binance-staked-sol', 'unit-solana',
  'binancecoin', 'wbnb',
  'hyperliquid', 'wrapped-hype', 'kinetic-staked-hype', 'staked-hype', 'staked-hype-shares', 'looped-hype',
]);

// Wrapped / bridged representation -> underlying asset whose market cap should be used.
export const UNDERLYING = {
  'weth': 'ethereum', 'unit-ethereum': 'ethereum', 'wrapped-steth': 'ethereum', 'staked-ether': 'ethereum',
  'wrapped-eeth': 'ethereum', 'coinbase-wrapped-staked-eth': 'ethereum', 'rocket-pool-eth': 'ethereum',
  'wrapped-bitcoin': 'bitcoin', 'coinbase-wrapped-btc': 'bitcoin', 'tbtc': 'bitcoin', 'unit-bitcoin': 'bitcoin',
  'wrapped-solana': 'solana', 'unit-solana': 'solana', 'jito-staked-sol': 'solana', 'msol': 'solana',
  'blazestake-staked-sol': 'solana', 'binance-staked-sol': 'solana',
  'wbnb': 'binancecoin',
  'usdt0': 'tether', 'unit-pump': 'pump-fun', 'ethereum-wormhole': 'ethereum', 'wrapped-bitcoin-wormhole': 'bitcoin',
  // chain-specific bridged listings that CoinGecko lists without market data
  'arbitrum-bridged-wbtc-arbitrum-one': 'bitcoin', 'arbitrum-bridged-wsteth-arbitrum': 'ethereum', 'usd-coin-ethereum-bridged': 'usd-coin',
  'makerdao-arbitrum-bridged-dai-arbitrum-one': 'dai', 'robinhood-wrapped-eth-robinhood-chain': 'ethereum', 'bridged-usdt': 'tether',
  'bridged-usd-coin-base': 'usd-coin', 'binance-bridged-usdt-bnb-smart-chain': 'tether', 'binance-bridged-usdc-bnb-smart-chain': 'usd-coin',
  'binance-bitcoin': 'bitcoin', 'binance-peg-weth': 'ethereum', 'arbitrum-bridged-usdt-arbitrum': 'tether', 'arbitrum-bridged-weth-arbitrum-one': 'ethereum',
  'wrapped-hype': 'hyperliquid', 'kinetic-staked-hype': 'hyperliquid', 'staked-hype': 'hyperliquid',
  'staked-hype-shares': 'hyperliquid', 'looped-hype': 'hyperliquid',
};

// Safety net: canonical wrapped-native addresses per chain (in case CoinGecko's platform map misses one).
export const MANUAL_ADDRESSES = {
  ethereum:  { '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'weth' },
  base:      { '0x4200000000000000000000000000000000000006': 'weth' },
  arbitrum:  { '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'weth' },
  bnb:       { '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'wbnb' },
  solana:    { 'So11111111111111111111111111111111111111112': 'wrapped-solana' },
  hyperevm:  { '0x5555555555555555555555555555555555555555': 'wrapped-hype',
               // Ring Protocol "few-wrapped" (fw*) tokens: 1:1 wrappers used by ring-exchange pools; not on CoinGecko
               '0x9e1148bc3665a9f7c35f313d89c0432c34928aef': 'wrapped-hype',   // fwWHYPE
               '0x0c47cbbede5d8c6f9614cf770c26c3315205c397': 'unit-ethereum' }, // fwUETH
  robinhood: { '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'weth' },
};

// Symbol -> major asset, applied ONLY to (a) CoinGecko ids that are chain-specific bridged/wrapped listings
// (e.g. 'arbitrum-bridged-wbtc-arbitrum-one', 'usd-coin-ethereum-bridged', 'robinhood-wrapped-eth-robinhood-chain')
// and (b) native-asset placeholder addresses. Never applied to unlisted tokens (symbol spoofing).
export const BRIDGED_ID_PATTERN = /bridged|wrapped|wormhole|-robinhood-chain$|-arbitrum-one$|-base$|-bsc$|-solana$/;
export const SYMBOL_TO_MAJOR = {
  weth: 'ethereum', eth: 'ethereum', wsteth: 'ethereum', steth: 'ethereum', weeth: 'ethereum', cbeth: 'ethereum', reth: 'ethereum',
  wbtc: 'bitcoin', cbbtc: 'bitcoin', tbtc: 'bitcoin', btcb: 'bitcoin',
  usdc: 'usd-coin', 'usdc.e': 'usd-coin', usdbc: 'usd-coin', usdt: 'tether', 'usdt.e': 'tether', usdt0: 'tether', dai: 'dai', 'dai.e': 'dai',
  wbnb: 'binancecoin', bnb: 'binancecoin', sol: 'solana', wsol: 'solana', whype: 'hyperliquid', hype: 'hyperliquid',
};
// Native-asset placeholder addresses used by GeckoTerminal for ETH/BNB/HYPE pools (Uniswap v4 etc.)
export const NATIVE_PLACEHOLDERS = ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0x0000000000000000000000000000000000000000'];
export const NATIVE_COIN = { ethereum: 'ethereum', base: 'ethereum', arbitrum: 'ethereum', robinhood: 'ethereum', bnb: 'binancecoin', hyperevm: 'hyperliquid', solana: 'solana' };

export const normAddr = (chain, a) => (chain.evm ? String(a).trim().toLowerCase() : String(a).trim());

// GeckoTerminal sampling: pools below this 24h volume are not fetched for daily history.
export const MIN_POOL_VOL_TOP = 50_000;
export const MIN_POOL_VOL_WHITELIST = 25_000;
export const MAX_POOLS_PER_TOKEN = 10;
export const MIN_TOKEN_VOL_WHITELIST = 250_000; // whitelist tokens below this 24h volume skip the pool lookup   // token pool lists are volume-sorted; ranks 11-20 are negligible
export const TOP_POOL_PAGES = 10;
