import fsp from 'node:fs/promises';
import path from 'node:path';
import { httpRequest, DEFAULT_UA } from '../lib/util.js';
import { parseTorrentMeta } from '../lib/bencode.js';
import { allowedRoots, loadSettings } from '../settings.js';
import { listSubs, getSub, patchSub, pushLog } from './store.js';
import { scanEpisodes, missingEpisodes } from './episodes.js';
import { buildEpisodeIndex, findSourceForEpisode, targetUpperBound } from './matcher.js';
import { routeFor } from '../engine/index.js';
import { tmdbReady, tvDetail } from '../sources/tmdb.js';

/**
 * 订阅执行器。
 *
 * 一次检查 = 扫本地 → 搜站点 → 算缺集 → 只下缺的那几集。
 * 设计上刻意保守：单次最多下 maxPerRun 集、每天总量有上限、失败指数退避——
 * 资源站会限流，用户已经被封过一次，宁可慢一点也不能把站点打爆。
 */

const running = new Set(); // 同一订阅不允许并发跑
let daily = { day: '', count: 0 };

/** 本地日期（不是 UTC）：按 UTC 算的话北京时间早上 8 点才翻篇，半夜会莫名其妙「到上限」 */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function bumpDaily() {
  const d = today();
  if (daily.day !== d) daily = { day: d, count: 0 };
  daily.count += 1;
  return daily.count;
}

function dailyUsed() {
  if (daily.day !== today()) return 0;
  return daily.count;
}

export function subStats() {
  const s = loadSettings().subscribe || {};
  return { running: [...running], dailyUsed: dailyUsed(), dailyLimit: s.dailyLimit || 36 };
}

/** 目标目录必须在允许的片库根目录内，避免被当成任意路径写入 */
function resolveDir(dir) {
  const abs = path.resolve(String(dir || ''));
  const roots = allowedRoots();
  const ok = roots.some((r) => abs === path.resolve(r) || abs.startsWith(`${path.resolve(r)}${path.sep}`));
  return ok ? abs : '';
}

/** 站点只给 .torrent 时，取回种子换成磁力（复用 bencode 的 hash + tracker） */
async function magnetFromTorrentUrl(url) {
  const res = await httpRequest(url, {
    binary: true,
    headers: { Referer: new URL(url).origin + '/', 'User-Agent': DEFAULT_UA },
    timeout: 25000,
  });
  const buf = res.buffer || Buffer.alloc(0);
  if (res.status !== 200 || buf.length < 20 || buf[0] !== 0x64) {
    throw new Error('种子文件没取到（站点可能需要登录）');
  }
  const meta = parseTorrentMeta(buf);
  return { magnet: meta.magnet, hash: meta.hash };
}

function backoffMinutes(base, fails) {
  const step = Math.min(6, Math.max(0, fails));
  return Math.min(360, base * 2 ** step);
}

/** 1=周一 … 7=周日（JS 的 getDay() 里 0 是周日，这里换成人话口径） */
export function weekdayOf(ts = Date.now()) {
  return new Date(ts).getDay() || 7;
}

/**
 * "2026-11-13" → 1~7（周一~周日），格式不对返回 0。
 * 不用 new Date(str)：那样会按 UTC 解析，西半球时区会整体退一天。
 */
export function weekdayOfDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) ? 0 : d.getDay() || 7;
}

/**
 * TMDB 元数据缓存 12 小时。
 * 总集数和播出日历不会在一小时内变，但也不能永远不更新——
 * 12 小时等于「一天问两次」，对 TMDB 几乎无感，又能跟上临时改档。
 */
const TMDB_TTL = 12 * 3600 * 1000;

/** 拿一次 TMDB 元数据（优先用落盘缓存）。失败不抛，交给调用方降级。 */
async function ensureTmdbMeta(sub) {
  if (!sub.tmdbId || !tmdbReady()) return null;
  const cached = sub.tmdbMeta;
  if (cached && cached.at && Date.now() - cached.at < TMDB_TTL) return cached;
  const d = await tvDetail(sub.tmdbId);
  return {
    at: Date.now(),
    name: d.name,
    status: d.status,
    statusCn: d.statusCn,
    totalEpisodes: d.totalEpisodes,
    totalSeasons: d.totalSeasons,
    nextAirDate: d.nextAirDate,
    nextAirEpisode: d.nextAirEpisode,
    nextAirSeason: d.nextAirSeason,
    lastAirDate: d.lastAirDate,
    lastAirEpisode: d.lastAirEpisode,
  };
}

