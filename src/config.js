import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env without adding a dependency. Node ships loadEnvFile since 20.12.
try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  /* no .env file is fine */
}

export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const JOBS_DIR = path.join(ROOT_DIR, 'jobs');
export const BIN_DIR = path.join(ROOT_DIR, 'bin');

for (const dir of [JOBS_DIR, BIN_DIR]) fs.mkdirSync(dir, { recursive: true });

function packagedBin(envVar, moduleName) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    return require(moduleName).path;
  } catch {
    return null;
  }
}

export const FFMPEG = packagedBin('FFMPEG_PATH', '@ffmpeg-installer/ffmpeg');
export const FFPROBE = packagedBin('FFPROBE_PATH', '@ffprobe-installer/ffprobe');

const envPort = Number.parseInt(process.env.PORT ?? '', 10);
export const PORT = Number.isInteger(envPort) && envPort > 0 ? envPort : 5180;

export const AI = {
  apiKey: process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '',
  baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  model: process.env.AI_MODEL || 'gpt-4o-mini',
  transcribeModel: process.env.AI_TRANSCRIBE_MODEL || 'whisper-1',
};

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1610612736); // 1.5 GB

export const CLIP_PRESETS = {
  vertical: { width: 1080, height: 1920, label: 'Vertical 9:16 (crop)' },
  blurpad: { width: 1080, height: 1920, label: 'Vertical 9:16 (blurred pad)' },
  original: { width: 0, height: 0, label: 'Original aspect' },
};

if (!FFMPEG) {
  console.warn('[config] ffmpeg not found. Install @ffmpeg-installer/ffmpeg or set FFMPEG_PATH.');
}
