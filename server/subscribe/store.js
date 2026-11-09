import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR, ensureConfigDir } from '../settings.js';

/**
 * 订阅表持久化。
 * 单独一个文件而不是塞进 settings.json：订阅会频繁写入（每轮检查都改 lastCheckAt / sent），
 * 和用户设置混在一起容易互相覆盖。
 */
const FILE = path.join(CONFIG_DIR, 'subscriptions.json');
const VERSION = 1;

let cache = null;

function blank() {
  return { v: VERSION, items: [] };
}

export function loadSubs() {
  if (cache) return cache;
  if (!fs.existsSync(FILE)) {
    cache = blank();
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const items = Array.isArray(raw?.items) ? raw.items : [];
    cache = { v: VERSION, items: items.map(normalize).filter(Boolean) };
  } catch {
    // 文件坏了不能整个功能瘫痪，留空继续跑，下一次保存会覆盖掉
    cache = blank();
  }
  return cache;
}

function persist() {
  ensureConfigDir();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(v, max = 200) {
  return String(v ?? '').slice(0, max);
}

/** 只接受 HH:mm，其余一律当「没填」——宁可退回全天密查，也不让脏值把调度搞乱 */
function clock(v) {
  const s = str(v, 5).trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : '';
}

/** YYYY-MM-DD，其余一律空 */
function day(v) {
  const s = str(v, 10).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * 更新日：1~7 = 周一~周日，可多选（有的剧一周更两天）。
 * 去重、排序、丢弃越界值——脏值会让调度算出「永远不在窗口内」。
 */
function days(v) {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const set = new Set();
  for (const x of arr) {
    const d = Math.floor(num(x));
    if (d >= 1 && d <= 7) set.add(d);
  }
  return [...set].sort((a, b) => a - b);
}

/** TMDB 缓存：形状固定，字段缺了就当不知道，别让界面渲染出 undefined */
function normalizeTmdbMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    at: num(raw.at),
    name: str(raw.name, 120),
    status: str(raw.status, 40),
    statusCn: str(raw.statusCn, 20),
    totalEpisodes: Math.max(0, num(raw.totalEpisodes)),
    // 多季剧的集号会重复（每季都从 1 开始），显示时要带季号才不歧义
    totalSeasons: Math.max(0, num(raw.totalSeasons)),
    nextAirDate: day(raw.nextAirDate),
    nextAirEpisode: Math.max(0, num(raw.nextAirEpisode)),
    nextAirSeason: Math.max(0, num(raw.nextAirSeason)),
    lastAirDate: day(raw.lastAirDate),
    lastAirEpisode: Math.max(0, num(raw.lastAirEpisode)),
  };
}

/** 把外部传入的对象收成固定形状，脏数据一律丢弃而不是抛错 */
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title, 120).trim();
  if (!title) return null;
  const id = str(raw.id, 40).trim() || `sub_${crypto.randomBytes(5).toString('hex')}`;
  const dir = str(raw.dir, 400).trim();
  if (!dir) return null;
  const aliases = Array.isArray(raw.aliases)
    ? [...new Set(raw.aliases.map((x) => str(x, 80).trim()).filter(Boolean))].slice(0, 8)
    : [];
  // 新版存数组（一周更两天能都填上）；老数据只有单值 updateDay，迁移到数组里
  const updateDays = days(raw.updateDays);
  if (!updateDays.length) {
    const one = Math.min(7, Math.max(0, Math.floor(num(raw.updateDay))));
    if (one) updateDays.push(one);
  }

  const sent = raw.sent && typeof raw.sent === 'object' && !Array.isArray(raw.sent) ? raw.sent : {};
  const cleanSent = {};
  for (const [k, v] of Object.entries(sent)) {
    const ep = Number(k);
    if (!Number.isInteger(ep) || ep <= 0) continue;
    cleanSent[ep] = {
      at: num(v?.at),
      name: str(v?.name, 200),
      hash: str(v?.hash, 60),
      state: v?.state === 'failed' ? 'failed' : 'ok',
      tries: num(v?.tries),
      note: str(v?.note, 200),
    };
  }
  return {
    id,
    title,
    keyword: str(raw.keyword, 120).trim() || title,
    aliases,
    doubanId: str(raw.doubanId, 20).trim(),
    // TMDB 条目 id：有了它才能拿「总集数 / 下一集播出日」，没有也不影响补集
    tmdbId: Number(raw.tmdbId) > 0 ? Math.floor(Number(raw.tmdbId)) : 0,
    // TMDB 元数据是程序维护的缓存，不让前端直接写，避免界面把过期数据又塞回来
    tmdbMeta: normalizeTmdbMeta(raw.tmdbMeta),
    totalEpisodes: Math.max(0, num(raw.totalEpisodes)),
    dir,
    startEpisode: Math.max(1, num(raw.startEpisode, 1)),
    endEpisode: Math.max(0, num(raw.endEpisode)),
    quality: [2160, 1080, 720, 480].includes(Number(raw.quality)) ? Number(raw.quality) : 1080,
    // 更新日：1~7=周一~周日，可多选。空数组=不指定（匀速轮询）
    updateDays,
    // 旧字段留着，值取第一天，方便只看单值的旧代码和测试继续跑
    updateDay: updateDays[0] || 0,
    // 更新时刻：填了才按「这个点之后才开始密查」，留空则更新日整天密查（老行为）
    updateTime: clock(raw.updateTime),
    // 每晚更新几集：一晚两集的剧，一次检查要能一起下，卡片上也写清楚
    episodesPerNight: Math.min(3, Math.max(1, Math.floor(num(raw.episodesPerNight, 1)))),
    enabled: raw.enabled !== false,
    createdAt: num(raw.createdAt, Date.now()),
    lastCheckAt: num(raw.lastCheckAt),
    lastResult: str(raw.lastResult, 300),
    nextCheckAt: num(raw.nextCheckAt),
    failCount: num(raw.failCount),
    sent: cleanSent,
    log: Array.isArray(raw.log)
      ? raw.log
          .filter((x) => x && typeof x === 'object')
          .slice(-30)
          .map((x) => ({ at: num(x.at), text: str(x.text, 300) }))
      : [],
  };
}