/** 服务器本地时区当天 0 点（NAS 是 Asia/Shanghai，跨时区部署也按本机时间算） */
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "20:30" → 时+分；不合法返回 null（= 没填） */
export function parseClock(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? '').trim());
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

/**
 * 密查窗口长度。番剧 20:00 更新、压制组常常 22~24 点才传完，
 * 6 小时足够覆盖；第二天同一时段再开一段，专门对付「隔天补传」。
 */
export const WINDOW_HOURS = 6;

function dayNoon(ts) {
  // 用正午判定星期，避免 0 点/23:59 落在边界上翻车
  return weekdayOf(startOfDay(ts) + 12 * 3600 * 1000);
}

function windowSpan(sub) {
  const day = Number(sub?.updateDay) || 0;
  const clockTime = parseClock(sub?.updateTime);
  if (day < 1 || day > 7 || !clockTime) return null;
  return {
    days: [day, (day % 7) + 1], // 更新日 + 次日
    offset: (clockTime.h * 60 + clockTime.m) * 60 * 1000,
    len: WINDOW_HOURS * 3600 * 1000,
  };
}

/** 当前是否处于「更新日的更新时段」——只有填了具体时刻才算，否则交给老规则 */
export function inUpdateWindow(sub, nowTs = Date.now()) {
  const span = windowSpan(sub);
  if (!span) return false;
  const today0 = startOfDay(nowTs);
  // 回看一天：23:50 起步的窗口会跨过零点延伸到现在
  for (const back of [0, 1]) {
    const base = today0 - back * 86400000;
    if (!span.days.includes(dayNoon(base))) continue;
    const s = base + span.offset;
    if (nowTs >= s && nowTs < s + span.len) return true;
  }
  return false;
}

/** 下一个密查窗口的起点时间戳；没有可用窗口返回 0 */
export function nextWindowStart(sub, nowTs = Date.now()) {
  const span = windowSpan(sub);
  if (!span) return 0;
  const today0 = startOfDay(nowTs);
  for (let i = 0; i < 9; i += 1) {
    const base = today0 + i * 86400000;
    if (!span.days.includes(dayNoon(base))) continue;
    const s = base + span.offset;
    if (s > nowTs) return s;
  }
  return 0;
}

/**
 * 下次检查间隔（分钟）。
 *
 * 周更番剧（比如每周六更新）如果按 60 分钟平铺轮询，一周要白跑 160 多次，
 * 而真正可能出新的只有更新日前后。所以：
 *   - 没填更新日 → 老样子匀速
 *   - 填了更新日、没填时刻 → 更新日和次日（对付延迟上传）整天密查，其余降到 6 小时一次
 *   - 填了更新日 + 时刻 → 只在「那个点起 6 小时」和「次日同一段」密查，其余低频
 * 站点只看得到「更新日」「更新时刻」这两个信号，比按日历定点更稳：晚发两小时也不会空等。
 */
export function nextDelay(sub, cfg = {}, nowTs = Date.now()) {
  const base = Math.max(10, Number(cfg.intervalMinutes) || 60);
  const day = Number(sub?.updateDay) || 0;
  if (day < 1 || day > 7) return base;

  const updateInt = Math.max(10, Number(cfg.updateIntervalMinutes) || 30);
  const offInt = Math.max(base, Number(cfg.offIntervalMinutes) || 360);

  if (!parseClock(sub?.updateTime)) {
    const wd = weekdayOf(nowTs);
    const dayAfter = (day % 7) + 1;
    if (wd === day || wd === dayAfter) return Math.max(10, Math.min(base, updateInt));
    return offInt;
  }

  if (inUpdateWindow(sub, nowTs)) return updateInt;

  // 窗口外：如果下一个窗口比「低频间隔」来得更早，就精确睡到窗口开始，
  // 否则 19:00 检查完设成 01:00，整段 20:00 的发布高峰就被跳过了。
  const start = nextWindowStart(sub, nowTs);
  if (start) {
    const mins = Math.ceil((start - nowTs) / 60000);
    if (mins > 0 && mins < offInt) return Math.max(1, mins);
  }
  return offInt;
}

/**
 * 跑一次某个订阅的检查。
 * @returns {{ok:boolean, message:string, downloaded:number, summary:object}}
 */
