// Orchestrates one refresh: DefiLlama totals -> CoinGecko caps -> GeckoTerminal pools -> classify.
// Usage: node pipeline/run.mjs (complete refresh only).
const args = process.argv.slice(2);
if (args.length) throw new Error('A validated refresh requires every chain. Run without flags; use individual fetch/classify modules for cache maintenance in a separate data directory.');
process.env.REFRESH_STARTED_AT ||= new Date().toISOString();
process.env.REFRESH_CUTOFF ||= process.env.REFRESH_STARTED_AT.slice(0, 10);
const { refreshCutoff } = await import('./lib/run_context.mjs');
refreshCutoff(); // Reject malformed cutoffs before any network requests or file writes.
const { writeJson, getHttpMetrics } = await import('./lib/http.mjs');
const { coinGeckoConfig } = await import('./lib/coingecko.mjs');
const t0 = Date.now();
const metrics = { started_at: new Date(t0).toISOString(), cutoff_utc: process.env.REFRESH_CUTOFF,
  provider_tier: coinGeckoConfig().tier, status: 'running', steps: [] };
const saveMetrics = () => writeJson('logs/refresh-metrics.json', {
  ...metrics, elapsed_seconds: (Date.now() - t0) / 1000, http: getHttpMetrics(),
}, true);
const step = async (name, fn) => {
  console.log(`\n== ${name} ==`);
  const started = Date.now(), result = { name, started_at: new Date(started).toISOString(), status: 'running' };
  metrics.steps.push(result); saveMetrics();
  try { await fn(); result.status = 'completed'; }
  catch (error) { result.status = 'failed'; throw error; }
  finally { result.elapsed_seconds = (Date.now() - started) / 1000; saveMetrics(); }
  console.log(`   (${Math.round((Date.now() - t0) / 1000)}s elapsed)`);
};
try {
  await step('defillama', async () => (await import('./fetch_defillama.mjs')).main());
  await step('coingecko', async () => (await import('./fetch_coingecko.mjs')).main());
  await step('geckoterminal', async () => (await import('./fetch_geckoterminal.mjs')).main());
  await step('enrich', async () => (await import('./enrich_mcap.mjs')).main());
  // Re-fetch reference totals to include late adapter updates during collection.
  await step('final defillama totals', async () => (await import('./fetch_defillama.mjs')).main({ force: true }));
  await step('classify', async () => (await import('./classify.mjs')).main());
  await step('validate', async () => (await import('./validate.mjs')).main());
  await step('snapshot', async () => { await import('./snapshot.mjs'); });
  metrics.status = 'completed';
} catch (error) {
  metrics.status = 'failed';
  metrics.error = { name: error.name, message: error.message };
  throw error;
} finally {
  metrics.finished_at = new Date().toISOString(); saveMetrics();
}
