import fs from 'node:fs';

// fetch with a 2-minute timeout so a stuck AI request becomes a clear error instead of hanging forever
const tfetch = async (url, opts) => {
  try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(120000) }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? 'The AI service took too long (over 2 minutes). Please try again.' : 'Could not reach the AI service: ' + e.message); }
};

// ---- Speech-to-text: OpenAI Whisper (Korean, segment timestamps) ----
async function whisper(audioPath) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set on the server.');
  const form = new FormData();
  form.append('file', await fs.openAsBlob(audioPath), 'audio.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  const r = await tfetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  if (!r.ok) throw new Error(`Speech recognition failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  return (data.segments || [])
    .filter((s) => s.text.trim() && (s.no_speech_prob ?? 0) < 0.7)
    .map((s) => ({ start: s.start, end: s.end, ko: s.text.trim() }));
}

// Uses Whisper if OPENAI_API_KEY is set, otherwise Gemini (free tier) hears the audio directly.
export async function transcribeKorean(audioPath) {
  return process.env.OPENAI_API_KEY ? whisper(audioPath) : geminiTranscribe(audioPath);
}

const toSec = (v) => {
  if (typeof v === 'number') return v;
  const p = String(v).split(':').map(Number);
  return p.some(Number.isNaN) ? NaN : p.reduce((a, x) => a * 60 + x, 0);
};

async function geminiTranscribe(audioPath) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server.');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const prompt = `Listen to this audio from a video clip. Detect the spoken language automatically and transcribe every spoken line exactly, in its original language and script.
Return ONLY a JSON array: [{"start":number,"end":number,"ko":string}] where start/end are decimal seconds from the very beginning of the audio.
Each item is one short phrase or sentence (about 1-6 seconds). Keep items in order, with no overlaps. Ignore music, sound effects and silence. If there is no speech return [].`;
  const r = await tfetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: 'audio/mp3', data: fs.readFileSync(audioPath).toString('base64') } }, { text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  if (!r.ok) throw new Error(`Speech recognition failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  let arr;
  try { arr = JSON.parse(j.candidates[0].content.parts[0].text); }
  catch { throw new Error('Speech recognition returned an unreadable response. Please try again.'); }
  return arr
    .map((x) => ({ start: toSec(x.start), end: toSec(x.end), ko: String(x.ko || '').trim() }))
    .filter((x) => x.ko && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start);
}

// ---- Translation + speaker guess: Gemini ----
export async function translateSegments(segs, target = 'Sinhala') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server.');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const prompt = `You are a professional subtitle translator. Translate each numbered line (the source language may be any language; detect it) into natural, conversational spoken ${target}, written in ${target}'s native script, the way native viewers would actually say it.
Rules: keep meaning, emotion and tone (anger, sarcasm, tenderness); no literal word-for-word output; keep lines short;
write names the way ${target} speakers would; if a line is already in ${target}, keep it as is; treat the lines as one continuous conversation for context.
Also guess the speaker for each line as "A", "B", "C"... based on conversational turns, or null if unsure.
Return ONLY a JSON array: [{"i":number,"si":string,"speaker":string|null}] with exactly one item per input line.

INPUT:
${JSON.stringify(segs.map((s, i) => ({ i, ko: s.ko })))}`;
  const r = await tfetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    }),
  });
  if (!r.ok) throw new Error(`Translation failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  let arr;
  try { arr = JSON.parse(j.candidates[0].content.parts[0].text); }
  catch { throw new Error('Translation returned an unreadable response. Please try again.'); }
  const map = new Map(arr.map((x) => [x.i, x]));
  return segs.map((s, i) => ({ ...s, si: String(map.get(i)?.si || '').trim(), speaker: map.get(i)?.speaker || null }));
}

// ---- Split into short TikTok-sized captions, no overlaps ----
export function buildCaptions(segs, maxChars = 28) {
  const out = [];
  for (const s of segs) {
    if (!s.si) continue;
    const words = s.si.split(/\s+/);
    const chunks = []; let cur = '';
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > maxChars) { chunks.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) chunks.push(cur);
    const total = chunks.reduce((a, c) => a + c.length, 0);
    let t = s.start;
    for (const c of chunks) {
      const end = t + ((s.end - s.start) * c.length) / total;
      out.push({ start: +t.toFixed(2), end: +end.toFixed(2), text: c, speaker: s.speaker, ko: s.ko });
      t = end;
    }
  }
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length - 1; i++) out[i].end = Math.min(out[i].end, +(out[i + 1].start - 0.02).toFixed(2));
  return out.filter((c) => c.end > c.start).map((c, i) => ({ id: i + 1, ...c }));
}
