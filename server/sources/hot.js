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
 * 设计原则（不接任何第三方热播榜，默认零第三方出网）：
 *   1. 候选片名只有两个来源：程序内置的国产片单（可被配置覆盖）、使用者自己配置的数据源
 *   2. 任何词都必须「确认有源」才会显示：出现在站内对应国产分类的最新列表里，
 *      或出现在本机已同步的片库索引里。点下去不会是空结果
 *   3. 片单只负责「优先显示哪些国产新片」，最终顺序为：片单词 → 站内最新 → 本机片库
 *   4. 一律过国产中文片名闸：剔除外文、纪录片/综艺、画质与集数后缀
 *   5. 全都取不到 → 隐藏推荐区，不塞过时老片
 *
 * 缓存 3 小时，缓存新鲜时零网络请求；过期先返回旧数据、后台静默刷新；
 * 支持手动刷新（30 秒最小间隔，避免高频请求站点）。
 */

const HOT_CONFIG = path.join(CONFIG_DIR, 'hot-sources.json');
const HOT_CACHE = path.join(CONFIG_DIR, 'hot-cache.json');
const DEFAULT_TTL_HOURS = 3;
const MIN_REFRESH_GAP = 30 * 1000;
const FETCH_TIMEOUT = 8000;
const SITE_BUDGET_MS = 6000; // 每组抓分类页的总时限，避免首次启动 / 手动刷新卡住首页
const PER_GROUP = 5;

/** 只从国产相关的站内分类取片，不再碰美剧 / 韩剧 / 纪录片 / 高清等杂类 */
const GROUPS = [
  { key: 'tv', label: '热播剧集', cats: ['guochanju', 'gangju'] },
  { key: 'movie', label: '热播电影', cats: ['juqingpian', 'dongzuopian', 'gaoqing', 'xijupian'] },
  { key: 'anime', label: '热播动漫', cats: ['donghuapian'] },
];

/**
 * 内置的国产片名候选。只是「优先显示哪些词」，不是资源内容；
 * 每个词仍须在站内最新列表或本机片库里匹配到才显示。
 * 可在 config/hot-sources.json 里用 seedTitles 整组覆盖。
 */
export const DEFAULT_SEED = {
  tv: ['尚公主', '伟大的长征', '谷雨', '醉梦', '嫁金钗', '玉簟秋', '小城良方', '兰香如故', '多喜一家人', '风生水起'],
  movie: ['空枪', '八仙', '飞驰人生3', '镖人', '欢迎来龙餐馆', '神探之痕迹', '给阿嬷的情书', '年会不能停2', '捕风追影', '浪浪山小妖怪'],
  anime: ['凡人修仙传', '诛仙', '吞噬星空', '灵境行者', '仙逆', '无上神帝', '逆天至尊', '一念永恒', '狐妖小红娘', '大理寺日志'],
};

/** 榜单 / 分类页里常见的、不属于片名的修饰词 */
const NOISE = /(?:上映首日|上映\d+天|更新至\s*\d*\s*集?|全集|完结|第\s*\d+\s*集|\d+\s*集|国语|粤语|普通话|中字|字幕|HD|BD|1080P|1280P|720P|2160P|4K|8K|高清|超清|高码率|蓝光|WEB-?DL|HDR|H\.?26[45]|x\.?26[45]|HEVC|抢先版|完整版|修复版|收藏版|电视剧|电影版|票房|热搜|榜单|TOP\s*\d+)/gi;

/** 不属于「国产影视剧 / 国漫」的内容类型 */
const NOT_DOMESTIC = /(纪录片|纪实|解说|综艺|演唱会|访谈|花絮|预告|片花|幕后|特辑|MAD|AMV|OVA|剧场版|日语|中字|字幕组)/i;

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

/* ---------------- 片名清洗与国产过滤 ---------------- */

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

/**
 * 国产中文片名总闸：洗掉画质/集数后缀后，必须是中文为主的影视/动漫片名。
 * 剔除外文片、日文假名 / 韩文、纪录片 / 综艺 / 花絮等非影视内容。
 */
