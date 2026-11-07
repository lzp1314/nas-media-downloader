import crypto from 'node:crypto';

/**
 * 极简后台任务表。
 * 磁力读种子元数据可能要几十秒，直接挂在 HTTP 请求上会被反代（30~60 秒）掐成 504；
 * 改成「立刻回任务号 + 前端轮询」，任何反代超时配置都不影响。
 */
const jobs = new Map();
const TTL = 10 * 60 * 1000;
const MAX = 60;

export function createJob(fn) {
  for (const [k, j] of jobs) if (Date.now() - j.startedAt > TTL) jobs.delete(k);
  if (jobs.size >= MAX) {
    // 只淘汰最旧的，别把正在跑的任务一起清掉
    const oldest = [...jobs.entries()]
      .sort((a, b) => a[1].startedAt - b[1].startedAt)
      .slice(0, jobs.size - MAX + 1);
    for (const [k] of oldest) jobs.delete(k);
  }
  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    state: 'running',
    startedAt: Date.now(),
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  Promise.resolve()
    .then(fn)
    .then((result) => {
      job.result = result;
      job.state = 'done';
    })
    .catch((err) => {
      job.error = String(err?.message || err);
      job.state = 'error';
    });
  return job;
}

export function getJob(id) {
  for (const [k, j] of jobs) if (Date.now() - j.startedAt > TTL) jobs.delete(k);
  return jobs.get(String(id || '')) || null;
}
