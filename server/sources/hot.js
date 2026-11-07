import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../settings.js';
import { recentIndexTitlesByGroup, _resetIndex } from '../indexer.js';
import { decodeEntities, httpRequest, DEFAULT_UA } from '../lib/util.js';
import { parseListPage } from './b.js';
import { requireB } from './config.js';

/**
 * 首页「正在热播」推荐词：热播剧集 / 热播电影 / 热播动漫，每组若干个。
 *
 * 不用院线票房榜 —— 刚上映的院线片在资源站里基本没有源，点下去是空的。
 * 这里取的是「各平台正在播、资源站刚收录」的内容：
 *   1. 本地片库索引按 movie / tv / anime 分组取最近收录（零请求，100% 有资源）
 *   2. 某组不够时，实时抓站内对应分类首页补齐
 *   3. 可选：打开 usePublicChart 后，剧集组前面插入公开电视剧榜的片名
 *   4. 全都没有 → 隐藏推荐区，不塞过时的老片
 *
 * 缓存 3 小时，缓存新鲜时零网络请求；过期先返回旧数据、后台静默刷新；
 * 支持手动刷新（30 秒最小间隔，避免高频请求站点）。
 */

const HOT_CONFIG = path.join(CONFIG_DIR, 'hot-sources.json');
const HOT_CACHE = path.join(CONFIG_DIR, 'hot-cache.json');
const DEFAULT_TTL_HOURS = 3;
const MIN_REFRESH_GAP = 30 * 1000;
const FETCH_TIMEOUT = 8000;
const PER_GROUP = 5;

const GROUPS = [
  { key: 'tv', label: '热播剧集', cats: ['guochanju', 'hanju', 'oumeiju'] },
  { key: 'movie', label: '热播电影', cats: ['dongzuopian', 'gaoqing', 'kehuanpian'] },
  { key: 'anime', label: '热播动漫', cats: ['donghuapian'] },
];

/** 榜单 / 分类页里常见的、不属于片名的修饰词 */
const NOISE = /(?:上映首日|上映\d+天|更新至\s*\d*\s*集?|全集|完结|第\s*\d+\s*集|\d+\s*集|国语|粤语|普通话|中字|字幕|HD|BD|1080P|720P|2160P|4K|蓝光|抢先版|完整版|电视剧|电影版|票房|热搜|榜单|TOP\s*\d+)/gi;

let cache = null;          // { groups: { tv, movie, anime }, updatedAt, sources }
let cacheLoaded = false;
let inflight = null;
let lastAttempt = 0;

/* ---------------- 配置与缓存 ---------------- */

function loadConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(HOT_CONFIG, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch { /* 没配就用默认 */ }
  return {};
}

function readCache() {
  if (cacheLoaded) return cache;
  cacheLoaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(HOT_CACHE, 'utf8'));
    if (j && j.groups && typeof j.groups === 'object') {
      cache = { groups: j.groups, updatedAt: Number(j.updatedAt) || 0, sources: j.sources || [] };
    }
  } catch { /* 没有缓存文件是正常的 */ }
  return cache;
}

async function persist(c) {
  try {
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    await fsp.writeFile(HOT_CACHE, JSON.stringify(c), 'utf8');
  } catch { /* 只读环境不影响使用 */ }
}

/* ---------------- 片名清洗 ---------------- */

/** 把分类页 / 榜单条目洗成可以直接塞进搜索框的片名 */
export function cleanTitle(raw) {
  let s = decodeEntities(String(raw ?? ''));
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/[（(【\[][^）)】\]]{0,24}[）)】\]]/g, ' '); // 括号里多为年份 / 清晰度
  s = s.replace(NOISE, ' ');
  s = s.replace(/^\s*\d+\s*[.、:：]?\s*/, ''); // 排名前缀
  s = s.replace(/[·•|｜_—–\-:：!！?？,，。.、/\\]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 24) return '';
  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  if (/^\d+$/.test(s)) return '';
  return s;
}

