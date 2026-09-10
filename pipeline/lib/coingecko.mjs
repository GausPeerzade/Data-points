const PUBLIC_BASE = 'https://api.coingecko.com/api/v3';
const PRO_BASE = 'https://pro-api.coingecko.com/api/v3';
const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';

function apiKey(env, name) {
  const value = env[name];
  if (value == null) return '';
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const key = value.trim();
  // Accept accidental surrounding whitespace without passing malformed headers
  // or printing a credential in an error message.
  if (/\s/.test(key)) throw new Error(`${name} must not contain whitespace`);
  return key;
}

export function coinGeckoConfig(env = process.env) {
  const proKey = apiKey(env, 'COINGECKO_PRO_API_KEY');
  const demoKey = proKey ? '' : apiKey(env, 'COINGECKO_DEMO_KEY');
  const tier = proKey ? 'pro' : demoKey ? 'demo' : 'public';
  const headers = proKey ? { 'x-cg-pro-api-key': proKey } : demoKey ? { 'x-cg-demo-api-key': demoKey } : {};
  const baseUrl = proKey ? PRO_BASE : PUBLIC_BASE;
  return {
    tier,
    baseUrl,
    onchainBaseUrl: proKey ? `${PRO_BASE}/onchain` : GECKOTERMINAL_BASE,
    marketOptions: { headers, minIntervalMs: proKey ? 250 : demoKey ? 700 : 21000, adaptiveRateLimit: !!proKey },
    onchainOptions: {
      // Public GeckoTerminal requests must never receive CoinGecko credentials.
      headers: proKey ? { 'x-cg-pro-api-key': proKey } : {},
      minIntervalMs: proKey ? 250 : 3300,
      adaptiveRateLimit: true,
      ttlMs: 12 * 3600e3,
    },
    concurrency: proKey ? 6 : 1,
  };
}
