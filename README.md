# K-DRAMA AI CAPTION

Upload a Korean clip → Whisper transcribes Korean with timestamps → Gemini translates to natural spoken Sinhala → edit captions live → FFmpeg burns TikTok-style captions into an MP4 (720p/1080p, original audio kept).

## Requirements
Node.js 20+, FFmpeg + FFprobe (with libass/HarfBuzz – standard builds have it), an OpenAI API key (Whisper) and a Gemini API key.

## Install & run
```bash
npm install            # root (concurrently)
npm run setup          # installs server+client, downloads Noto Sans Sinhala Bold into server/fonts
cp .env.example server/.env   # then add your keys
npm run dev            # API :3000, web :5173 (open from phone via your LAN IP)
```
Production: `npm run build && npm start` (Express serves the built frontend on :3000).

## Deploy
Docker (includes FFmpeg): `docker build -t kdrama . && docker run -p 3000:3000 --env-file server/.env kdrama`
Deploy on any host that runs Docker/Node with persistent CPU (Railway, Render, Fly.io, a VPS). Not for serverless (needs FFmpeg + long requests).
Behind nginx set `client_max_body_size 300m;` and `proxy_read_timeout 300s;`. Always serve over HTTPS.

## Notes
- Keys live only in `server/.env`; the browser never sees them.
- Jobs are in memory; files auto-delete after 3 h. Single-instance only. For multi-user scale add a queue (BullMQ) + object storage + auth/rate limiting.
- Speaker labels are Gemini's guess from dialogue turns (Whisper has no diarization). For true diarization swap in AssemblyAI/pyannote in `server/ai.js`.
- Chrome on Android plays H.264 MOV for preview; HEVC MOV may not preview but still exports correctly.
- Always proofread the Sinhala in the editor before exporting.
