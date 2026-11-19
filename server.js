import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { AI, CLIP_PRESETS, FFMPEG, FFPROBE, JOBS_DIR, MAX_UPLOAD_BYTES, PORT, PUBLIC_DIR } from './src/config.js';
import { getJob, listJobs, snapshot, subscribe } from './src/jobs.js';
import { looksLikeUrl, normalizeOptions, startJob } from './src/pipeline.js';
import { newId } from './src/util.js';

const app = express();
const TMP_DIR = path.join(JOBS_DIR, '_tmp');
await fs.mkdir(TMP_DIR, { recursive: true });

app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${newId()}${path.extname(file.originalname) || '.mp4'}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: Boolean(FFMPEG && FFPROBE),
    aiConfigured: Boolean(AI.apiKey),
    model: AI.apiKey ? AI.model : null,
    presets: Object.entries(CLIP_PRESETS).map(([id, preset]) => ({ id, label: preset.label })),
    jobs: listJobs().length,
  });
});

app.post('/api/jobs', (req, res) => {
  upload.single('video')(req, res, async (uploadError) => {
    if (uploadError) {
      const message =
        uploadError.code === 'LIMIT_FILE_SIZE'
          ? `That file is larger than ${(MAX_UPLOAD_BYTES / 1024 ** 3).toFixed(1)} GB.`
          : uploadError.message;
      return res.status(400).json({ error: message });
    }

    const options = normalizeOptions(req.body);
    const url = String(req.body.url || '').trim();

    try {
      if (req.file) {
        const id = newId();
        const dir = path.join(JOBS_DIR, id);
        await fs.mkdir(dir, { recursive: true });
        const target = path.join(dir, `upload${path.extname(req.file.filename) || '.mp4'}`);
        await fs.rename(req.file.path, target);

        const jobId = startJob({
          input: { type: 'file', file: target, title: req.file.originalname },
          options,
        });
        return res.status(202).json({ id: jobId });
      }

      if (!url) return res.status(400).json({ error: 'Paste a video URL or choose a file.' });
      if (!looksLikeUrl(url)) return res.status(400).json({ error: 'That does not look like a video URL.' });

      const jobId = startJob({ input: { type: 'url', url }, options });
      return res.status(202).json({ id: jobId });
    } catch (error) {
      console.error('[api] failed to start job', error);
      return res.status(500).json({ error: error.message || 'Could not start the job.' });
    }
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(snapshot(job));
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (payload) => res.write(`data: ${JSON.stringify(snapshot(payload))}\n\n`);
  send(job);

  const unsubscribe = subscribe(job.id, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

app.use('/files', express.static(JOBS_DIR, { maxAge: '1h', index: false }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  return res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  const ready = FFMPEG && FFPROBE;
  console.log(`\n  ClipForge  →  http://localhost:${PORT}`);
  console.log(`  ffmpeg: ${ready ? 'ready' : 'MISSING'}`);
  console.log(`  AI key: ${AI.apiKey ? `configured (${AI.model})` : 'not set — using captions + audio analysis'}`);
  console.log(`  Uploads land in ${TMP_DIR}\n`);
});
