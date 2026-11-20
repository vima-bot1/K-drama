import { useEffect, useRef, useState } from 'react';

const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};
const STAGES = [['extracting', 'Extracting audio'], ['transcribing', 'Recognising Korean speech'], ['translating', 'Translating to Sinhala']];

function Word({ text, active, hl }) { return <span style={hl && active ? { color: '#FFE600' } : undefined}>{text} </span>; }

function Preview({ videoRef, captions, style, t }) {
  const [h, setH] = useState(0);
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const ro = new ResizeObserver(() => setH(v.clientHeight)); ro.observe(v); return () => ro.disconnect();
  }, [videoRef]);
  const cap = captions.find((c) => t >= c.start && t < c.end);
  let words = [], idx = -1;
  if (cap) {
    words = cap.text.trim().split(/\s+/);
    const total = words.reduce((a, w) => a + w.length, 0);
    const p = ((t - cap.start) / (cap.end - cap.start)) * total; let acc = 0;
    idx = words.findIndex((w) => (acc += w.length) > p);
  }
  const fs = (style.fontSize / 100) * h;
  return cap ? (
    <div className="pointer-events-none absolute inset-x-0 flex justify-center px-[6%]" style={{ bottom: `${style.bottom}%` }}>
      <div className="text-center font-extrabold leading-tight" style={{
        fontSize: fs, color: '#fff', padding: style.background ? `${fs * 0.1}px ${fs * 0.3}px` : 0,
        background: style.background ? 'rgba(0,0,0,.6)' : 'none', borderRadius: fs * 0.2,
        WebkitTextStroke: style.background ? '0' : `${Math.max(2, fs * 0.16)}px #000`, paintOrder: 'stroke fill',
        textShadow: style.shadow ? `0 ${fs * 0.08}px ${fs * 0.15}px rgba(0,0,0,.9)` : 'none',
      }}>
        {words.map((w, i) => <Word key={i} text={w} active={i === idx} hl={style.highlight} />)}
      </div>
    </div>
  ) : null;
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [step, setStep] = useState('upload');
  const [file, setFile] = useState(null);
  const [info, setInfo] = useState(null);
  const [upPct, setUpPct] = useState(null);
  const [error, setError] = useState('');
  const [stage, setStage] = useState(null);
  const [captions, setCaptions] = useState([]);
  const [style, setStyle] = useState({ fontSize: 5.5, bottom: 18, background: false, shadow: true, highlight: true });
  const [height, setHeight] = useState(720);
  const [exp, setExp] = useState({ state: 'idle' });
  const [t, setT] = useState(0);
  const videoRef = useRef(null);
  const [localUrl, setLocalUrl] = useState(null);

  useEffect(() => { api('/api/health').then(setHealth).catch(() => setError('Cannot reach the server.')); }, []);
  useEffect(() => {
    let raf; const tick = () => { if (videoRef.current) setT(videoRef.current.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, []);

  const missing = health && [!health.ffmpeg && 'FFmpeg', !health.font && 'Sinhala font (npm run setup)', !health.openai && 'OPENAI_API_KEY', !health.gemini && 'GEMINI_API_KEY'].filter(Boolean);

  function pick(f) {
    setError('');
    if (!f) return;
    if (!/\.(mp4|mov)$/i.test(f.name)) return setError('Only MP4 and MOV files are supported.');
    if (health && f.size > health.maxUploadMB * 1048576) return setError(`File is too large. Maximum is ${health.maxUploadMB} MB.`);
    setFile(f); setLocalUrl(URL.createObjectURL(f));
  }

  function upload() {
    setError(''); setUpPct(0);
    const fd = new FormData(); fd.append('video', file);
    const x = new XMLHttpRequest();
    x.open('POST', '/api/upload');
    x.upload.onprogress = (e) => e.lengthComputable && setUpPct(Math.round((e.loaded / e.total) * 100));
    x.onerror = () => { setUpPct(null); setError('Upload failed. Check your connection.'); };
    x.onload = () => {
      setUpPct(null);
      const j = JSON.parse(x.responseText || '{}');
      if (x.status !== 200) return setError(j.error || 'Upload failed.');
      setInfo(j); startProcessing(j.id);
    };
    x.send(fd);
  }

  async function startProcessing(id) {
    setStep('processing'); setStage('extracting');
    try {
      await api(`/api/jobs/${id}/transcribe`, { method: 'POST' });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const j = await api(`/api/jobs/${id}`);
        setStage(j.stage);
        if (j.stage === 'error') throw new Error(j.error);
        if (j.stage === 'done') { setCaptions(j.captions); setStep('edit'); return; }
      }
    } catch (e) { setError(e.message); setStep('upload'); }
  }

  async function doExport() {
    setError(''); setExp({ state: 'rendering', progress: 0 });
    try {
      await api(`/api/jobs/${info.id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captions, style, height }) });
      for (;;) {
        await new Promise((r) => setTimeout(r, 800));
        const j = await api(`/api/jobs/${info.id}`);
        setExp(j.exportState);
        if (j.exportState.state === 'error') throw new Error(j.exportState.error);
        if (j.exportState.state === 'done') return;
      }
    } catch (e) { setError(e.message); setExp({ state: 'idle' }); }
  }

  function reset() { if (info) fetch(`/api/jobs/${info.id}`, { method: 'DELETE' }); setStep('upload'); setFile(null); setInfo(null); setCaptions([]); setExp({ state: 'idle' }); setError(''); }
  const upd = (i, patch) => setCaptions((cs) => cs.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const seek = (s) => { if (videoRef.current) videoRef.current.currentTime = s; };
  const src = step === 'upload' ? localUrl : `/api/video/${info?.id}`;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-24 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between py-4">
        <h1 className="text-xl font-extrabold tracking-tight"><span className="text-crimson">K-DRAMA</span> AI CAPTION</h1>
        {step !== 'upload' && <button className="btn btn-ghost !py-2 text-sm" onClick={reset}>New video</button>}
      </header>

      {missing?.length > 0 && <div className="glass mb-4 border-crimson/50 p-4 text-sm">Server setup incomplete — missing: {missing.join(', ')}.</div>}
      {error && <div role="alert" className="mb-4 rounded-xl border border-crimson/60 bg-crimson/15 p-4 text-sm">{error}</div>}

      {step === 'upload' && (
        <div className="grid gap-4 md:grid-cols-2">
          <label className="glass flex min-h-64 cursor-pointer flex-col items-center justify-center gap-3 border-dashed p-6 text-center transition hover:border-crimson/70">
            <input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" className="hidden" onChange={(e) => pick(e.target.files[0])} />
            <div className="grid h-16 w-16 place-items-center rounded-full bg-crimson/20 text-3xl text-crimson">⬆</div>
            <p className="text-lg font-bold">{file ? file.name : 'Choose a Korean drama clip'}</p>
            <p className="text-sm text-white/60">MP4 or MOV{health ? ` · up to ${health.maxUploadMB} MB · ${Math.round(health.maxDuration / 60)} min` : ''}</p>
          </label>
          <div className="glass flex flex-col gap-4 p-4">
            {localUrl ? <video src={localUrl} controls playsInline className="max-h-80 w-full rounded-xl bg-black object-contain" onLoadedMetadata={(e) => setFile((f) => Object.assign(f, { dur: e.target.duration }))} /> : <p className="m-auto text-white/50">Video preview appears here.</p>}
            {file && <p className="text-sm text-white/70">{fmtSize(file.size)}{file.dur ? ` · ${fmtDur(file.dur)}` : ''}</p>}
            {upPct !== null ? (
              <div><div className="h-2 overflow-hidden rounded bg-white/10"><div className="h-full bg-crimson" style={{ width: upPct + '%' }} /></div><p className="mt-1 text-sm text-white/60">Uploading {upPct}%</p></div>
            ) : <button className="btn btn-red" disabled={!file || missing?.length > 0} onClick={upload}>Upload and generate captions</button>}
          </div>
        </div>
      )}

      {step === 'processing' && (
        <div className="glass mx-auto max-w-md space-y-4 p-6">
          <p className="font-bold">Working on {info?.name}</p>
          {STAGES.map(([k, label], i) => {
            const cur = STAGES.findIndex(([s]) => s === stage);
            return (
              <div key={k} className={`flex items-center gap-3 ${i > cur ? 'opacity-40' : ''}`}>
                <span className={`grid h-7 w-7 place-items-center rounded-full text-sm ${i < cur ? 'bg-crimson' : 'border border-crimson'}`}>{i < cur ? '✓' : i === cur ? <i className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" /> : ''}</span>
                {label}
              </div>
            );
          })}
        </div>
      )}

      {step === 'edit' && (
        <div className="grid gap-4 md:grid-cols-[minmax(0,380px)_1fr]">
          <div className="space-y-4 md:sticky md:top-4 md:self-start">
            <div className="sticky top-0 z-10 md:static">
              <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_0_60px_-20px_#e11d48]">
                <video ref={videoRef} src={src} controls playsInline className="max-h-[55dvh] w-full object-contain" />
                <Preview videoRef={videoRef} captions={captions} style={style} t={t} />
              </div>
            </div>
            <div className="glass space-y-3 p-4 text-sm">
              <label className="block">Font size<input type="range" min="3" max="9" step="0.1" value={style.fontSize} onChange={(e) => setStyle({ ...style, fontSize: +e.target.value })} /></label>
              <label className="block">Position (from bottom)<input type="range" min="3" max="70" value={style.bottom} onChange={(e) => setStyle({ ...style, bottom: +e.target.value })} /></label>
              <div className="flex flex-wrap gap-2">
                {[['highlight', 'Yellow highlight'], ['background', 'Background'], ['shadow', 'Shadow']].map(([k, l]) => (
                  <button key={k} onClick={() => setStyle({ ...style, [k]: !style[k] })} className={`btn !py-2 text-sm ${style[k] ? 'btn-red' : 'btn-ghost'}`}>{l}</button>
                ))}
              </div>
            </div>
            <div className="glass space-y-3 p-4">
              <div className="flex gap-2">{[720, 1080].map((h) => <button key={h} onClick={() => setHeight(h)} className={`btn flex-1 !py-2 ${height === h ? 'btn-red' : 'btn-ghost'}`}>{h}p</button>)}</div>
              {exp.state === 'rendering' ? (
                <div><div className="h-2 overflow-hidden rounded bg-white/10"><div className="h-full bg-crimson transition-all" style={{ width: Math.round((exp.progress || 0) * 100) + '%' }} /></div><p className="mt-1 text-sm text-white/60">Rendering {Math.round((exp.progress || 0) * 100)}%</p></div>
              ) : exp.state === 'done' ? (
                <a className="btn btn-red w-full" href={`/api/jobs/${info.id}/download`} download>Download MP4 ({fmtSize(exp.size)})</a>
              ) : <button className="btn btn-red w-full" onClick={doExport}>Render video with captions</button>}
              {exp.state === 'done' && <button className="btn btn-ghost w-full !py-2 text-sm" onClick={doExport}>Render again with new settings</button>}
            </div>
          </div>

          <div className="glass space-y-3 p-4">
            <div className="flex items-center justify-between"><h2 className="font-bold">Captions ({captions.length})</h2>
              <button className="btn btn-ghost !py-2 text-sm" onClick={() => { const s = +t.toFixed(1); setCaptions([...captions, { id: Date.now(), start: s, end: +(s + 2).toFixed(1), text: 'නව උපසිරැසිය' }].sort((a, b) => a.start - b.start)); }}>+ Add at playhead</button></div>
            {captions.map((c, i) => (
              <div key={c.id} className={`rounded-xl border p-3 ${t >= c.start && t < c.end ? 'border-crimson bg-crimson/10' : 'border-white/10 bg-black/30'}`}>
                <div className="mb-2 flex items-center gap-2 text-xs text-white/70">
                  <button className="rounded bg-white/10 px-2 py-1" onClick={() => seek(c.start)}>▶</button>
                  <input type="number" step="0.1" min="0" value={c.start} onChange={(e) => upd(i, { start: +e.target.value })} className="w-16 rounded bg-white/10 px-2 py-1" />–
                  <input type="number" step="0.1" min="0" value={c.end} onChange={(e) => upd(i, { end: +e.target.value })} className="w-16 rounded bg-white/10 px-2 py-1" />
                  {c.speaker && <span className="rounded bg-crimson/30 px-2 py-1">Speaker {c.speaker}</span>}
                  <button className="ml-auto px-2 text-lg" aria-label="Delete caption" onClick={() => setCaptions(captions.filter((_, k) => k !== i))}>✕</button>
                </div>
                <textarea rows={2} value={c.text} onChange={(e) => upd(i, { text: e.target.value })} className="w-full resize-none rounded-lg bg-white/10 p-2 text-base font-bold" />
                {c.ko && <p className="mt-1 text-xs text-white/40">{c.ko}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
