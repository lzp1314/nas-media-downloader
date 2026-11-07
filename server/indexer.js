import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, loadSettings, saveSettings } from './settings.js';
import { httpRequest, sleep } from './lib/util.js';
import { CATEGORIES, parseListPage } from './sources/b.js';
import { requireB, siteStatus } from './sources/config.js';

/**
 * 资源库 B 的本地片库（兜底索引）。
 * 站内实时搜索为主，这里保留一份分类列表索引：站点抖动、搜索被拦、
 * 或用户搜的是别名时，仍能给出结果；点开后一样走实时详情页取磁力。
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

/** 标题归一化：忽略空格、标点、全角数字，解决「金刚狼 2」与「金刚狼2」这类差异 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000·:：\-—_()（）[\]【】《》.,，。!！?？'"“”‘’/\\|]/g, '');
}

export function searchIndex(keyword, limit = 60) {
  loadIndex();
  const kw = norm(keyword);
  if (!kw) return [];
  const tokens = String(keyword || '').trim().toLowerCase().split(/\s+/).filter(Boolean).map(norm).filter(Boolean);
  const hits = [];
  for (const it of items) {
    const nt = norm(it.t);
    if (!nt) continue;
    if (!(tokens.length ? tokens.every((tk) => nt.includes(tk)) : nt.includes(kw))) continue;
    let rank = 2;
    if (nt === kw) rank = 0;
    else if (nt.startsWith(kw)) rank = 1;
    hits.push({ rank, len: nt.length, it });
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

/** 仅供测试：清掉内存索引，强制下次重新读文件 */
export function _resetIndex() {
  loaded = false;
  items = [];
  byUrl = new Map();
}

/** 按 movie / tv / anime 取最近收录的片名，供首页热播推荐用（点下去一定能搜到） */
/** 首页推荐只从国产相关分类取片；索引按分类顺序 + 页序追加，靠前的即各分类最新一页 */
const HOT_CATS = {
  tv: ['guochanju', 'gangju', 'taiwanju'],
  movie: ['dongzuopian', 'xijupian', 'aiqingpian', 'kehuanpian', 'kongbupian', 'zhanzhengpian', 'juqingpian', 'gaoqing', 'weidianying'],
  anime: ['donghuapian'],
};

export function recentIndexTitlesByGroup(limitPerGroup = 5) {
  loadIndex();
  const catGroup = new Map();
  for (const [g, cats] of Object.entries(HOT_CATS)) for (const c of cats) catGroup.set(c, g);
  const out = { movie: [], tv: [], anime: [] };
  const seen = new Set();
  for (let i = 0; i < items.length; i += 1) {
    if (out.movie.length >= limitPerGroup && out.tv.length >= limitPerGroup && out.anime.length >= limitPerGroup) break;
    const it = items[i];
    const g = catGroup.get(it.c);
    if (!g || out[g].length >= limitPerGroup) continue;
    const t = String(it.t || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out[g].push(t);
  }
  return out;
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
  const firstRun = items.length === 0;
  const runCategory = async (cat) => {
    let emptyPages = 0;
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
      // 只有首次全量同步才允许提前收尾；增量同步要扫到底，否则新片容易被漏掉
      if (firstRun && newCount === 0 && ++emptyPages >= 4) break;
      if (newCount > 0) emptyPages = 0;
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

/**
 * 后台启动同步并立刻回包。
 * 旧实现把整轮爬取 await 在 HTTP 请求里，浏览器要等几分钟才收到响应，
 * 进度轮询根本没机会启动，反代还会把这个长请求掐成 504。
 */
export function startIndexSync({ pages } = {}) {
  if (status.running) return { started: false, status: indexStatus() };
  if (!siteStatus().b.configured) {
    return { started: false, status: { ...indexStatus(), error: '资源库 B 未接入，先在配置里填写片源地址' } };
  }
  syncIndex({ pages }).catch((err) => {
    status.phase = 'error';
    status.error = String(err?.message || err);
    status.running = false;
    status.current = '';
    status.finishedAt = Date.now();
  });
  return { started: true, status: { ...indexStatus(), running: true, current: status.current || '准备中…' } };
}
