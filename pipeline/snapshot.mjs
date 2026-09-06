// Writes data/snapshot.html: the dashboard with data/latest.json inlined, so it opens from a file or an email attachment.
import fs from 'node:fs';
const html = fs.readFileSync('index.html', 'utf8');
const data = fs.readFileSync('data/latest.json', 'utf8').replace(/<\/script/gi, '<\\/script');
// injected inside the main script (single script tag) so restrictive viewers that keep only one script still work
const out = html.replace('<script>\n(() => {', `<script>\n(() => {\n  window.__INLINE_DATA__ = ${data};`);
if (out === html) throw new Error('could not find the main script tag in index.html');
fs.writeFileSync('data/snapshot.html', out);
console.log(`wrote data/snapshot.html (${Math.round(out.length / 1024)} KB)`);
