import { EventEmitter } from 'node:events';

const jobs = new Map();
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function registerJob(job) {
  jobs.set(job.id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Merge a patch into a job and push it to anyone watching. */
export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  bus.emit(`job:${id}`, job);
  return job;
}

export function addLog(id, message) {
  const job = jobs.get(id);
  if (!job) return;
  job.logs.push({ at: Date.now(), message });
  if (job.logs.length > 200) job.logs.shift();
  bus.emit(`job:${id}`, job);
}

export function subscribe(id, listener) {
  const event = `job:${id}`;
  bus.on(event, listener);
  return () => bus.off(event, listener);
}

/** Only expose what the browser needs. */
export function snapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    error: job.error,
    createdAt: job.createdAt,
    source: job.source,
    options: job.options,
    clips: job.clips,
    logs: job.logs.slice(-12),
  };
}
