import fsp from 'node:fs/promises';
import path from 'node:path';
import { httpRequest, DEFAULT_UA } from '../lib/util.js';
import { parseTorrentMeta } from '../lib/bencode.js';
import { allowedRoots, loadSettings } from '../settings.js';
import { listSubs, getSub, patchSub, pushLog } from './store.js';
import { scanEpisodes, missingEpisodes, parseEpisodes, pickFileIndexes } from './episodes.js';
import { buildEpisodeIndex, findSourceForEpisode, findMovieSource, targetUpperBound } from './matcher.js';
import { listTorrentFiles, readCachedTorrent } from '../sources/torrent.js';
import { routeFor } from '../engine/index.js';
import { tmdbReady, tvDetail, movieDetail } from '../sources/tmdb.js';

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

/** 拿一次 TMDB 元数据（优先用缓存）。失败不抛，交给调用方降级。 */
async function ensureTmdbMeta(sub, { force = false } = {}) {
  if (!sub.tmdbId || !tmdbReady()) return null;
  const cached = !force && sub.tmdbMeta;
  if (cached && cached.at && Date.now() - cached.at < TMDB_TTL) return cached;
  const fn = sub.type === 'movie' ? movieDetail : tvDetail;
  const d = await fn(sub.tmdbId, { maxAge: force ? 0 : TMDB_TTL });
  return {
    at: Date.now(),
    mediaType: d.mediaType,
    name: d.name,
    status: d.status,
    statusCn: d.statusCn,
    totalEpisodes: d.totalEpisodes,
    totalSeasons: d.totalSeasons,
    firstAirDate: d.firstAirDate,
    nextAirDate: d.nextAirDate,
    nextAirEpisode: d.nextAirEpisode,
    nextAirSeason: d.nextAirSeason,
    lastAirDate: d.lastAirDate,
    lastAirEpisode: d.lastAirEpisode,
    releaseDate: d.releaseDate,
  };
}

/**
 * 判断 TMDB 元数据是否「还没到上映/开播」。
 * 电影看 releaseDate，剧集看 firstAirDate；状态处于待定档（立项/制作中/后期/传闻）也算等待。
 * @returns {null|{nextCheckAt:number, message:string}} 非 null 表示应进入等待态
 */
export function awaitingRelease(tm) {
  if (!tm) return null;
  const now = Date.now();
  const future = tm.mediaType === 'movie' ? tm.releaseDate : tm.firstAirDate;
  const pendingStatus = ['Planned', 'In Production', 'Pilot', 'Rumored', 'Post Production'];
  const statusPending = pendingStatus.includes(tm.status);
  const dayMs = 24 * 3600 * 1000;

  // 没有公布日期但状态待定：每天查一次确认是否定档
  if (!future && statusPending) {
    return { nextCheckAt: now + dayMs, message: `「${tm.statusCn || tm.status}」，暂未公布上映/开播日，每日复查` };
  }
  if (!future) return null; // 无日期且非待定 → 当已可下

  const ts = new Date(`${future}T12:00:00`).getTime();
  if (Number.isNaN(ts)) return null;
  // 日期已过：状态仍待定说明可能改档，继续等；否则视为已可下
  if (ts <= now) {
    if (statusPending) {
      return { nextCheckAt: now + dayMs, message: `状态仍为「${tm.statusCn || tm.status}」，继续等待确认上映/开播` };
    }
    return null;
  }
  // 未来日期：临近时加密轮询
  const untilStart = ts - now;
  let nextAt;
  if (untilStart > 2 * dayMs) nextAt = now + dayMs;
  else if (untilStart > 0) nextAt = now + Math.max(3600 * 1000, Math.floor(untilStart / 2));
  else nextAt = now + 6 * 3600 * 1000;
  const label = tm.mediaType === 'movie' ? '上映' : '开播';
  const d = new Date(ts);
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { nextCheckAt: nextAt, message: `待${label}：预计 ${dateStr}（${tm.statusCn || tm.status}），到点自动开始下载` };
}

