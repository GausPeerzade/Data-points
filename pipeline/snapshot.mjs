// Writes data/snapshot.html: the dashboard with data/latest.json inlined, so it opens from a file or an email attachment.
import fs from 'node:fs';
const html = fs.readFileSync('index.html', 'utf8');
const data = fs.readFileSync('data/latest.json', 'utf8').replace(/<\/script/gi, '<\\/script');
// Keep the CSV download usable when the snapshot is opened without the repository beside it.
const csv = fs.readFileSync('data/volume_daily.csv').toString('base64');
// injected inside the main script (single script tag) so restrictive viewers that keep only one script still work
const inlined = html.replace('<script>\n(() => {', `<script>\n(() => {\n  window.__INLINE_DATA__ = ${data};`);
if (inlined === html) throw new Error('could not find the main script tag in index.html');
const out = inlined
  .replace(/assets\/chains\/[a-z-]+\.(svg|jpg)/g, (file, ext) =>
    `data:${ext === 'svg' ? 'image/svg+xml' : 'image/jpeg'};base64,${fs.readFileSync(file).toString('base64')}`)
  .replace('href="data/volume_daily.csv"', `href="data:text/csv;base64,${csv}"`)
  .replace('href="assets/brand/favicon.ico"', `href="data:image/x-icon;base64,${fs.readFileSync('assets/brand/favicon.ico').toString('base64')}"`)
  .replace(/url\("(assets\/brand\/[^"/]+\.otf)"\)/g, (_, file) =>
    `url("data:font/otf;base64,${fs.readFileSync(file).toString('base64')}")`);
fs.writeFileSync('data/snapshot.html', out);
console.log(`wrote data/snapshot.html (${Math.round(out.length / 1024)} KB)`);
