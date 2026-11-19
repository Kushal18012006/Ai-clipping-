import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG, FFPROBE } from './config.js';

/**
 * Run a process and resolve with its output. Rejects with the tail of stderr so
 * failures are diagnosable instead of just "exit code 1".
 */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: { ...process.env, ...options.env },
    });

    let stdout = '';
    let stderr = '';
    const cap = options.maxBuffer ?? 8 * 1024 * 1024;

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      if (stdout.length < cap) stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-20000);
      options.onStderr?.(text);
    });

    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`${path.basename(command)} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error(`Failed to start ${path.basename(command)}: ${error.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim().split('\n').slice(-6).join('\n') || `${command} exited with ${code}`));
    });
  });
}

export async function probe(file) {
  if (!FFPROBE) throw new Error('ffprobe is unavailable.');
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    file,
  ]);
  const data = JSON.parse(stdout);
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  const fpsText = video?.avg_frame_rate || video?.r_frame_rate || '30/1';
  const [num, den] = fpsText.split('/').map(Number);
  return {
    duration: Number(data.format?.duration || video?.duration || 0) || 0,
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    fps: den ? Number((num / den).toFixed(3)) : 30,
    hasAudio: Boolean(audio),
    sizeBytes: Number(data.format?.size || 0),
    title: data.format?.tags?.title || '',
  };
}

export function ffmpeg(args, options = {}) {
  if (!FFMPEG) throw new Error('ffmpeg is unavailable.');
  return run(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], options);
}

export function newId() {
  return crypto.randomBytes(6).toString('hex');
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Assign `value` into `list` at index `i`. */
export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function safeSlug(text, fallback = 'clip') {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

export function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Shape a clip's numbers so the UI never renders NaN. */
export function normalizeClip(clip, index) {
  return {
    id: clip.id || `clip-${index + 1}`,
    file: clip.file || null,
    thumb: clip.thumb || null,
    start: round(clip.start, 2),
    end: round(clip.end, 2),
    duration: round(clip.end - clip.start, 2),
    title: clip.title || `Clip ${index + 1}`,
    hook: clip.hook || '',
    reason: clip.reason || '',
    score: clamp(Math.round(Number(clip.score) || 0), 0, 100),
    caption: clip.caption || '',
    hashtags: Array.isArray(clip.hashtags) ? clip.hashtags.slice(0, 8) : [],
  };
}
