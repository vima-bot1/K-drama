import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transcribeKorean, translateToSinhala, buildCaptions } from './ai.js';
import { buildAss } from './ass.js';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const FONT = path.join(ROOT, 'fonts', 'NotoSansSinhala-Bold.ttf');
const MAX_MB = +process.env.MAX_UPLOAD_MB || 300;
const MAX_DUR = +process.env.MAX_DURATION_SEC || 300;
const MAX_EXPORTS = 2;
fs.mkdirSync(DATA, { recursive: true });

const jobs = new Map();
let activeExports = 0;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, f, cb) => { req.jobId = randomUUID(); const d = path.join(DATA, req.jobId); fs.mkdirSync(d); cb(null, d); },
    filename: (req, f, cb) => cb(null, 'input' + path.extname(f.originalname).toLowerCase()),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, f, cb) => (['.mp4', '.mov'].includes(path.extname(f.originalname).toLowerCase())
    ? cb(null, true) : cb(Object.assign(new Error('Only MP4 and MOV files are supported.'), { status: 400 }))),
});

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  if (!v) throw Object.assign(new Error('This file has no video stream.'), { status: 400 });
  let rot = Math.abs(+(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180;
  const [w, h] = rot ? [v.height, v.width] : [v.width, v.height];
  return { duration: +j.format.duration, width: w, height: h, hasAudio: j.streams.some((s) => s.codec_type === 'audio') };
}

const rm = (id) => { fs.rmSync(path.join(DATA, id), { recursive: true, force: true }); jobs.delete(id); };
const getJob = (req, res) => { const j = jobs.get(req.params.id); if (!j) res.status(404).json({ error: 'Video not found or expired. Please upload again.' }); return j; };
const pub = (j) => ({ id: j.id, stage: j.stage, error: j.error, captions: j.captions, exportState: j.exp });

app.get('/api/health', async (req, res) => {
  let ffmpeg = true;
  try { await run('ffmpeg', ['-version']); } catch { ffmpeg = false; }
  res.json({ ffmpeg, font: fs.existsSync(FONT), openai: !!process.env.OPENAI_API_KEY, gemini: !!process.env.GEMINI_API_KEY, maxUploadMB: MAX_MB, maxDuration: MAX_DUR });
});

app.post('/api/upload', upload.single('video'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video received.' });
    let info;
    try { info = await probe(req.file.path); } catch (e) { rm(req.jobId); return res.status(400).json({ error: e.status ? e.message : 'This file could not be read as a video.' }); }
    if (!info.hasAudio) { rm(req.jobId); return res.status(400).json({ error: 'This video has no audio track to transcribe.' }); }
    if (info.duration > MAX_DUR) { rm(req.jobId); return res.status(400).json({ error: `Video is too long. Maximum is ${MAX_DUR} seconds.` }); }
    jobs.set(req.jobId, { id: req.jobId, file: req.file.path, created: Date.now(), ...info, stage: 'uploaded', captions: null, exp: { state: 'idle' } });
    res.json({ id: req.jobId, name: req.file.originalname, size: req.file.size, ...info });
  } catch (e) { next(e); }
});

app.get('/api/video/:id', (req, res) => {
  const j = getJob(req, res); if (!j) return;
  res.sendFile(j.file, { headers: { 'Content-Type': 'video/mp4' } });
});