function norm(q) {
  return String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function push(list, q, seen, per) {
  const key = norm(q);
  if (!key || seen.has(key) || list.length >= per) return;
  seen.add(key);
  list.push(q);
}

/** 公开榜单结构解析（可选增强用） */
export function pickTitles(json) {
  if (!json || typeof json !== 'object') return [];
  const rows = json?.data?.list || json?.data?.items || json?.data || json?.list || json?.items;
  if (!Array.isArray(rows)) return [];
  const keys = ['name', 'title', 'movieName', 'word', 'keyword', 'query'];
  return rows
    .map((r) => (typeof r === 'string' ? r : keys.map((k) => r?.[k]).find((v) => typeof v === 'string' && v.trim())))
    .filter((v) => typeof v === 'string' && v.trim());
}

/* ---------------- 数据源 ---------------- */

/** 站内分类首页：拿当前最新收录的片名（片库还没同步时也能用） */
async function fromSite(group, need) {
  const out = [];
  let siteUrl = '';
  try {
    siteUrl = String(requireB().siteUrl || '').replace(/\/+$/, '');
  } catch {
    return out;
  }
  if (!siteUrl) return out;
  for (const cat of group.cats) {
    if (out.length >= need) break;
    try {
      const url = `${siteUrl}/${cat}/`;
      const res = await httpRequest(url, {
        headers: { Referer: url, 'User-Agent': DEFAULT_UA },
        timeout: FETCH_TIMEOUT,
      });
      if (res.status !== 200) continue;
      for (const it of parseListPage(res.text, cat) || []) {
        const q = cleanTitle(it.t);
        if (q) out.push(q);
        if (out.length >= need * 2) break;
      }
    } catch { /* 换下一个分类 */ }
  }
  return out;
}

/** 可选：公开电视剧榜。地址只能来自配置或环境变量，没填就完全不出网 */
async function fromPublicTv(need) {
  const url = process.env.HOT_TV_URL || loadConfig().publicChartUrl;
  if (!/^https?:\/\//i.test(String(url || ''))) return [];
  try {
    const res = await fetch(String(url), {
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    return pickTitles(await res.json()).map(cleanTitle).filter(Boolean).slice(0, need);
  } catch {
    return [];
  }
}

async function buildGroups() {
  const cfg = loadConfig();
  const per = Math.max(2, Math.min(8, Number(cfg.perGroup) || PER_GROUP));
  const idx = recentIndexTitlesByGroup(per * 2) || {};
  const out = {};

  for (const g of GROUPS) {
    const list = [];
    const seen = new Set();
    if (g.key === 'tv' && cfg.usePublicChart === true) {
      for (const q of await fromPublicTv(per)) push(list, q, seen, per);
    }
    for (const raw of idx[g.key] || []) {
      const q = cleanTitle(raw);
      if (q) push(list, q, seen, per);
      if (list.length >= per) break;
    }
    out[g.key] = { list, seen };
  }

  // 不足的组去站内分类首页补齐
  const needy = GROUPS.filter((g) => out[g.key].list.length < per);
  await Promise.all(
    needy.map(async (g) => {
      const extra = await fromSite(g, per - out[g.key].list.length + 2);
      for (const q of extra) push(out[g.key].list, q, out[g.key].seen, per);
    }),
  );

  const groups = {};
  for (const g of GROUPS) groups[g.key] = out[g.key].list;
  return groups;
}

/* ---------------- 刷新与读取 ---------------- */

export function refreshNow() {
  if (inflight) return inflight;
  if (Date.now() - lastAttempt < MIN_REFRESH_GAP) return Promise.resolve(null);
  lastAttempt = Date.now();
  inflight = (async () => {
    const groups = await buildGroups();
    const total = GROUPS.reduce((n, g) => n + (groups[g.key] || []).length, 0);
    if (!total) return null; // 全空不写缓存，让旧缓存 / 兜底生效
    const next = { groups, updatedAt: Date.now(), sources: ['站内最新收录'] };
    cache = next;
    await persist(next);
    return next;
  })()
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

function wrap(c, stale) {
  const src = c?.groups || {};
  return {
    ok: true,
    groups: GROUPS.map((g) => ({ key: g.key, label: g.label, items: src[g.key] || [] }))
      .filter((g) => g.items.length),
    updatedAt: c?.updatedAt || 0,
    sources: c?.sources || [],
    stale: Boolean(stale),
    fallback: false,
  };
}

/** 全挂且没有缓存：只认配置里自填的片单，没有就返回空（前端隐藏推荐区） */
function fallback() {
  const cfg = loadConfig();
  const custom = cfg.fallbackTitles || {};
  const groups = GROUPS.map((g) => {
    const rows = Array.isArray(custom) ? custom : custom[g.key];
    return {
      key: g.key,
      label: g.label,
      items: (Array.isArray(rows) ? rows : []).map(cleanTitle).filter(Boolean).slice(0, 5),
    };
  }).filter((g) => g.items.length);
  return { ok: true, groups, updatedAt: 0, sources: [], stale: false, fallback: true };
}

/**
 *  - refresh=true：等一次真实刷新（30 秒保护），失败退回旧缓存 / 兜底
 *  - 缓存新鲜：零网络请求直接返回
 *  - 缓存过期：先返回旧数据并后台刷新，下次打开就是新的
 *  - 首次启动无缓存：等一次刷新
 */
export async function getHot({ refresh = false } = {}) {
  const c = readCache();
  const ttl = Math.max(1, Number(loadConfig().ttlHours) || DEFAULT_TTL_HOURS) * 3600 * 1000;
  const fresh = c && Date.now() - c.updatedAt < ttl;

  if (refresh) {
    const r = await refreshNow();
    if (r) return wrap(r, false);
    if (c) return wrap(c, true);
    return fallback();
  }
  if (fresh) return wrap(c, false);
  if (c) {
    void refreshNow(); // 后台静默更新，不拖慢首页
    return wrap(c, true);
  }
  const r = await refreshNow();
  if (r) return wrap(r, false);
  return fallback();
}

/** 仅供测试：清掉内存态 */
export function _resetHot() {
  cache = null;
  cacheLoaded = false;
  inflight = null;
  lastAttempt = 0;
  _resetIndex();
}