export function listSubs() {
  return loadSubs().items;
}

export function getSub(id) {
  return loadSubs().items.find((s) => s.id === String(id || '')) || null;
}

export function addSub(input) {
  const item = normalize(input);
  if (!item) throw new Error('订阅信息不完整（剧名和目标目录必填）');
  const db = loadSubs();
  if (db.items.some((s) => s.id === item.id)) throw new Error('订阅已存在');
  db.items.push(item);
  persist();
  return item;
}

/** 只允许改这几项，其余（sent/log/统计）由程序维护，避免前端误写 */
const EDITABLE = ['title', 'keyword', 'aliases', 'doubanId', 'tmdbId', 'totalEpisodes', 'dir', 'startEpisode', 'endEpisode', 'quality', 'updateDays', 'updateDay', 'updateTime', 'episodesPerNight', 'enabled'];

export function updateSub(id, patch) {
  const db = loadSubs();
  const item = db.items.find((s) => s.id === String(id || ''));
  if (!item) throw new Error('订阅不存在');
  const clean = {};
  for (const k of EDITABLE) if (patch && k in patch) clean[k] = patch[k];
  // 解绑 TMDB 时把缓存一起清掉：留着的话卡片还会显示上一部剧的「下一集」
  if ('tmdbId' in clean && !Number(clean.tmdbId)) clean.tmdbMeta = null;
  // 只发 updateDay（单值）的老前端：转成数组，否则会被已存的 updateDays 压住改了不生效
  if ('updateDay' in clean && !('updateDays' in clean)) {
    const one = Math.floor(Number(clean.updateDay)) || 0;
    clean.updateDays = one >= 1 && one <= 7 ? [one] : [];
  }
  const next = normalize({ ...item, ...clean, id: item.id, sent: item.sent, log: item.log });
  if (!next) throw new Error('修改后的订阅信息不合法');
  Object.assign(item, next);
  persist();
  return item;
}

export function removeSub(id) {
  const db = loadSubs();
  const i = db.items.findIndex((s) => s.id === String(id || ''));
  if (i === -1) throw new Error('订阅不存在');
  const [removed] = db.items.splice(i, 1);
  persist();
  return removed;
}

/** 程序内部更新（记录下发结果、日志、下次检查时间） */
export function patchSub(id, patch) {
  const db = loadSubs();
  const item = db.items.find((s) => s.id === String(id || ''));
  if (!item) return null;
  Object.assign(item, patch);
  persist();
  return item;
}

export function pushLog(item, text) {
  if (!item.log) item.log = [];
  item.log.push({ at: Date.now(), text: String(text).slice(0, 300) });
  if (item.log.length > 30) item.log = item.log.slice(-30);
}

/** 测试用：丢掉内存缓存，强制回读文件 */
export function _resetSubs() {
  cache = null;
}

export { FILE as SUBS_FILE };
