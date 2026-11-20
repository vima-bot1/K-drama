import fs from 'node:fs';
const url = 'https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSansSinhala/hinted/ttf/NotoSansSinhala-Bold.ttf';
const out = new URL('../fonts/NotoSansSinhala-Bold.ttf', import.meta.url);
if (fs.existsSync(out)) { console.log('Font already present'); process.exit(0); }
const r = await fetch(url);
if (!r.ok) { console.error('Font download failed:', r.status, '- download NotoSansSinhala-Bold.ttf manually into server/fonts/'); process.exit(1); }
fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
console.log('Saved Noto Sans Sinhala Bold');
