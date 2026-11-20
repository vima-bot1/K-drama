// Builds an ASS subtitle file. libass (inside FFmpeg) shapes Sinhala via HarfBuzz.
const ts = (s) => {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};
const clean = (t) => t.replace(/[{}]/g, '').replace(/\\/g, '').replace(/\r?\n/g, '\\N');

export function buildAss(captions, style, W, H) {
  const fs = Math.round((style.fontSize / 100) * H);
  const mv = Math.round((style.bottom / 100) * H);
  const bg = style.background;
  const outline = bg ? Math.round(fs * 0.22) : Math.max(2, Math.round(fs * 0.09));
  const shadow = style.shadow ? Math.max(2, Math.round(fs * 0.06)) : 0;
  const box = '&H99000000';
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Noto Sans Sinhala,${fs},&H00FFFFFF,&H00FFFFFF,${bg ? box : '&H00000000'},${bg ? box : '&H90000000'},-1,0,0,0,100,100,0,0,${bg ? 3 : 1},${outline},${shadow},2,${Math.round(W * 0.06)},${Math.round(W * 0.06)},${mv},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;
  const lines = [];
  for (const c of captions) {
    const text = clean(c.text.trim());
    if (!text || c.end <= c.start) continue;
    const words = text.split(/\s+/);
    if (!style.highlight || words.length < 2) {
      lines.push(`Dialogue: 0,${ts(c.start)},${ts(c.end)},Default,,0,0,0,,${text}`);
      continue;
    }
    // Yellow highlight moves word by word, timed proportionally to word length.
    const total = words.reduce((a, w) => a + w.length, 0);
    let t = c.start;
    words.forEach((w, i) => {
      const end = i === words.length - 1 ? c.end : t + ((c.end - c.start) * w.length) / total;
      const body = words.map((x, j) => (j === i ? `{\\1c&H00FFFF&}${x}{\\1c&HFFFFFF&}` : x)).join(' ');
      lines.push(`Dialogue: 0,${ts(t)},${ts(end)},Default,,0,0,0,,${body}`);
      t = end;
    });
  }
  return header + lines.join('\n') + '\n';
}
