import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, loadSettings, saveSettings } from './settings.js';
import { httpRequest, sleep } from './lib/util.js';
import { CATEGORIES, parseListPage } from './sources/b.js';
import { requireB, siteStatus } from './sources/config.js';

/**
 * 资源库 B 的本地片库。
 * 该站的站内搜索会拦中文关键词，所以这里把分类列表页扫成本地索引：
 * 中文检索走本地内存（几十万级以内无压力），点开再实时解析详情页拿磁力。
 */

const INDEX_FILE = path.join(CONFIG_DIR, 'library.json');

let items = []; // {t,u,c,q,s}
let byUrl = new Map();
let loaded = false;

const status = {
  running: false,
  phase: 'idle',
  catDone: 0,
  catTotal: 0,
  current: '',
  added: 0,
  total: 0,
  startedAt: 0,
  finishedAt: 0,
  error: '',
};

function host() {
  return requireB().siteUrl;
}

export function loadIndex() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      items = Array.isArray(raw.items) ? raw.items : [];
      byUrl = new Map(items.map((it) => [it.u, it]));
    }
  } catch {
    items = [];
    byUrl = new Map();
  }
  status.total = items.length;
}

function persist() {
  const tmp = `${INDEX_FILE}.tmp`;
  const payload = { updated: Date.now(), items };
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
  saveSettings({ b: { count: items.length, lastSync: Date.now() } });
}

function pageUrl(cat, page) {
  return page === 1 ? `${host()}/${cat}/` : `${host()}/${cat}/index_${page}.html`;
}

export function indexStatus() {
  loadIndex();
  return { ...status, total: items.length, configured: siteStatus().b.configured };
}

export function searchIndex(keyword, limit = 60) {
  loadIndex();
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const tokens = kw.split(/\s+/).filter(Boolean);
  const hits = [];
  for (const it of items) {
    const title = it.t.toLowerCase();
    if (!tokens.every((tk) => title.includes(tk))) continue;
    let rank = 2;
    if (title === kw) rank = 0;
    else if (title.startsWith(kw)) rank = 1;
    hits.push({ rank, len: title.length, it });
  }
  hits.sort((a, b) => a.rank - b.rank || a.len - b.len);
  return hits.slice(0, limit).map(({ it }) => ({
    source: 'b',
    id: it.u,
    title: it.t,
    image: '',
    year: '',
    score: it.s || '',
    quality: it.q || '',
    tags: CATEGORIES.find((c) => c.key === it.c)?.label || it.c,
    link: it.u,
  }));
}

export async function syncIndex({ pages } = {}) {
  if (status.running) return { started: false, status };
  if (!siteStatus().b.configured) {
    return { started: false, status: { ...indexStatus(), error: '资源库 B 未接入，先在配置里填写片源地址' } };
  }
  loadIndex();
  const cfg = loadSettings().b;
  const maxPages = Math.max(1, Math.min(Number(pages) || cfg.pagesPerCategory || 40, 400));

  status.running = true;
  status.phase = 'crawling';
  status.catDone = 0;
  status.catTotal = CATEGORIES.length;
  status.added = 0;
  status.startedAt = Date.now();
  status.finishedAt = 0;
  status.error = '';

  const seen = new Set();
  const runCategory = async (cat) => {
    for (let page = 1; page <= maxPages; page += 1) {
      status.current = `${cat.label} 第 ${page} 页`;
      let html = '';
      try {
        const res = await httpRequest(pageUrl(cat.key, page), {
          headers: { Referer: `${host()}/${cat.key}/` },
          timeout: 20000,
        });
        if (res.status === 404) break;
        html = res.text;
      } catch {
        await sleep(800);
        break;
      }
      const list = parseListPage(html, cat.key);
      if (list.length === 0) break;
      let newCount = 0;
      for (const it of list) {
        if (seen.has(it.u)) continue;
        seen.add(it.u);
        const old = byUrl.get(it.u);
        if (!old) {
          byUrl.set(it.u, it);
          items.push(it);
          newCount += 1;
        }
      }
      status.added += newCount;
      if (newCount === 0 && page > 3) break; // 连续无新增，说明已经到底或重复
      await sleep(120);
    }
    status.catDone += 1;
  };

  // 3 路并发，兼顾速度与站点压力
  const queue = [...CATEGORIES];
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const cat = queue.shift();
      try {
        await runCategory(cat);
      } catch (err) {
        status.error = String(err.message || err);
      }
    }
  });

  try {
    await Promise.all(workers);
    status.phase = 'saving';
    persist();
    status.phase = 'done';
  } catch (err) {
    status.phase = 'error';
    status.error = String(err.message || err);
    try {
      persist();
    } catch {
      /* ignore */
    }
  } finally {
    status.running = false;
    status.current = '';
    status.finishedAt = Date.now();
  }
  return { started: true, status: indexStatus() };
}
