// Orchestrates one refresh: DefiLlama totals -> CoinGecko caps -> GeckoTerminal pools -> classify.
// Usage: node pipeline/run.mjs [--skip-gt] [--only=ethereum,base]
const args = process.argv.slice(2);
const skipGt = args.includes('--skip-gt');
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',') || null;
const t0 = Date.now();
const step = async (name, fn) => { console.log(`\n== ${name} ==`); await fn(); console.log(`   (${Math.round((Date.now() - t0) / 1000)}s elapsed)`); };
await step('defillama', async () => (await import('./fetch_defillama.mjs')).main());
await step('coingecko', async () => (await import('./fetch_coingecko.mjs')).main());
if (!skipGt) await step('geckoterminal', async () => (await import('./fetch_geckoterminal.mjs')).main(only));
await step('enrich', async () => (await import('./enrich_mcap.mjs')).main());
await step('classify', async () => (await import('./classify.mjs')).main());
await step('snapshot', async () => { await import('./snapshot.mjs'); });
