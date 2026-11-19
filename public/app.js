const $ = (selector) => document.querySelector(selector);

const state = { mode: 'url', file: null, jobId: null, source: null, stream: null };

/* ---------- health ---------- */

fetch('/api/health')
  .then((res) => res.json())
  .then((health) => {
    const chip = $('#status');
    const text = $('#status-text');
    if (health.aiConfigured) {
      chip.classList.add('on');
      text.textContent = `AI on · ${health.model}`;
    } else {
      chip.classList.add('off');
      text.textContent = 'AI key not set · captions + audio analysis';
    }
    if (!health.ok) {
      text.textContent = 'ffmpeg missing — check the terminal';
      chip.classList.remove('off');
    }
  })
  .catch(() => {
    $('#status-text').textContent = 'server unreachable';
  });

/* ---------- mode tabs ---------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.pane;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.pane').forEach((pane) => {
      pane.classList.toggle('is-active', pane.dataset.pane === state.mode);
    });
    $('#hint').textContent = '';
  });
});

/* ---------- file picking ---------- */

const dropzone = $('#dropzone');
const fileInput = $('#file');

function setFile(file) {
  if (!file) return;
  if (file.size > 1.6e9) {
    $('#hint').textContent = 'That file is too large (limit is 1.5 GB).';
    return;
  }
  state.file = file;
  dropzone.classList.add('has-file');
  $('#dz-label').innerHTML = `<strong>${file.name}</strong><br /><small>${(file.size / 1024 ** 2).toFixed(
    0,
  )} MB — click to change</small>`;
  $('#hint').textContent = '';
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') fileInput.click();
});
fileInput.addEventListener('change', () => setFile(fileInput.files?.[0]));

['dragenter', 'dragover'].forEach((type) =>
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-over');
  }),
);
['dragleave', 'drop'].forEach((type) =>
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-over');
  }),
);
dropzone.addEventListener('drop', (event) => setFile(event.dataTransfer?.files?.[0]));

/* ---------- job ---------- */

const STAGES = ['download', 'transcribe', 'analyze', 'render'];
const STAGE_LABEL = {
  queued: 'Queued',
  prepare: 'Preparing',
  download: 'Fetching video',
  transcribe: 'Transcribing',
  analyze: 'Finding viral moments',
  render: 'Cutting and captioning',
  done: 'Done',
  error: 'Failed',
};

function setStage(activeStage) {
  const index = STAGES.indexOf(activeStage);
  document.querySelectorAll('#stages li').forEach((li) => {
    const own = STAGES.indexOf(li.dataset.stage);
    li.classList.toggle('active', activeStage === li.dataset.stage);
    li.classList.toggle('done', index > -1 && own < index);
  });
}

function renderJob(job) {
  if (!job) return;
  $('#progress').hidden = false;
  $('#percent').textContent = `${job.progress ?? 0}%`;
  $('#bar-fill').style.width = `${job.progress ?? 0}%`;
  $('#stage').textContent = job.message || STAGE_LABEL[job.stage] || 'Working…';
  setStage(job.stage);

  const log = $('#log');
  const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = (job.logs || []).map((entry) => `› ${entry.message}`).join('\n');
  if (wasAtBottom) log.scrollTop = log.scrollHeight;

  const error = $('#error');
  if (job.status === 'error') {
    error.hidden = false;
    error.textContent = job.error || 'The job failed.';
  } else {
    error.hidden = true;
  }

  if (job.clips?.length) renderClips(job);
  if (job.status === 'done' || job.status === 'error') finish(job);
}

function finish(job) {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  $('#generate').disabled = false;
  $('#generate').textContent = job.status === 'done' ? 'Generate again' : 'Try again';
}

function formatTime(seconds) {
  const total = Math.round(seconds || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderClips(job) {
  const root = $('#results');
  const aspect = job.options?.aspect || 'vertical';

  root.innerHTML = job.clips
    .map((clip, index) => {
      const src = `/files/${job.id}/${clip.file}`;
      const poster = clip.thumb ? `/files/${job.id}/${clip.thumb}` : '';
      const fullCaption = [clip.title, clip.caption].filter(Boolean).join('\n\n');
      return `
        <article class="clip">
          <div class="frame ${aspect === 'original' ? 'original-aspect' : ''}">
            <video src="${src}" ${poster ? `poster="${poster}"` : ''} controls playsinline preload="metadata"></video>
            <span class="score">${clip.score} viral score</span>
          </div>
          <div class="clip-body">
            <h3>${escapeHtml(clip.title)}</h3>
            <div class="clip-meta">${formatTime(clip.start)} → ${formatTime(clip.end)} · ${Math.round(
              clip.duration,
            )}s</div>
            ${clip.reason ? `<p class="clip-reason">${escapeHtml(clip.reason)}</p>` : ''}
            ${
              clip.hashtags?.length
                ? `<div class="tags">${clip.hashtags
                    .map((tag) => `<span>${escapeHtml(tag.startsWith('#') ? tag : `#${tag}`)}</span>`)
                    .join('')}</div>`
                : ''
            }
            <div class="clip-actions">
              <a href="${src}" download="${escapeHtml(clip.file)}">Download</a>
              <button data-copy="${index}" data-text="${escapeAttr(fullCaption)}">Copy caption</button>
            </div>
          </div>
        </article>`;
    })
    .join('');

  root.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const clip = job.clips[Number(button.dataset.copy)];
      const tags = (clip.hashtags || []).join(' ');
      const text = [clip.caption || clip.title, tags].filter(Boolean).join('\n\n');
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied!';
        setTimeout(() => {
          button.textContent = 'Copy caption';
        }, 1600);
      } catch {
        $('#hint').textContent = 'Clipboard is blocked by the browser.';
      }
    });
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, '&#10;');
}

async function submit() {
  const button = $('#generate');
  button.disabled = true;
  button.textContent = 'Working…';
  $('#results').innerHTML = '';
  $('#progress').hidden = false;
  $('#error').hidden = true;
  $('#hint').textContent = '';

  const [minSec, maxSec] = $('#length').value.split(',').map(Number);
  const options = {
    count: $('#count').value,
    minSec,
    maxSec,
    aspect: $('#aspect').value,
    captions: $('#captions').checked,
  };

  try {
    let response;
    if (state.mode === 'file') {
      if (!state.file) throw new Error('Choose a video file first.');
      const form = new FormData();
      form.append('video', state.file);
      Object.entries(options).forEach(([key, value]) => form.append(key, String(value)));
      response = await fetch('/api/jobs', { method: 'POST', body: form });
    } else {
      const url = $('#url').value.trim();
      if (!url) throw new Error('Paste a video URL first.');
      response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, ...options }),
      });
    }

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not start the job.');

    state.jobId = data.id;
    $('#bar-fill').style.width = '0%';
    $('#percent').textContent = '0%';
    $('#log').textContent = '';

    if (state.stream) state.stream.close();
    const stream = new EventSource(`/api/jobs/${data.id}/events`);
    state.stream = stream;
    stream.onmessage = (event) => {
      try {
        renderJob(JSON.parse(event.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    stream.onerror = () => {
      // The stream ends after a job finishes; only treat it as fatal if pending.
      if (stream.readyState === EventSource.CLOSED) return;
    };
  } catch (error) {
    $('#progress').hidden = false;
    $('#error').hidden = false;
    $('#error').textContent = error.message;
    button.disabled = false;
    button.textContent = 'Generate clips';
  }
}

$('#generate').addEventListener('click', submit);
$('#url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submit();
});
