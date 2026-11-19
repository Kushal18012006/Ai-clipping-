# ClipForge

Turn a YouTube link or an uploaded video into short, vertical, captioned clips — the kind that
perform on Shorts, Reels and TikTok.

ClipForge transcribes the video, scores every moment for hook strength and energy, then cuts,
reframes and captions the winners with ffmpeg. Everything runs locally on your machine.

## Requirements

- Node.js 20.12 or newer
- Internet access on first YouTube run (yt-dlp downloads itself into `bin/`)
- Nothing else: ffmpeg and ffprobe ship as npm dependencies

## Run it

```bash
npm install
npm start
```

Open <http://localhost:5180>.

Paste a YouTube URL (or drop a file), pick how many clips and how long, hit **Generate clips**.
Finished MP4s land in `jobs/<job-id>/`, and the page lists them with a poster frame, viral score,
suggested caption and hashtags.

## AI key (optional but recommended)

Without a key ClipForge still works: it reads YouTube's own caption track when available and ranks
moments by hook language plus audio energy. With a key it also transcribes videos that have no
captions and uses an LLM to pick the moments and write titles/captions.

Copy `.env.example` to `.env` and fill in:

```
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
AI_TRANSCRIBE_MODEL=whisper-1
```

Any OpenAI-compatible API works (OpenAI, Groq, OpenRouter, a local gateway) as long as it exposes
`/chat/completions` and, for transcription, `/audio/transcriptions`. Restart the server after
changing `.env`; the header chip shows whether the key was picked up.

## How it works

| Stage | What happens |
| --- | --- |
| Fetch | `yt-dlp` downloads up to 1080p and pulls the caption track in parallel; uploads are used as-is |
| Transcribe | Caption cues are parsed (json3/VTT/SRT, rolling auto-captions collapsed), otherwise audio is chunked and sent to Whisper |
| Analyze | Per-second RMS loudness from ffmpeg, then the LLM (or the built-in hook/density scorer) ranks non-overlapping windows |
| Cut | ffmpeg renders 1080×1920 with either a center crop or a blurred-pad background, burns ASS captions (3-word chunks), writes a poster frame |

Clips are numbered by timestamp order; `manifest.json` in each job folder records transcript
excerpt, scores and reasoning.

## Notes and limits

- Downloads and renders are CPU- and bandwidth-heavy. Two jobs run at once (`src/pipeline.js`).
- Uploads are capped at 1.5 GB (`MAX_UPLOAD_BYTES`).
- Source videos are deleted after rendering — only clips, thumbnails and the manifest are kept.
- YouTube may ask for sign-in on age/region-restricted videos; ClipForge surfaces that as an error
  rather than failing silently.
- Vertical crop is center-weighted. For talking-head footage where the speaker sits off-center,
  `Vertical (blur)` keeps the full frame legible.
