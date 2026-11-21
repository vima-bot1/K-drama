import fs from 'node:fs';
const base = 'https://github.com/notofonts/notofonts.github.io/raw/main/fonts/';
const list = ['NotoSansSinhala', 'NotoSans', 'NotoSansTamil', 'NotoSansDevanagari'];
let failed = false;
for (const n of list) {
  const out = new URL(`../fonts/${n}-Bold.ttf`, import.meta.url);
  if (fs.existsSync(out)) continue;
  const r = await fetch(`${base}${n}/hinted/ttf/${n}-Bold.ttf`);
  if (!r.ok) { console.error('Font download failed:', n, r.status); failed = true; continue; }
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  console.log('Saved', n);
}
process.exit(failed ? 1 : 0);
