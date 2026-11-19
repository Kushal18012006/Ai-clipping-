import { AI, FFMPEG } from './config.js';
import { clamp, ffmpeg, round } from './util.js';

const HOOK_PATTERNS = [
  /\b(how|why|what|when)\b/i,
  /\b(secret|truth|mistake|reason|nobody|most people|everyone)\b/i,
  /\b(never|always|stop|don'?t|avoid|listen)\b/i,
  /\b(here'?s|this is|the key|the problem|turns out)\b/i,
  /\b(insane|crazy|wild|shocking|actually|literally)\b/i,
  /\b(free|money|rich|broke|easy|fast|instant)\b/i,
];

const EMOTION_WORDS =
  /\b(insane|crazy|wild|crazy|shocking|unbelievable|huge|massive|terrible|amazing|incredible|worst|best|never|hate|love|fear|regret|secret|lie|wrong|right|free|expensive|broke|rich|fail|failed|win|won|lost)\b/gi;

const STOPWORDS = new Set(
  'the a an and or but if then than that this these those is are was were be been being to of in on at for with from by as it its you your we our they their i me my he she his her not no do does did have has had will would can could should just so very really about into out up down over under more most other some such only own same too also'.split(
    ' ',
  ),
);

/** Per-second loudness, used to prefer energetic moments and snap cuts to pauses. */
export async function analyzeEnergy(source) {
  if (!FFMPEG) return [];
  try {
    const { stdout } = await ffmpeg(
      [
        '-i', source,
        '-vn',
        '-ac', '1',
        '-ar', '8000',
        '-af',
        'asetnsamples=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
        '-f', 'null',
        '-',
      ],
      { timeoutMs: 900000 },
    );

    const points = [];
    let pendingTime = null;
    for (const line of stdout.split('\n')) {
      const timeMatch = line.match(/pts_time:([\d.]+)/);
      if (timeMatch) {
        pendingTime = Number(timeMatch[1]);
        continue;
      }
      const rmsMatch = line.match(/RMS_level=(-?[\d.]+|-inf)/);
      if (rmsMatch && pendingTime != null) {
        const raw = rmsMatch[1] === '-inf' ? -90 : Number(rmsMatch[1]);
        points.push({ t: pendingTime, rms: Number.isFinite(raw) ? raw : -90 });
        pendingTime = null;
      }
    }
    return points;
  } catch {
    return []; // loudness analysis is a nice-to-have
  }
}

function meanRms(points, start, end) {
  const inside = points.filter((p) => p.t >= start && p.t < end);
  if (!inside.length) return -60;
  return inside.reduce((sum, p) => sum + p.rms, 0) / inside.length;
}

/** Move a cut point to the nearest quiet moment so clips start/end cleanly. */
function snapToSilence(points, time, window = 1.5) {
  if (!points.length) return time;
  const near = points.filter((p) => Math.abs(p.t - time) <= window);
  if (!near.length) return time;
  const quiet = near.reduce((best, p) => (p.rms < best.rms ? p : best), near[0]);
  return quiet.rms < -30 ? round(quiet.t, 2) : time;
}

function buildSentences(cues) {
  const sentences = [];
  let current = null;
  for (const cue of cues) {
    if (!current) {
      current = { start: cue.start, end: cue.end, text: cue.text };
      continue;
    }
    const gap = cue.start - current.end;
    if (gap > 1.2 || current.end - current.start > 14) {
      sentences.push(current);
      current = { start: cue.start, end: cue.end, text: cue.text };
      continue;
    }
    current.text = `${current.text} ${cue.text}`;
    current.end = cue.end;
    if (/[.!?]$/.test(cue.text)) {
      sentences.push(current);
      current = null;
    }
  }
  if (current) sentences.push(current);
  return sentences.filter((s) => s.text.replace(/[^\w]/g, '').length > 3);
}

function scoreSentence(text) {
  let score = 0;
  for (const pattern of HOOK_PATTERNS) if (pattern.test(text)) score += 1.4;
  if (/\?/.test(text)) score += 1.2;
  if (/\d/.test(text)) score += 0.8;
  const emotions = text.match(EMOTION_WORDS) || [];
  score += Math.min(emotions.length, 4) * 0.7;
  if (/\b(you|your)\b/i.test(text)) score += 0.5;
  return score;
}

function heuristicClips({ cues, energy, options, duration }) {
  const { count, minSec, maxSec } = options;
  const target = (minSec + maxSec) / 2;
  const sentences = buildSentences(cues);
  if (!sentences.length) return [];

  const candidates = [];
  for (let i = 0; i < sentences.length; i += 1) {
    let j = i;
    while (j < sentences.length && sentences[j].end - sentences[i].start < minSec) j += 1;
    if (j >= sentences.length) break;
    const start = sentences[i].start;
    const end = sentences[j].end;
    const length = end - start;
    if (length > maxSec + 6) continue;
    if (end > duration) continue;

    const text = sentences.slice(i, j + 1).map((s) => s.text).join(' ');
    const words = text.split(/\s+/).filter(Boolean).length;
    const density = words / Math.max(1, length);
    let score = scoreSentence(sentences[i].text) + scoreSentence(text) * 0.35;
    score += clamp((density - 1.6) * 1.6, -1.5, 2.5);
    score -= Math.abs(length - target) / Math.max(6, target) * 1.5;
    score += 1.2; // baseline so scores read sensibly

    const loudness = energy.length ? meanRms(energy, start, end) : -20;
    if (energy.length) score += clamp((loudness + 30) / 6, -1, 2);

    candidates.push({
      start,
      end,
      text,
      first: sentences[i].text,
      score,
      duration: length,
      density,
    });
  }

  if (!candidates.length) return [];
  const best = Math.max(...candidates.map((c) => c.score));

  const chosen = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= count) break;
    const overlaps = chosen.some((pick) => candidate.start < pick.end - 2 && candidate.end > pick.start + 2);
    if (!overlaps) chosen.push(candidate);
  }

  return chosen
    .sort((a, b) => a.start - b.start)
    .map((candidate, index) => {
      const start = snapToSilence(energy, candidate.start, 1.5);
      const end = snapToSilence(energy, candidate.end, 1.5);
      const safeEnd = end - start >= minSec ? end : candidate.end;
      const title = makeTitle(candidate.first);
      return {
        start,
        end: round(Math.min(safeEnd, duration), 2),
        title,
        hook: candidate.first.slice(0, 120),
        reason: `High-energy, information-dense stretch (${candidate.density.toFixed(1)} words/sec) that opens with a strong hook.`,
        score: clamp(Math.round(55 + (candidate.score / Math.max(best, 1)) * 40), 45, 97),
        caption: title,
        hashtags: ['#shorts', '#viral', '#clips'],
        source: 'heuristic',
        index,
      };
    });
}