export async function runCheck(id, { force = false } = {}) {
  const sub = getSub(id);
  if (!sub) throw new Error('订阅不存在');
  if (running.has(sub.id)) throw new Error('这个订阅正在检查中，稍等');

  const cfg = loadSettings().subscribe || {};
  const dir = resolveDir(sub.dir);
  if (!dir) throw new Error(`目标目录不在允许的片库内：${sub.dir}`);
  // 片库根不能当订阅目录：扫的是「这部剧的文件夹」，不是整库。
  // 选到根目录会把全库文件当成同一部剧，集数变成几十上百集的无意义并集。
  if (allowedRoots().some((r) => path.resolve(r) === dir)) {
    throw new Error(`保存目录是片库根目录（${dir}），请改成这部剧自己的文件夹`);
  }

  running.add(sub.id);
  const notes = [];
  try {
    await fsp.mkdir(dir, { recursive: true });
    const have = await scanEpisodes(dir);
    // 目录选得太上层（比如选到了分类目录甚至片库根）时，文件数会远多于集数，
    // 这时补集没意义——先把原因说清楚，比闷头下一堆错集强
    if (have.files >= 20 && have.files > have.episodes.length * 3) {
      notes.push(
        `扫到 ${have.files} 个视频文件，只认出 ${have.episodes.length} 集：保存目录可能选得太上层，建议直接选到这部剧的文件夹`,
      );
    }

    // TMDB 元数据：只用来补「总集数」和「下一集播出日」。
    // 拿不到就按站点/本地的老路走，绝不能因为它把整次检查搞挂。
    let tm = sub.tmdbMeta || null;
    if (sub.tmdbId) {
      if (!tmdbReady()) {
        notes.push('这个订阅绑了 TMDB 条目，但设置里没填密钥，元数据先跳过');
      } else {
        try {
          tm = await ensureTmdbMeta(sub);
        } catch (err) {
          notes.push(`TMDB：${String(err.message || err).slice(0, 90)}`);
        }
      }
    }

    const built = await buildEpisodeIndex(sub, { pages: 2 });
    notes.push(...built.notes);

    const to = targetUpperBound(sub, {
      tmdbTotal: tm?.totalEpisodes || 0,
      siteTotal: built.siteTotal,
      maxEp: built.maxEp,
      have: have.episodes,
    });

    // 用户没填更新日、TMDB 又知道下一集哪天播 → 替他填上，调度自动变成「那天密查」。
    // 只在用户没填时做：填了就是用户的意思，不能被 TMDB 覆盖。
    let autoDay = 0;
    if (!sub.updateDay && tm?.nextAirDate) {
      const wd = weekdayOfDate(tm.nextAirDate);
      if (wd >= 1 && wd <= 7) {
        autoDay = wd;
        const dow = ['', '一', '二', '三', '四', '五', '六', '日'][wd];
        notes.push(`按 TMDB 的下一集日期（${tm.nextAirDate}）把更新日设成周${dow}`);
      }
    }
    // 本次计算「下次多久查」时就用上刚推出来的更新日，否则第一轮还是匀速
    const after = autoDay ? { ...sub, updateDay: autoDay } : sub;
    const metaPatch = tm ? { tmdbMeta: tm } : {};
    if (!to) {
      const msg = '站点、TMDB 都没给出集数，无法判断该补到第几集。请手动填「总共多少集」后重试';
      patchSub(sub.id, {
        ...metaPatch,
        lastCheckAt: Date.now(),
        nextCheckAt: Date.now() + 30 * 60 * 1000,
        lastResult: msg,
        failCount: 0,
      });
      pushLog(sub, msg);
      return { ok: false, message: msg, downloaded: 0, summary: { have: have.episodes.length, to: 0 } };
    }

    const missing = missingEpisodes({ have: have.episodes, sent: sub.sent, from: sub.startEpisode, to });
    if (!missing.length) {
      const msg = `齐全：本地 ${have.episodes.length} 集（${have.files} 个文件），目标 ${to} 集`;
      patchSub(sub.id, {
        ...metaPatch,
        ...(autoDay ? { updateDay: autoDay } : {}),
        lastCheckAt: Date.now(),
        nextCheckAt: Date.now() + nextDelay(after, cfg) * 60 * 1000,
        lastResult: msg,
        failCount: 0,
      });
      pushLog(sub, msg);
      return { ok: true, message: msg, downloaded: 0, summary: { have: have.episodes.length, to, missing: 0 } };
    }

    const limit = Math.max(1, Math.min(cfg.maxPerRun || 3, missing.length));
    const batch = missing.slice(0, limit);
    let downloaded = 0;
    const sent = { ...sub.sent };

    for (const ep of batch) {
      if (dailyUsed() >= (cfg.dailyLimit || 36)) {
        notes.push(`今天已经检查 ${dailyUsed()} 次，达到上限，先停手`);
        break;
      }
      let src = null;
      try {
        src = await findSourceForEpisode(sub, built.index, ep, { notes });
      } catch (err) {
        notes.push(`第 ${ep} 集找源失败：${String(err.message || err).slice(0, 80)}`);
      }
      if (!src) {
        notes.push(`第 ${ep} 集：站点上没有能明确对应到这一集的资源`);
        continue;
      }

      let magnet = src.magnet || '';
      let hash = src.hash || '';
      if (!magnet && src.torrentUrl) {
        try {
          const m = await magnetFromTorrentUrl(src.torrentUrl);
          magnet = m.magnet;
          hash = m.hash;
        } catch (err) {
          sent[ep] = { at: Date.now(), name: src.name, state: 'failed', tries: 1, note: String(err.message || err) };
          notes.push(`第 ${ep} 集：${String(err.message || err).slice(0, 60)}`);
          continue;
        }
      }
      if (!magnet) continue;

      const route = routeFor('torrent');
      try {
        const r = await route.engine.add({ magnet, dir, hash });
        sent[ep] = {
          at: Date.now(),
          name: src.name || `第 ${ep} 集`,
          hash: r.hash || hash,
          state: 'ok',
          tries: 1,
          note: r.already ? '已存在同种子任务' : '',
        };
        if (!r.already) downloaded += 1;
        pushLog(sub, `第 ${ep} 集已交给 ${route.engine.name}：${String(src.name || '').slice(0, 60)}`);
      } catch (err) {
        sent[ep] = { at: Date.now(), name: src.name, hash, state: 'failed', tries: 1, note: String(err.message || err).slice(0, 120) };
        notes.push(`第 ${ep} 集下发失败：${String(err.message || err).slice(0, 80)}`);
      }
    }

    bumpDaily();
    const msg = `本地 ${have.episodes.length} 集（${have.files} 个文件） / 目标 ${to} 集 / 缺 ${missing.length} 集 / 本次下发 ${downloaded} 集`;
    const nextAt = Date.now() + nextDelay(after, cfg) * 60 * 1000;
    patchSub(sub.id, {
      ...metaPatch,
      ...(autoDay ? { updateDay: autoDay } : {}),
      sent,
      lastCheckAt: Date.now(),
      nextCheckAt: nextAt,
      lastResult: msg,
      failCount: 0,
      // 不再把站点/TMDB 的集数写回 totalEpisodes：
      // 那是「用户手填」字段，写进去就等于以后永远压着站点和 TMDB，一条脏值能锁死整条订阅。
    });
    if (notes.length) pushLog(sub, notes.slice(0, 3).join('；'));

    return {
      ok: true,
      message: msg,
      downloaded,
      summary: {
        have: have.episodes.length,
        files: have.files,
        to,
        missing: missing.length,
        scanned: built.scanned,
        siteTotal: built.siteTotal,
        notes: [...new Set(notes)].slice(0, 6),
      },
    };
  } catch (err) {
    const fails = (getSub(sub.id)?.failCount || 0) + 1;
    const wait = backoffMinutes(cfg.intervalMinutes || 60, fails);
    patchSub(sub.id, {
      lastCheckAt: Date.now(),
      nextCheckAt: Date.now() + wait * 60 * 1000,
      lastResult: `检查失败：${String(err.message || err).slice(0, 160)}`,
      failCount: fails,
    });
    pushLog(sub, `检查失败：${String(err.message || err).slice(0, 160)}`);
    throw err;
  } finally {
    running.delete(sub.id);
  }
}

/* ---------------- 调度 ---------------- */

let timer = null;

function tick() {
  const cfg = loadSettings().subscribe || {};
  if (cfg.enabled === false) return;
  if (dailyUsed() >= (cfg.dailyLimit || 36)) return;
  const due = listSubs().filter((s) => s.enabled && !running.has(s.id) && (s.nextCheckAt || 0) <= Date.now());
  if (!due.length) return;
  // 串行跑：同时打多个订阅等于自己给自己制造限流
  (async () => {
    for (const s of due) {
      if (running.has(s.id)) continue;
      if (dailyUsed() >= (cfg.dailyLimit || 36)) break;
      try {
        await runCheck(s.id);
      } catch (err) {
        console.warn(`[subscribe] ${s.title} 检查失败：${err.message}`);
      }
    }
  })();
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  // 启动 90 秒后先跑一轮，给站点探测和登录态留出时间
  const kick = setTimeout(tick, 90 * 1000);
  if (typeof kick.unref === 'function') kick.unref();
  console.log('[subscribe] 订阅调度已启动（每 60 秒检查一次到期任务）');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
