import fs from 'node:fs/promises';
import path from 'node:path';
import { CLIP_PRESETS } from './config.js';
import { ffmpeg, round, safeSlug } from './util.js';

function assTime(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const centis = Math.round((total - Math.floor(total)) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(
    Math.min(99, centis),
  ).padStart(2, '0')}`;
}

function escapeAss(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** Break a cue into 2-3 word caption chunks, timing each by character weight. */
function captionEvents(cues, clipStart, clipEnd, offset) {
  const events = [];
  for (const cue of cues) {
    if (cue.end < clipStart || cue.start > clipEnd) continue;
    const words = String(cue.text).split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    const start = Math.max(cue.start, clipStart);
    const end = Math.min(cue.end, clipEnd);
    const span = Math.max(0.35, end - start);

    // Keep every caption to a readable width: ~18 characters, at most 4 words.
    const groups = [];
    let group = [];
    for (const word of words) {
      const candidate = [...group, word].join(' ');
      if (group.length && (candidate.length > 18 || group.length >= 4)) {
        groups.push(group);
        group = [];
      }
      group.push(word);
    }
    if (group.length) groups.push(group);
    const totalChars = groups.reduce((sum, wordsInGroup) => sum + wordsInGroup.join(' ').length + 1, 0);

    let cursor = start;
    for (const group of groups) {
      const share = (group.join(' ').length + 1) / totalChars;
      const next = Math.min(end, cursor + span * share);
      const text = escapeAss(group.join(' ').toUpperCase());
      if (text && next - cursor > 0.12) {
        events.push({
          start: cursor - clipStart + offset,
          end: next - clipStart + offset,
          text,
          chars: text.length,
        });
      }
      cursor = next;
    }
  }
  return events;
}

async function writeAss(file, events, { width, height }) {
  const fontSize = Math.round(width / 14);
  const safeWidth = width - 120;
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.round(fontSize / 9)},${Math.round(fontSize / 14)},2,60,60,${Math.round(height / 4.2)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const body = events
    .map((event) => {
      // Shrink long lines instead of letting libass clip them off-screen.
      const estimated = (event.chars || event.text.length) * fontSize * 0.56;
      const shrunk =
        estimated > safeWidth ? Math.floor((fontSize * safeWidth) / estimated) : fontSize;
      const override = `{\\fad(80,80)${shrunk < fontSize ? `\\fs${shrunk}` : ''}}`;
      return `Dialogue: 0,${assTime(event.start)},${assTime(event.end)},Cap,,0,0,0,,${override}${event.text}`;
    })
    .join('\n');

  await fs.writeFile(file, `${header}${body}\n`, 'utf8');
}

function buildFilter(aspect, assName, hasCaptions) {
  const preset = CLIP_PRESETS[aspect] || CLIP_PRESETS.vertical;
  const { width, height } = preset;

  let chain;
  if (aspect === 'original') {
    chain = '[0:v]null[v0]';
  } else if (aspect === 'blurpad') {
    chain = [
      '[0:v]split=2[bg][fg]',
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=30,eq=brightness=-0.12:saturation=0.85[bgb]`,
      `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgs]`,
      '[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[v0]',
    ].join(';');
  } else {
    chain = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[v0]`;
  }

  if (hasCaptions) {
    chain += `;[v0]ass=${assName}[vout]`;
  } else {
    chain += ';[v0]null[vout]';
  }
  return chain;
}

export async function renderClip({ source, cues, clip, index, dir, options, meta }) {
  // ffmpeg runs with cwd = the job dir so caption filenames stay relative.
  const absoluteSource = path.resolve(source);
  const outputName = `clip-${String(index + 1).padStart(2, '0')}-${safeSlug(clip.title)}.mp4`;
  const outputPath = path.resolve(dir, outputName);
  const duration = Math.max(1, clip.end - clip.start);

  let assName = null;
  const captionSource = clip.cues || cues;
  if (options.captions !== false && captionSource?.length) {
    const events = captionEvents(captionSource, clip.start, clip.end, 0);
    if (events.length) {
      assName = `caption-${index + 1}.ass`;
      const size = CLIP_PRESETS[options.aspect] || CLIP_PRESETS.vertical;
      await writeAss(path.join(dir, assName), events, {
        width: size.width || meta.width || 1080,
        height: size.height || meta.height || 1920,
      });
    }
  }

  const filterComplex = buildFilter(options.aspect, assName, Boolean(assName));

  await ffmpeg(
    [
      '-ss', String(round(clip.start, 2)),
      '-t', String(round(duration, 2)),
      '-i', absoluteSource,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ac', '2',
      '-movflags', '+faststart',
      '-y', outputPath,
    ],
    { cwd: dir, timeoutMs: 1800000 },
  );

  // Cover frame at ~1.5s into the clip, which is usually past the first frame.
  const thumbName = `thumb-${index + 1}.jpg`;
  const thumbPath = path.resolve(dir, thumbName);
  await ffmpeg(
    [
      '-ss', String(round(clip.start + Math.min(1.5, duration / 3), 2)),
      '-i', absoluteSource,
      '-frames:v', '1',
      '-vf', 'scale=540:-2',
      '-q:v', '4',
      '-y', thumbPath,
    ],
    { cwd: dir, timeoutMs: 120000 },
  ).catch(() => {});

  return {
    ...clip,
    file: outputName,
    thumb: thumbName,
    duration: round(duration, 2),
  };
}

export async function cleanupAssets(dir, keep = []) {
  const entries = await fs.readdir(dir).catch(() => []);
  for (const name of entries) {
    if (keep.includes(name)) continue;
    await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
  }
}