/** Last resort when there is no transcript: pick the loudest, busiest moments. */
function energyClips({ energy, options, duration }) {
  const { count, minSec, maxSec } = options;
  const target = clamp((minSec + maxSec) / 2, 15, Math.max(20, duration));
  if (energy.length < 5) return [];

  const step = Math.max(2, Math.floor(target / 8));
  const scored = [];
  for (let t = 0; t + target <= duration; t += step) {
    const loud = meanRms(energy, t, t + target);
    const window = energy.filter((p) => p.t >= t && p.t < t + target);
    const positive = window.filter((p) => p.rms > -45);
    const variance = positive.length
      ? positive.reduce((sum, p) => sum + (p.rms + 25) ** 2, 0) / positive.length
      : 0;
    scored.push({ start: t, end: t + target, score: loud + Math.min(variance, 60) * 0.05 });
  }

  const chosen = [];
  for (const candidate of scored.sort((a, b) => b.score - a.score)) {
    if (chosen.length >= count) break;
    if (chosen.some((pick) => candidate.start < pick.end - 2 && candidate.end > pick.start + 2)) continue;
    chosen.push(candidate);
  }
  if (!chosen.length) return [];

  const best = Math.max(...chosen.map((c) => c.score));
  return chosen
    .sort((a, b) => a.start - b.start)
    .map((candidate, index) => ({
      start: snapToSilence(energy, candidate.start, 2),
      end: round(Math.min(candidate.end, duration), 2),
      title: `Highlight at ${Math.floor(candidate.start / 60)}:${String(Math.floor(candidate.start % 60)).padStart(2, '0')}`,
      hook: '',
      reason: 'Selected by audio energy analysis — the loudest, most dynamic stretch of the video.',
      score: clamp(Math.round(50 + (candidate.score / Math.max(best, 1)) * 40), 45, 92),
      caption: '',
      hashtags: ['#shorts', '#highlights'],
      source: 'energy',
      index,
    }));
}

