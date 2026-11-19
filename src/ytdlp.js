import fs from 'node:fs/promises';
import path from 'node:path';
import { BIN_DIR, FFMPEG } from './config.js';
import { exists, run } from './util.js';

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const isWindows = process.platform === 'win32';

export const YTDLP_PATH = path.join(BIN_DIR, isWindows ? 'yt-dlp.exe' : 'yt-dlp');

let downloading = null;

/**
 * yt-dlp is a single self-contained binary, so fetch it on first use instead of
 * asking the user to install anything.
 */
async function ensureYtDlp() {
  if (await exists(YTDLP_PATH)) return YTDLP_PATH;
  if (downloading) return downloading;

  downloading = (async () => {
    const asset = isWindows ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';
    const response = await fetch(`${RELEASES}/${asset}`);
    if (!response.ok) {
      throw new Error(`Could not download yt-dlp (HTTP ${response.status}). Check your connection.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(YTDLP_PATH, buffer);
    if (!isWindows) await fs.chmod(YTDLP_PATH, 0o755);
    const { stdout: version } = await ytdlp(['--version'], {}, { safe: true });
    console.log(`[ytdlp] installed ${version.trim()}`);
    return YTDLP_PATH;
  })();

  try {
    return await downloading;
  } finally {
    downloading = null;
  }
}

async function ytdlp(args, options = {}, flags = {}) {
  const binary = await ensureYtDlp();
  const ffmpegDir = FFMPEG ? path.dirname(FFMPEG) : null;
  const full = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--no-check-certificates',
    ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
    ...args,
  ];
  try {
    return await run(binary, full, options);
  } catch (error) {
    if (flags.safe) throw error;
    const message = String(error.message || '');
    if (/Sign in to confirm|bot|cookies/i.test(message)) {
      throw new Error(
        'YouTube asked for verification for this video. Try another link, or a video that is not age/region restricted.',
      );
    }
    throw error;
  }
}

export function isYouTubeUrl(url) {
  return /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(String(url || '').trim());
}

export async function fetchInfo(url) {
  const { stdout } = await ytdlp(['--dump-single-json', '--skip-download', url], {
    timeoutMs: 120000,
  });
  const info = JSON.parse(stdout);
  return {
    title: info.title || 'video',
    duration: Number(info.duration) || 0,
    uploader: info.uploader || '',
    thumbnail: info.thumbnail || '',
    id: info.id || '',
    subtitles: info.subtitles || {},
    automaticCaptions: info.automatic_captions || {},
  };
}

const VIDEO_ARGS = [
  '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b',
  '--merge-output-format', 'mp4',
];

export async function downloadVideo(url, dir, onProgress) {
  const target = path.join(dir, 'source.%(ext)s');
  await ytdlp(
    [...VIDEO_ARGS, '-o', target, '--progress', '--progress-template', 'dl:%(progress._percent_str)s', url],
    {
      onStdout: (text) => {
        const match = text.match(/dl:\s*([\d.]+)%/);
        if (match) onProgress?.(Number(match[1]));
      },
    },
  );

  const entries = await fs.readdir(dir);
  const file = entries.find((name) => /^source\.(mp4|mkv|webm|mov|m4v)$/i.test(name));
  if (!file) throw new Error('yt-dlp finished but produced no video file.');
  return path.join(dir, file);
}

/**
 * Grab YouTube's own caption track (human or auto-generated). This is instant and
 * needs no API key, and gives us word/burst timings for free.
 */
export async function downloadSubtitles(url, dir, lang = 'en') {
  const out = path.join(dir, 'captions');
  try {
    await ytdlp(
      [
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs', `${lang}.*,${lang},en.*,en`,
        '--sub-format', 'json3/vtt/best',
        '-o', out,
        url,
      ],
      { timeoutMs: 120000 },
    );
  } catch {
    // yt-dlp exits non-zero when a video has auto-captions only, yet the files
    // are still written — so fall through and scan the directory anyway.
  }

  const entries = await fs.readdir(dir).catch(() => []);
  const files = entries
    .filter((name) => /^captions.*\.(json3|json|vtt|srt)$/i.test(name))
    .sort((a, b) => {
      // json3 gives the best timings; among equals prefer the plain "en" track.
      const rank = (n) => (/json3$/i.test(n) ? 0 : /vtt$/i.test(n) ? 1000 : 2000) + n.length;
      return rank(a) - rank(b);
    });

  for (const name of files) {
    return { path: path.join(dir, name), format: path.extname(name).slice(1).toLowerCase() };
  }
  return null;
}
