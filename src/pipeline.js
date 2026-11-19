import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeEnergy, selectClips } from './analyze.js';
import { CLIP_PRESETS, JOBS_DIR } from './config.js';
import { addLog, registerJob, updateJob } from './jobs.js';
import { cleanupAssets, renderClip } from './render.js';
import { readSubtitles, transcriptText } from './subtitles.js';
import { transcribeVideo } from './transcribe.js';
import { AI } from './config.js';
import { newId, normalizeClip, probe } from './util.js';
import { downloadSubtitles, downloadVideo, fetchInfo, isYouTubeUrl } from './ytdlp.js';

const MAX_CONCURRENT = 2;
let active = 0;
const queue = [];

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const task = queue.shift();
    active += 1;
    task().finally(() => {
      active -= 1;
      pump();
    });
  }
}

export function normalizeOptions(raw = {}) {
  const count = Math.min(10, Math.max(1, Number(raw.count) || 5));
  let minSec = Math.min(180, Math.max(5, Number(raw.minSec) || 20));
  let maxSec = Math.min(240, Math.max(minSec + 5, Number(raw.maxSec) || 60));
  const aspect = CLIP_PRESETS[raw.aspect] ? raw.aspect : 'vertical';
  return {
    count,
    minSec,
    maxSec,
    aspect,
    captions: raw.captions !== false && raw.captions !== 'false' && raw.captions !== '0',
    lang: String(raw.lang || 'en').slice(0, 8),
  };
}

/**
 * Create a job and run it in the background. Returns the job id immediately so
 * the browser can subscribe to progress.
 */
export function startJob({ input, options }) {
  const id = newId();
  const dir = path.join(JOBS_DIR, id);

  const job = registerJob({
    id,
    dir,
    createdAt: Date.now(),
    status: 'queued',
    stage: 'queued',
    progress: 0,
    message: 'Waiting for a free slot',
    error: null,
    logs: [],
    clips: [],
    options,
    source: {
      type: input.type,
      url: input.url || null,
      title: input.title || (input.file ? path.basename(input.file) : 'video'),
      duration: 0,
      thumbnail: '',
    },
  });

  queue.push(() => run(job, input, options));
  pump();
  return id;
}

async function run(job, input, options) {
  const { id, dir } = job;
  const stage = (name, progress, message) => {
    updateJob(id, { stage: name, progress: Math.round(progress), message });
    if (message) addLog(id, message);
  };

  try {
    await fs.mkdir(dir, { recursive: true });
    updateJob(id, { status: 'running' });
    stage('prepare', 2, 'Preparing workspace');

    let source = null;
    let info = null;
    let cues = null;

    if (input.type === 'url') {
      stage('download', 5, 'Reading video information');
      info = await fetchInfo(input.url);
      updateJob(id, {
        source: {
          type: 'url',
          url: input.url,
          title: info.title,
          duration: info.duration,
          thumbnail: info.thumbnail,
        },
      });

      // Captions are tiny, so fetch them alongside the video.
      const subtitlesPromise = downloadSubtitles(input.url, dir, options.lang).catch(() => null);

      stage('download', 8, 'Downloading video');
      let lastLogged = 0;
      source = await downloadVideo(input.url, dir, (percent) => {
        updateJob(id, {
          stage: 'download',
          progress: Math.round(8 + percent * 0.26),
          message: `Downloading video ${percent.toFixed(0)}%`,
        });
        if (percent - lastLogged >= 20) {
          lastLogged = percent;
          addLog(id, `Downloaded ${percent.toFixed(0)}%`);
        }
      });

      const subtitleFile = await subtitlesPromise;
      if (subtitleFile) {
        cues = await readSubtitles(subtitleFile.path);
        stage('transcribe', 34, cues.length ? `Loaded ${cues.length} caption cues` : 'Captions were empty');
      } else {
        stage('transcribe', 34, 'No captions on this video');
      }
    } else {
      source = input.file;
      stage('download', 12, 'Video uploaded');
    }

    const meta = await probe(source);
    const duration = meta.duration || info?.duration || 0;
    if (!duration) throw new Error('Could not read the video duration. Is this file a valid video?');
    if (!meta.hasAudio) throw new Error('This video has no audio track, so there is nothing to analyze.');

    updateJob(id, {
      source: {
        ...job.source,
        duration,
        title: job.source.title || info?.title || 'video',
      },
    });

    if (!cues?.length) {
      if (AI.apiKey) {
        stage('transcribe', 36, 'Transcribing audio with AI');
        cues = await transcribeVideo(source, dir, duration, (percent) => {
          updateJob(id, {
            stage: 'transcribe',
            progress: Math.round(36 + percent * 0.18),
            message: `Transcribing ${percent}%`,
          });
        });
        if (cues?.length) addLog(id, `Transcribed ${cues.length} segments`);
        else addLog(id, 'Transcription returned nothing, falling back to audio analysis');
      } else {
        addLog(id, 'No AI key set and no captions — ranking by audio energy instead');
      }
    }

    stage('analyze', 56, 'Analyzing audio energy');
    const energy = await analyzeEnergy(source);

    stage('analyze', 62, 'Selecting the strongest moments');
    const selected = await selectClips({
      cues,
      energy,
      duration,
      options,
      sourceTitle: job.source.title,
      onProgress: (message) => addLog(id, message),
    });

    if (!selected.length) {
      throw new Error(
        'No usable moments were found. Try a longer video, or a wider clip length range.',
      );
    }

    const clips = [];
    for (let i = 0; i < selected.length; i += 1) {
      const base = 68 + (i / selected.length) * 27;
      stage('render', base, `Rendering clip ${i + 1} of ${selected.length}`);
      const clipCues = cues?.length ? cues : null;
      const rendered = await renderClip({
        source,
        cues: clipCues,
        clip: selected[i],
        index: i,
        dir,
        options,
        meta,
      });
      const normalized = normalizeClip(rendered, i);
      clips.push(normalized);
      updateJob(id, { clips: [...clips] });
      addLog(id, `Clip ${i + 1} ready (${Math.round(normalized.duration)}s)`);
    }

    const manifest = {
      id,
      createdAt: new Date().toISOString(),
      title: job.source.title,
      url: job.source.url,
      transcriptExcerpt: cues?.length ? transcriptText(cues, 4000) : null,
      options,
      clips,
    };
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // The downloaded source can be gigabytes; the clips are what we keep.
    await cleanupAssets(
      dir,
      [...clips.flatMap((clip) => [clip.file, clip.thumb]), 'manifest.json'].filter(Boolean),
    );

    updateJob(id, {
      status: 'done',
      stage: 'done',
      progress: 100,
      message: `${clips.length} clip${clips.length === 1 ? '' : 's'} ready`,
      clips,
    });
    addLog(id, 'Finished');
  } catch (error) {
    console.error(`[job ${id}]`, error);
    updateJob(id, {
      status: 'error',
      stage: 'error',
      message: 'Something went wrong',
      error: error.message || String(error),
    });
    addLog(id, `Error: ${error.message || error}`);
    if (input.type === 'file') await fs.rm(input.file, { force: true }).catch(() => {});
  }
}

export function looksLikeUrl(value) {
  return isYouTubeUrl(value) || /^https?:\/\//i.test(String(value || '').trim());
}
