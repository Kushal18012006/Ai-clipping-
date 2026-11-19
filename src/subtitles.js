import fs from 'node:fs/promises';
import { round } from './util.js';

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;

function parseTimestamp(value) {
  const match = String(value).trim().match(TIMESTAMP);
  if (!match) return null;
  const [, h = '0', m, s, ms] = match;
  const millis = Number(ms.padEnd(3, '0').slice(0, 3));
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + millis / 1000;
}

function cleanText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJson3(raw) {
  const data = JSON.parse(raw);
  const cues = [];
  for (const event of data.events || []) {
    if (!event.segs) continue;
    const text = cleanText(event.segs.map((seg) => seg.utf8 || '').join(''));
    if (!text) continue;
    const start = Number(event.tStartMs) / 1000;
    const end = start + Number(event.dDurationMs || 0) / 1000;
    cues.push({ start, end, text });
  }
  return cues;
}

function parseVtt(raw) {
  const cues = [];
  const blocks = raw.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;
    const [from, to] = lines[timingIndex].split('-->');
    const start = parseTimestamp(from?.split(' ')[0]);
    const end = parseTimestamp(to?.trim().split(' ')[0]);
    if (start == null || end == null) continue;
    const text = cleanText(lines.slice(timingIndex + 1).join(' '));
    if (!text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

/**
 * YouTube's auto-captions arrive as heavily overlapping rolling cues. Collapse
 * them into one clean line per time span so the LLM sees readable sentences.
 */
function dedupeRolling(cues) {
  const out = [];
  for (const cue of cues) {
    const last = out[out.length - 1];
    if (last && last.text === cue.text) {
      last.end = Math.max(last.end, cue.end);
      continue;
    }
    if (last && cue.start < last.end && cue.text.startsWith(last.text) && cue.text.length > last.text.length) {
      last.text = cue.text;
      last.end = Math.max(last.end, cue.end);
      continue;
    }
    if (last && last.text.includes(cue.text) && cue.end - cue.start < 3) {
      last.end = Math.max(last.end, cue.end);
      continue;
    }
    out.push({ ...cue });
  }
  return out.filter((cue) => cue.text.replace(/[^\w]/g, '').length > 1);
}

export async function readSubtitles(file) {
  const raw = await fs.readFile(file, 'utf8');
  let cues = [];
  if (/^\s*\{/.test(raw)) {
    cues = parseJson3(raw);
  } else if (/WEBVTT|-->/.test(raw)) {
    cues = parseVtt(raw);
  } else if (/\d+\s*\n\d{2}:\d{2}/.test(raw)) {
    cues = parseVtt(raw.replace(/,(\d{3})/g, '.$1'));
  }

  cues = cues
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.text)
    .map((cue) => ({ start: round(cue.start, 2), end: round(cue.end, 2), text: cue.text }))
    .sort((a, b) => a.start - b.start);

  return dedupeRolling(cues);
}

/** Merge short cues into ~12 second paragraphs that fit comfortably in a prompt. */
export function toParagraphs(cues, windowSec = 12) {
  const paragraphs = [];
  let current = null;
  for (const cue of cues) {
    if (!current) {
      current = { start: cue.start, end: cue.end, text: cue.text };
      continue;
    }
    if (cue.start - current.start > windowSec || /[.!?]$/.test(current.text)) {
      paragraphs.push(current);
      current = { start: cue.start, end: cue.end, text: cue.text };
    } else {
      current.text = `${current.text} ${cue.text}`;
      current.end = cue.end;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

export function transcriptText(cues, limit = 90000) {
  const parts = [];
  let size = 0;
  for (const cue of cues) {
    const stamp = `${Math.floor(cue.start / 60)}:${String(Math.floor(cue.start % 60)).padStart(2, '0')}`;
    const line = `[${stamp}] ${cue.text}`;
    size += line.length;
    if (size > limit) break;
    parts.push(line);
  }
  return parts.join('\n');
}