/** 在分支开头统一做「待上映/待开播」判定；命中则写入等待态并直接返回 */
async function maybeWait(sub) {
  if (!sub.tmdbId || !tmdbReady()) return null;
  let tm = null;
  try {
    tm = await ensureTmdbMeta(sub, { force: true });
  } catch {
    return null; // 元数据拿不到不阻断，交给正常分支
  }
  const up = tm && awaitingRelease(tm);
  if (!up) return null;
  const wait = {
    tmdbMeta: tm,
    lastCheckAt: Date.now(),
    nextCheckAt: up.nextCheckAt,
    lastResult: up.message,
    state: 'waiting',
    failCount: 0,
  };
  patchSub(sub.id, wait);
  pushLog(sub, up.message);
  return { ok: true, message: up.message, downloaded: 0, summary: { waiting: true } };
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

/** 更新日集合：新字段是数组，老数据只有一个 updateDay，两种都认 */
function subDays(sub) {
  const set = new Set();
  if (Array.isArray(sub?.updateDays)) {
    for (const x of sub.updateDays) {
      const d = Math.floor(Number(x));
      if (d >= 1 && d <= 7) set.add(d);
    }
  }
  if (!set.size) {
    const one = Math.floor(Number(sub?.updateDay)) || 0;
    if (one >= 1 && one <= 7) set.add(one);
  }
  return [...set].sort((a, b) => a - b);
}

function windowSpan(sub) {
  const own = subDays(sub);
  const clockTime = parseClock(sub?.updateTime);
  if (!own.length || !clockTime) return null;
  // 每个更新日都要把它「次日」也加进来：资源站晚发几小时是常态
  const days = new Set();
  for (const d of own) {
    days.add(d);
    days.add((d % 7) + 1);
  }
  return {
    days: [...days],
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
 *
 * opts.pending = 本次还缺几集。缺着集就别按低频睡——补历史缺集、一晚两集分批上线，
 * 都靠「还缺就接着查」才追得上；否则 6 小时一觉醒来只补了 3 集。
 */
export function nextDelay(sub, cfg = {}, nowTs = Date.now(), opts = {}) {
  const base = Math.max(10, Number(cfg.intervalMinutes) || 60);
  const updateInt = Math.max(10, Number(cfg.updateIntervalMinutes) || 30);
  const offInt = Math.max(base, Number(cfg.offIntervalMinutes) || 360);
  const pending = Math.max(0, Number(opts.pending) || 0);
  const ds = subDays(sub);
  if (!ds.length) return pending ? Math.min(base, updateInt) : base;

  if (!parseClock(sub?.updateTime)) {
    const wd = weekdayOf(nowTs);
    const near = ds.some((d) => wd === d || wd === (d % 7) + 1);
    if (near) return Math.max(10, Math.min(base, updateInt));
    return pending ? updateInt : offInt;
  }

  if (inUpdateWindow(sub, nowTs)) return updateInt;

  // 还有缺集：不睡长觉，接着找（一晚两集里第二集常在窗口后才上线）
  if (pending) return updateInt;

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
 * 跑一次某个订阅的检查（入口）。
 * 电影订阅走 runCheckMovie，电视剧走 runCheckTv；两者都受 running 集合保护。
 * 待上映/待开播的条目在这里统一拦截，不空转轮询资源站。
 * @returns {{ok:boolean, message:string, downloaded:number, summary:object}}
 */
export async function runCheck(id, { force = false } = {}) {
  const sub = getSub(id);
  if (!sub) throw new Error('订阅不存在');
  if (running.has(sub.id)) throw new Error('这个订阅正在检查中，稍等');
  running.add(sub.id);
  try {
    // 待上映/待开播：未到时间只更新等待状态，不实际搜索资源
    const waited = await maybeWait(sub);
    if (waited) return waited;
    if (sub.type === 'movie') return await runCheckMovie(sub);
    return await runCheckTv(sub);
  } finally {
    running.delete(sub.id);
  }
}

/**
 * 剧集订阅检查：扫本地 → 搜站点 → 算缺集 → 只下缺的那几集。
 */
export async function runCheckTv(sub) {
  const cfg = loadSettings().subscribe || {};
  const dir = resolveDir(sub.dir);
  if (!dir) throw new Error(`目标目录不在允许的片库内：${sub.dir}`);
  if (allowedRoots().some((r) => path.resolve(r) === dir)) {
    throw new Error(`保存目录是片库根目录（${dir}），请改成这部剧自己的文件夹`);
  }

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
    if (!subDays(sub).length && tm?.nextAirDate) {
      const wd = weekdayOfDate(tm.nextAirDate);
      if (wd >= 1 && wd <= 7) {
        autoDay = wd;
        const dow = ['', '一', '二', '三', '四', '五', '六', '日'][wd];
        notes.push(`按 TMDB 的下一集日期（${tm.nextAirDate}）把更新日设成周${dow}`);
      }
    }
    // 本次计算「下次多久查」时就用上刚推出来的更新日，否则第一轮还是匀速
    const after = autoDay ? { ...sub, updateDays: [autoDay], updateDay: autoDay } : sub;
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
        ...(autoDay ? { updateDays: [autoDay], updateDay: autoDay } : {}),
        lastCheckAt: Date.now(),
        nextCheckAt: Date.now() + nextDelay(after, cfg) * 60 * 1000,
        lastResult: msg,
        failCount: 0,
      });
      pushLog(sub, msg);
      return { ok: true, message: msg, downloaded: 0, summary: { have: have.episodes.length, to, missing: 0 } };
    }

    // 「每晚更两集」的剧，一次检查至少要把这一晚的量拿走；maxPerRun 是上限保护，
    // 两者取大——否则用户把 maxPerRun 调成 1 时，第二集要等到下一轮才动。
    const perNight = Math.max(1, Math.min(3, Number(sub.episodesPerNight) || 1));
    const limit = Math.max(1, Math.min(Math.max(Number(cfg.maxPerRun) || 3, perNight), missing.length));
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
        src = await findSourceForEpisode(sub, built.index, ep, { notes, packs: built.packs || [] });
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
      // 一个种子常常一次带好几集（[38-43集] 这种）。只下这次要补的集，
      // 否则要两集会连下六集，白占几 GB 还可能把后面的集提前占了。
      const want = new Set(batch);
      let selectFile = '';
      let torrentB64 = '';
      try {
        const info = await listTorrentFiles(magnet);
        const files = info.files || [];
        selectFile = pickFileIndexes(files, [...want]);
        // aria2 加磁力时还没元数据，select-file 会失效；有落盘种子就改走 addTorrent
        if (selectFile && route.engine.name !== 'qbit') {
          const buf = await readCachedTorrent(hash || info.hash).catch(() => null);
          if (buf) torrentB64 = buf.toString('base64');
        }
      } catch {
        /* 取不到清单就整包下，交给引擎自己的默认行为 */
      }
      try {
        const args = torrentB64
          ? { torrent: torrentB64, dir, selectFile }
          : { magnet, dir, hash, selectFile };
        const r = await route.engine.add(args);
        sent[ep] = {
          at: Date.now(),
          name: src.name || `第 ${ep} 集`,
          hash: r.hash || hash,
          state: 'ok',
          tries: 1,
          note: r.already ? '已存在同种子任务' : selectFile ? `只下第 ${[...want].join('、')} 集` : '',
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
    // 还缺着集就保持密查：补历史缺集、一晚两集分批上线都靠这个，别一觉睡 6 小时
    const nextAt = Date.now() + nextDelay(after, cfg, Date.now(), { pending: missing.length - downloaded }) * 60 * 1000;
    patchSub(sub.id, {
      ...metaPatch,
      ...(autoDay ? { updateDays: [autoDay], updateDay: autoDay } : {}),
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
  }
}

/**
 * 电影订阅检查：扫本地 → 待上映拦截 → 搜一次 → 下整包 → 下完即停。
 * 电影没有「集」概念，不按集裁剪、不补历史缺集；到点只下发一次，本地已有视频文件即视为完成。
 */
export async function runCheckMovie(sub) {
  const cfg = loadSettings().subscribe || {};
  const dir = resolveDir(sub.dir);
  if (!dir) throw new Error(`目标目录不在允许的片库内：${sub.dir}`);
  if (allowedRoots().some((r) => path.resolve(r) === dir)) {
    throw new Error(`保存目录是片库根目录（${dir}），请改成这部电影自己的文件夹`);
  }
  const notes = [];
  try {
    await fsp.mkdir(dir, { recursive: true });

    // 已经下发过：等本地文件出现，出现了即完成，未出现则继续等待（仍在下载中）
    if (sub.sent?.movie?.state === 'ok') {
      const have = await scanEpisodes(dir);
      if (have.files >= 1) {
        const msg = `已完成：本地已有 ${have.files} 个视频文件`;
        patchSub(sub.id, { lastCheckAt: Date.now(), nextCheckAt: Date.now() + 30 * 86400000, lastResult: msg, state: 'done', failCount: 0 });
        pushLog(sub, msg);
        return { ok: true, message: msg, downloaded: 0, summary: { files: have.files } };
      }
      const msg = '下载进行中，等待文件落盘';
      patchSub(sub.id, { lastCheckAt: Date.now(), nextCheckAt: Date.now() + 3600 * 1000, lastResult: msg });
      return { ok: true, message: msg, downloaded: 0, summary: { pending: true } };
    }

    const built = await buildEpisodeIndex(sub, { pages: 2 });
    notes.push(...built.notes);
    const src = await findMovieSource(sub, built, { notes });
    if (!src) {
      const msg = `还没找到「${sub.title}」的下载资源（可能尚未上线，或资源站没收录）`;
      const fails = (sub.failCount || 0) + 1;
      patchSub(sub.id, { lastCheckAt: Date.now(), nextCheckAt: Date.now() + nextDelay(sub, cfg) * 60000, lastResult: msg, failCount: fails });
      pushLog(sub, msg);
      return { ok: false, message: msg, downloaded: 0, summary: {} };
    }

    let magnet = src.magnet || '';
    let hash = src.hash || '';
    if (!magnet && src.torrentUrl) {
      try {
        const m = await magnetFromTorrentUrl(src.torrentUrl);
        magnet = m.magnet;
        hash = m.hash;
      } catch (err) {
        const msg = `种子文件没取到：${String(err.message || err).slice(0, 60)}`;
        patchSub(sub.id, { lastCheckAt: Date.now(), nextCheckAt: Date.now() + 30 * 60000, lastResult: msg, failCount: (sub.failCount || 0) + 1 });
        pushLog(sub, msg);
        return { ok: false, message: msg, downloaded: 0, summary: {} };
      }
    }
    if (!magnet) {
      const msg = '找到资源但拿不到磁力/种子链接，站点可能需要登录';
      patchSub(sub.id, { lastCheckAt: Date.now(), nextCheckAt: Date.now() + 30 * 60000, lastResult: msg, failCount: (sub.failCount || 0) + 1 });
      pushLog(sub, msg);
      return { ok: false, message: msg, downloaded: 0, summary: {} };
    }

    const route = routeFor('torrent');
    const r = await route.engine.add({ magnet, dir, hash });
    const sent = { ...(sub.sent || {}), movie: { at: Date.now(), name: src.name, hash: r.hash || hash, state: 'ok', tries: 1, note: r.already ? '已存在同种子任务' : '' } };
    const msg = r.already ? '已存在同种子任务，跳过' : `已下发下载：${String(src.name || '').slice(0, 60)}`;
    patchSub(sub.id, { sent, lastCheckAt: Date.now(), nextCheckAt: Date.now() + 6 * 3600 * 1000, lastResult: msg, state: 'downloading', failCount: 0 });
    pushLog(sub, msg);
    return { ok: true, message: msg, downloaded: 1, summary: {} };
  } catch (err) {
    const fails = (getSub(sub.id)?.failCount || 0) + 1;
    const wait = backoffMinutes(cfg.intervalMinutes || 60, fails);
    patchSub(sub.id, { lastCheckAt: Date.now(), nextCheckAt: Date.now() + wait * 60000, lastResult: `检查失败：${String(err.message || err).slice(0, 160)}`, failCount: fails });
    pushLog(sub, `检查失败：${String(err.message || err).slice(0, 160)}`);
    throw err;
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
