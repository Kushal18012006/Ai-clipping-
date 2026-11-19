import fs from 'node:fs/promises';
import path from 'node:path';
import { AI } from './config.js';
import { ffmpeg, round } from './util.js';

const CHUNK_SECONDS = 600;

/**
 * Whisper's upload limit is 25 MB, so split the audio into 10 minute chunks and
 * stitch the timestamps back together. Mono 16 kHz mp3 keeps each chunk tiny.
 */
async function extractAudioChunks(source, dir, duration) {
  const pattern = path.join(dir, 'audio-%03d.mp3');
  await ffmpeg(
    [
      '-i', source,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '32k',
      '-f', 'segment',
      '-segment_time', String(CHUNK_SECONDS),
      '-reset_timestamps', '1',
      '-y', pattern,
    ],
    { timeoutMs: 600000 },
  );

  const entries = (await fs.readdir(dir))
    .filter((name) => /^audio-\d+\.mp3$/.test(name))
    .sort();
  if (!entries.length) throw new Error('Could not extract audio from the video.');

  return entries.map((name, index) => ({
    path: path.join(dir, name),
    offset: index * CHUNK_SECONDS,
    // The last chunk may be shorter; offsets stay true regardless.
    duration: Math.min(CHUNK_SECONDS, Math.max(0, duration - index * CHUNK_SECONDS)),
  }));
}

async function transcribeChunk(file) {
  const buffer = await fs.readFile(file);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), path.basename(file));
  form.append('model', AI.transcribeModel);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

  const response = await fetch(`${AI.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AI.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(600000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Transcription failed (HTTP ${response.status}). ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (!segments.length && data.text) {
    return [{ start: 0, end: 0, text: String(data.text).trim() }];
  }
  return segments
    .map((seg) => ({
      start: round(Number(seg.start) || 0, 2),
      end: round(Number(seg.end) || 0, 2),
      text: String(seg.text || '').trim(),
    }))
    .filter((seg) => seg.text);
}

/** Transcribe an arbitrary video file with the configured speech-to-text model. */
export async function transcribeVideo(source, dir, duration, onProgress) {
  if (!AI.apiKey) return null;

  const audioDir = path.join(dir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });
  const chunks = await extractAudioChunks(source, audioDir, duration);

  const cues = [];
  for (let i = 0; i < chunks.length; i += 1) {
    onProgress?.(Math.round((i / chunks.length) * 100));
    const segments = await transcribeChunk(chunks[i].path);
    for (const seg of segments) {
      cues.push({
        start: round(seg.start + chunks[i].offset, 2),
        end: round(seg.end + chunks[i].offset, 2),
        text: seg.text,
      });
    }
  }

  await fs.rm(audioDir, { recursive: true, force: true }).catch(() => {});
  onProgress?.(100);
  return cues.length ? cues : null;
}