function makeTitle(sentence) {
  const cleaned = String(sentence || '')
    .replace(/♪/g, ' ')
    .replace(/^[^a-z0-9"']+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Untitled moment';
  const sentenceCase = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (sentenceCase.length <= 64) return sentenceCase.replace(/[.,;:]$/, '');
  return `${sentenceCase.slice(0, 61).trim()}...`;
}

function keywords(text) {
  const counts = new Map();
  for (const word of String(text).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []) {
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => `#${word.replace(/'/g, '')}`);
}

const SYSTEM_PROMPT = `You are a short-form video editor who has produced hundreds of millions of views on TikTok, Reels and Shorts.
You receive a timestamped transcript of a long video. You find the moments most likely to go viral as standalone clips.

What makes a clip work:
- A hook in the first 2 seconds: a bold claim, a question, a surprising number, or a conflict.
- One complete, self-contained idea. A viewer with no context must understand it.
- It starts on a sentence boundary and ends on the punchline, not mid-thought.
- Emotional stakes, specificity, or useful takeaways beat generic commentary.

Rules:
- Never invent timestamps or quotes. Only use times present in the transcript.
- Clips must not overlap.
- Respect the requested length range.
- Return only valid JSON.`;

function llmPrompt({ cues, options, duration, sourceTitle }) {
  const min = Math.floor(options.minSec);
  const max = Math.ceil(options.maxSec);
  const lines = [];
  let budget = 60000;
  for (const cue of cues) {
    const stamp = `${Math.floor(cue.start / 60)}:${String(Math.floor(cue.start % 60)).padStart(2, '0')}`;
    const line = `[${stamp}] ${cue.text}`;
    budget -= line.length;
    if (budget < 0) break;
    lines.push(line);
  }

  return `Source video: "${sourceTitle || 'untitled'}" (${Math.round(duration / 60)} minutes long).

Pick exactly ${options.count} clips.
Each clip must be between ${min} and ${max} seconds.
Aim for variety: do not pick two clips from the same moment.

Respond with this JSON shape:
{"clips":[{"start":12.5,"end":48.0,"title":"<=7 word clip title","hook":"the opening words that grab attention","reason":"one sentence on why this will perform","score":87,"caption":"a social caption in the speaker's voice","hashtags":["#shorts","#viral","#topic"]}]}

Timestamps are seconds from the start of the video, as numbers (not "mm:ss").
"score" is 0-100 predicted virality.

Transcript:
${lines.join('\n')}`;
}

async function llmClips({ cues, options, duration, sourceTitle }) {
  const response = await fetch(`${AI.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AI.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: AI.model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: llmPrompt({ cues, options, duration, sourceTitle }) },
      ],
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`AI selection failed (HTTP ${response.status}). ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  const parsed = typeof content === 'string' ? JSON.parse(content) : content;
  const clips = Array.isArray(parsed?.clips) ? parsed.clips : [];
  return clips;
}

function sanitizeLlmClips(raw, { duration, options, energy }) {
  const min = Math.max(5, options.minSec - 4);
  const max = options.maxSec + 6;
  const cleaned = [];

  for (const clip of raw) {
    let start = Number(clip.start);
    let end = Number(clip.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0) start = 0;
    if (end > duration) end = duration;
    if (end - start < Math.min(min, 8)) continue;
    if (end - start > max) end = start + max;
    cleaned.push({
      start: round(snapToSilence(energy, start, 1.2), 2),
      end: round(end, 2),
      title: String(clip.title || 'Untitled moment').slice(0, 90),
      hook: String(clip.hook || '').slice(0, 160),
      reason: String(clip.reason || '').slice(0, 300),
      score: clamp(Math.round(Number(clip.score) || 70), 1, 100),
      caption: String(clip.caption || clip.title || '').slice(0, 400),
      hashtags: Array.isArray(clip.hashtags)
        ? clip.hashtags.map((tag) => String(tag)).slice(0, 8)
        : [],
      source: 'ai',
    });
  }

  const kept = [];
  for (const clip of cleaned.sort((a, b) => b.score - a.score)) {
    if (kept.length >= options.count) break;
    if (kept.some((pick) => clip.start < pick.end - 3 && clip.end > pick.start + 3)) continue;
    kept.push(clip);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Choose clips. Prefers the LLM when a key is configured, falls back to a
 * transcript heuristic, and finally to pure audio energy.
 */
export async function selectClips({ cues, energy, duration, options, sourceTitle, onProgress }) {
  if (cues?.length && AI.apiKey) {
    try {
      onProgress?.('Asking the AI which moments will perform');
      const raw = await llmClips({ cues, options, duration, sourceTitle });
      const clips = sanitizeLlmClips(raw, { duration, options, energy });
      if (clips.length) return clips;
    } catch (error) {
      console.warn(`[analyze] AI selection unavailable: ${error.message}`);
    }
  }

  if (cues?.length) {
    onProgress?.('Scoring transcript for hooks and energy');
    const clips = heuristicClips({ cues, energy, options, duration });
    if (clips.length) {
      return clips.map((clip) => ({
        ...clip,
        hashtags: [...new Set([...clip.hashtags, ...keywords(clip.title)])],
      }));
    }
  }

  onProgress?.('No transcript available, ranking by audio energy');
  return energyClips({ energy, options, duration });
}