app.post('/api/jobs/:id/transcribe', (req, res) => {
  const j = getJob(req, res); if (!j) return;
  if (['extracting', 'transcribing', 'translating'].includes(j.stage)) return res.status(409).json({ error: 'Already processing.' });
  j.error = null; j.stage = 'extracting';
  res.status(202).json(pub(j));
  (async () => {
    try {
      const audio = path.join(path.dirname(j.file), 'audio.mp3');
      await run('ffmpeg', ['-y', '-i', j.file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', audio]);
      j.stage = 'transcribing';
      const segs = await transcribeKorean(audio);
      if (!segs.length) throw new Error('No Korean speech was detected in this video.');
      j.stage = 'translating';
      j.captions = buildCaptions(await translateToSinhala(segs));
      j.stage = 'done';
    } catch (e) { j.stage = 'error'; j.error = e.message; }
  })();
});

app.get('/api/jobs/:id', (req, res) => { const j = getJob(req, res); if (j) res.json(pub(j)); });

const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

app.post('/api/jobs/:id/export', (req, res) => {
  const j = getJob(req, res); if (!j) return;
  const { captions, style = {}, height } = req.body || {};
  if (!Array.isArray(captions) || !captions.length || captions.length > 600) return res.status(400).json({ error: 'Add at least one caption before exporting.' });
  const caps = captions.map((c) => ({ start: num(c.start, 0, j.duration, 0), end: num(c.end, 0, j.duration, 0), text: String(c.text || '').slice(0, 300) }));
  const st = { fontSize: num(style.fontSize, 2, 12, 5.5), bottom: num(style.bottom, 0, 80, 18), background: !!style.background, shadow: !!style.shadow, highlight: !!style.highlight };
  if (activeExports >= MAX_EXPORTS || j.exp.state === 'rendering') return res.status(429).json({ error: 'The server is busy rendering. Try again in a minute.' });
  const target = +height === 1080 ? 1080 : 720;
  const portrait = j.height >= j.width;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const W = portrait ? target : even((j.width * target) / j.height);
  const H = portrait ? even((j.height * target) / j.width) : target;
  const dir = path.join(DATA, j.id);
  fs.writeFileSync(path.join(dir, 'captions.ass'), buildAss(caps, st, W, H));
  const out = path.join(dir, 'output.mp4');
  j.exp = { state: 'rendering', progress: 0 };
  activeExports++;
  res.status(202).json(pub(j));
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  const vf = `scale=${W}:${H}:flags=lanczos,ass=${rel(path.join(dir, 'captions.ass'))}:fontsdir=fonts`;
  const ff = spawn('ffmpeg', ['-y', '-i', j.file, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out], { cwd: ROOT });
  let tail = '';
  ff.stdout.on('data', (d) => { const m = /out_time_us=(\d+)/g; let x, last; while ((x = m.exec(d))) last = +x[1]; if (last) j.exp.progress = Math.min(0.99, last / 1e6 / j.duration); });
  ff.stderr.on('data', (d) => { tail = (tail + d).slice(-600); });
  ff.on('close', (code) => {
    activeExports--;
    j.exp = code === 0 ? { state: 'done', progress: 1, size: fs.statSync(out).size } : { state: 'error', error: 'Rendering failed. ' + tail.split('\n').slice(-2).join(' ') };
  });
});

app.get('/api/jobs/:id/download', (req, res) => {
  const j = getJob(req, res); if (!j) return;
  if (j.exp.state !== 'done') return res.status(409).json({ error: 'Export is not finished.' });
  res.download(path.join(DATA, j.id, 'output.mp4'), 'k-drama-sinhala.mp4');
});

app.delete('/api/jobs/:id', (req, res) => { rm(req.params.id); res.json({ ok: true }); });

// Serve built frontend in production
const dist = path.join(ROOT, '..', 'client', 'dist');
if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html'))); }

app.use((err, req, res, next) => {
  if (req.jobId) rm(req.jobId);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File is too large. Maximum is ${MAX_MB} MB.` });
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Unexpected server error.' });
});

// Delete anything older than 3 hours (also sweeps leftovers after restarts)
setInterval(() => {
  for (const d of fs.readdirSync(DATA)) {
    const p = path.join(DATA, d);
    if (Date.now() - fs.statSync(p).mtimeMs > 3 * 3600e3 && jobs.get(d)?.exp.state !== 'rendering') rm(d);
  }
}, 15 * 60e3).unref();

app.listen(process.env.PORT || 3000, () => console.log('K-DRAMA AI CAPTION on :' + (process.env.PORT || 3000)));