export function isDomesticTitle(raw) {
  const s = cleanTitle(raw);
  if (!s) return '';
  if (/[\u3040-\u30ff\uac00-\ud7af]/.test(s)) return '';
  if (NOT_DOMESTIC.test(s)) return '';
  const han = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const chars = s.replace(/\s/g, '').length || 1;
  if (han < 2 || han / chars < 0.6) return '';
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

/** 片单词必须在「已确认有源」的池子里能匹配到，否则不显示 */
function confirmed(q, pool) {
  const n = norm(q);
  if (!n) return false;
  return pool.some((p) => {
    const m = norm(p);
    return m && (m === n || m.includes(n) || n.includes(m));
  });
}

/** 配置里的 seedTitles 按组整体覆盖内置片单；留空数组表示该组不用片单 */
function seedOf(cfg) {
  const out = {};
  for (const g of GROUPS) {
    const rows = cfg.seedTitles?.[g.key];
    out[g.key] = Array.isArray(rows) ? rows : DEFAULT_SEED[g.key];
  }
  return out;
}

/* ---------------- 数据源 ---------------- */

/** 站内国产分类首页：按更新时间倒序，本身就是「当前有资源」的国产片名 */
async function fromSite(group, need) {
  const out = [];
  let siteUrl = '';
  try {
    siteUrl = String(requireB().siteUrl || '').replace(/\/+$/, '');
  } catch {
    return out;
  }
  if (!siteUrl) return out;
  const deadline = Date.now() + SITE_BUDGET_MS;
  for (const cat of group.cats) {
    if (out.length >= need || Date.now() >= deadline) break;
    try {
      const url = `${siteUrl}/${cat}/`;
      const res = await httpRequest(url, {
        headers: { Referer: url, 'User-Agent': DEFAULT_UA },
        timeout: Math.max(1500, Math.min(FETCH_TIMEOUT, deadline - Date.now())),
      });
      if (res.status !== 200) continue;
      for (const it of parseListPage(res.text, cat) || []) {
        const q = isDomesticTitle(it.t);
        if (q) out.push(q);
        if (out.length >= need) break;
      }
    } catch { /* 换下一个分类 */ }
  }
  return out;
}

async function buildGroups() {
  const cfg = loadConfig();
  const per = Math.max(2, Math.min(8, Number(cfg.perGroup) || PER_GROUP));
  const seeds = seedOf(cfg);
  const idx = recentIndexTitlesByGroup(per * 3) || {};

  // 一次抓齐三组的站内国产分类，既用于确认片单词有源，也用于补齐
  const siteLists = {};
  await Promise.all(GROUPS.map(async (g) => {
    siteLists[g.key] = await fromSite(g, per * 3);
  }));

  const groups = {};
  const sources = new Set(['本机片库']);
  for (const g of GROUPS) {
    const siteTitles = siteLists[g.key] || [];
    const idxTitles = (idx[g.key] || []).map(isDomesticTitle).filter(Boolean);
    const pool = [...new Set([...siteTitles, ...idxTitles])];
    if (siteTitles.length) sources.add('站内国产分类');

    const list = [];
    const seen = new Set();
    // 1) 片单词优先，但必须确认有源
    for (const raw of seeds[g.key]) {
      const q = isDomesticTitle(raw);
      if (q && confirmed(q, pool)) push(list, q, seen, per);
      if (list.length >= per) break;
    }
    // 2) 不足的用站内最新国产片补齐（本来就在站里，一定有源）
    for (const q of siteTitles) {
      push(list, q, seen, per);
      if (list.length >= per) break;
    }
    // 3) 再不足用本机片库里对应国产分类的片名
    for (const q of idxTitles) {
      push(list, q, seen, per);
      if (list.length >= per) break;
    }
    groups[g.key] = list;
  }
  return { groups, sources: [...sources] };
}

/* ---------------- 刷新与读取 ---------------- */

export function refreshNow() {
  if (inflight) return inflight;
  if (Date.now() - lastAttempt < MIN_REFRESH_GAP) return Promise.resolve(null);
  lastAttempt = Date.now();
  inflight = (async () => {
    const { groups, sources } = await buildGroups();
    const total = GROUPS.reduce((n, g) => n + (groups[g.key] || []).length, 0);
    if (!total) return null; // 全空不写缓存，让旧缓存 / 兜底生效
    const next = { groups, updatedAt: Date.now(), sources };
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

/** 全挂且没有缓存：只认使用者自己填的收藏片单，没有就返回空（前端隐藏推荐区） */
function fallback() {
  const custom = loadConfig().fallbackTitles || {};
  const groups = GROUPS.map((g) => {
    const rows = Array.isArray(custom) ? custom : custom[g.key];
    return {
      key: g.key,
      label: g.label,
      items: (Array.isArray(rows) ? rows : []).map(isDomesticTitle).filter(Boolean).slice(0, 5),
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
