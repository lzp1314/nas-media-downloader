import { httpRequest } from '../lib/util.js';
import { loadSettings } from '../settings.js';

/**
 * TMDB 元数据（可选增强）。
 *
 * 它只解决三件事：总共多少集、别名、**下一集哪天播**。
 * 不提供任何资源，也不参与资源轮询——每天最多问一两次，对 TMDB 和资源站都没压力。
 *
 * 两个现实问题，代码里都做了兜底：
 *   1. api.themoviedb.org 在国内会被 DNS 污染，所以备了官方另一个入口 api.tmdb.org
 *      （CloudFront），第一个域名连不上自动换第二个，用户也可以自己填域名。
 *   2. 域名能不能通、Key 对不对，只能由 NAS 自己测，所以有一条「测试连接」专用路径。
 *
 * 密钥两种写法都认：
 *   - v4 读访问令牌（eyJ… 那串）走 Authorization: Bearer，不落在 URL 里，优先用它
 *   - v3 API Key（32 位）走 ?api_key=，是历史写法，保留兼容
 */

/** 官方两个入口，按顺序试；前一个被污染/超时就换下一个 */
const BASES = ['https://api.themoviedb.org/3', 'https://api.tmdb.org/3'];

/** 详情走内存缓存：同一部剧在一次检查里可能被问多次，别重复打 */
const mem = new Map();
const TTL_DETAIL = 6 * 3600 * 1000;

const STATUS_CN = {
  'Returning Series': '连载中',
  'In Production': '制作中',
  Ended: '已完结',
  Canceled: '已砍',
  Planned: '已立项',
  Pilot: '试播',
  Rumored: '传闻中',
  'Post Production': '后期制作',
  Released: '已上映',
};

function cfg() {
  const t = loadSettings().tmdb || {};
  return {
    token: String(t.token || '').trim(),
    apiKey: String(t.apiKey || '').trim(),
    base: String(t.base || '').trim().replace(/\/+$/, ''),
  };
}

export function tmdbReady() {
  const c = cfg();
  return Boolean(c.token || c.apiKey);
}

function needAuth() {
  const e = new Error('还没填 TMDB 密钥：去「设置 → 影视元数据 → TMDB」填上读访问令牌或 API Key');
  e.code = 'ENEEDAUTH';
  return e;
}

async function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`TMDB 返回的不是 JSON（${what}），可能被中间设备劫持了`);
  }
}

/**
 * 发一次请求。域名按顺序试，但「鉴权失败」不重试——那是 Key 的问题，
 * 换域名只会让用户多等 12 秒还看到同样的错。
 */
async function api(pathname, params = {}) {
  const c = cfg();
  if (!c.token && !c.apiKey) throw needAuth();

  const bases = c.base ? [c.base] : BASES;
  const qs = new URLSearchParams({ language: 'zh-CN' });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  // 走 Bearer 时不要把 key 塞进 URL：URL 会进日志、进反代记录
  if (!c.token) qs.set('api_key', c.apiKey);

  const headers = { Accept: 'application/json' };
  if (c.token) headers.Authorization = `Bearer ${c.token}`;

  const failed = [];
  for (const b of bases) {
    const url = `${b}${pathname}?${qs.toString()}`;
    let res;
    try {
      res = await httpRequest(url, { headers, timeout: 12000 });
    } catch (err) {
      // 网络层失败（DNS 污染、超时、TLS）才有必要换域名
      failed.push(`${new URL(b).host}：${String(err.message || err).slice(0, 60)}`);
      continue;
    }
    if (res.status === 401) {
      const e = new Error('TMDB 说密钥无效（401）：检查令牌有没有粘全，或重新生成一个');
      e.code = 'EBADKEY';
      throw e;
    }
    if (res.status === 429) {
      const e = new Error('TMDB 限流了（429），过一会儿再试');
      e.code = 'ERATELIMIT';
      throw e;
    }
    if (res.status === 404) {
      const e = new Error('TMDB 上没有这个条目');
      e.code = 'ENOTFOUND';
      throw e;
    }
    if (res.status >= 400) {
      throw new Error(`TMDB 返回 ${res.status}`);
    }
    return parseJson(res.text, pathname);
  }
  const e = new Error(`连不上 TMDB：${failed.join('；')}。可以在设置里换个「API 域名」再试`);
  e.code = 'ENET';
  throw e;
}

function cleanList(arr, max) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, max);
}

/** 别名地区优先级：大陆 > 台湾 > 香港 > 其他中文。站点资源名绝大多数是大陆写法 */
function regionRank(iso) {
  const s = String(iso || '').toUpperCase();
  if (s === 'CN') return 0;
  if (s === 'TW') return 1;
  if (s === 'HK') return 2;
  if (s.startsWith('ZH')) return 3;
  return 4;
}

/** 把 TMDB 的一坨字段收成我们真正要用的那几个，别把整个响应往下传 */
export function normalizeTv(d) {
  const next = d?.next_episode_to_air || null;
  const last = d?.last_episode_to_air || null;
  const alt = Array.isArray(d?.alternative_titles?.results) ? d.alternative_titles.results : [];
  // 别名优先取中文（zh-CN / CN / TW / HK），再补原文，最后才是英文。
  // 按地区排一遍而不是直接用接口返回的顺序：那个顺序不稳定，同一部剧两次请求可能不一样。
  const zh = alt
    .filter((x) => /^(zh|cn|tw|hk)/i.test(String(x?.iso_3166_1 || '')))
    .slice()
    .sort((a, b) => regionRank(a?.iso_3166_1) - regionRank(b?.iso_3166_1))
    .map((x) => x?.title);
  const en = alt.filter((x) => String(x?.iso_3166_1 || '').toUpperCase() === 'US').map((x) => x?.title);
  const totalEpisodes = Number(d?.number_of_episodes) || 0;
  return {
    id: Number(d?.id) || 0,
    mediaType: 'tv',
    name: String(d?.name || '').trim(),
    originalName: String(d?.original_name || '').trim(),
    year: String(d?.first_air_date || '').slice(0, 4),
    firstAirDate: String(d?.first_air_date || ''),
    status: String(d?.status || ''),
    statusCn: STATUS_CN[String(d?.status || '')] || String(d?.status || ''),
    inProduction: Boolean(d?.in_production),
    totalEpisodes,
    totalSeasons: Number(d?.number_of_seasons) || 0,
    // 只有这一集已经排期了才有值；完结剧这里是空的
    nextAirDate: String(next?.air_date || ''),
    nextAirSeason: Number(next?.season_number) || 0,
    nextAirEpisode: Number(next?.episode_number) || 0,
    lastAirDate: String(last?.air_date || ''),
    lastAirEpisode: Number(last?.episode_number) || 0,
    aliases: cleanList([...zh, d?.original_name, ...en], 8),
  };
}

/** 电影的字段收拢。电影没有集数，只关心上映日、状态，以及别名（拿它当搜索词命中率更高） */
export function normalizeMovie(d) {
  const alt = Array.isArray(d?.alternative_titles?.results) ? d.alternative_titles.results : [];
  const zh = alt
    .filter((x) => /^(zh|cn|tw|hk)/i.test(String(x?.iso_3166_1 || '')))
    .slice()
    .sort((a, b) => regionRank(a?.iso_3166_1) - regionRank(b?.iso_3166_1))
    .map((x) => x?.title);
  const en = alt.filter((x) => String(x?.iso_3166_1 || '').toUpperCase() === 'US').map((x) => x?.title);
  return {
    id: Number(d?.id) || 0,
    name: String(d?.title || '').trim(),
    originalName: String(d?.original_title || '').trim(),
    year: String(d?.release_date || '').slice(0, 4),
    releaseDate: String(d?.release_date || ''),
    mediaType: 'movie',
    status: String(d?.status || ''),
    statusCn: STATUS_CN[String(d?.status || '')] || String(d?.status || ''),
    totalEpisodes: 0,
    totalSeasons: 0,
    nextAirDate: '',
    nextAirSeason: 0,
    nextAirEpisode: 0,
    lastAirDate: '',
    lastAirEpisode: 0,
    aliases: cleanList([...zh, d?.original_title, ...en], 8),
  };
}

/** 把 TMDB 的 tv 候选收成统一形状（带 mediaType 标记） */
function toTvItem(x) {
  return {
    id: Number(x.id) || 0,
    name: String(x.name || ''),
    originalName: String(x.original_name || ''),
    year: String(x.first_air_date || '').slice(0, 4),
    overview: String(x.overview || '').slice(0, 70),
    country: Array.isArray(x.origin_country) ? x.origin_country.join('/') : '',
    mediaType: 'tv',
  };
}

/** 把 TMDB 的 movie 候选收成统一形状（带 mediaType 标记） */
function toMovieItem(x) {
  return {
    id: Number(x.id) || 0,
    name: String(x.title || ''),
    originalName: String(x.original_title || ''),
    year: String(x.release_date || '').slice(0, 4),
    overview: String(x.overview || '').slice(0, 70),
    country: '',
    mediaType: 'movie',
  };
}

/**
 * 搜剧名/片名 → 候选列表。
 * type: 'all'(默认) 同时搜剧集和电影，用 TMDB 的 /search/multi 一次拿全；
 *       'tv' / 'movie' 只搜对应类型。搜索结果不含集数/详情，选中后再查详情。
 */
export async function searchMedia(query, type = 'all') {
  const q = String(query || '').trim();
  if (!q) return [];
  if (type === 'tv') return searchTvOnly(q);
  if (type === 'movie') return searchMovieOnly(q);
  const r = await api('/search/multi', { query: q, include_adult: 'false' });
  return (Array.isArray(r?.results) ? r.results : [])
    .filter((x) => x.media_type === 'movie' || x.media_type === 'tv')
    .slice(0, 16)
    .map((x) => (x.media_type === 'movie' ? toMovieItem(x) : toTvItem(x)))
    .filter((x) => x.id && x.name);
}

/** 向后兼容：旧调用方仍按剧名搜，等价于 searchMedia(q, 'tv') */
export async function searchTv(query) {
  return searchTvOnly(query);
}

async function searchTvOnly(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const r = await api('/search/tv', { query: q, include_adult: 'false' });
  return (Array.isArray(r?.results) ? r.results : [])
    .slice(0, 12)
    .map(toTvItem)
    .filter((x) => x.id && x.name);
}

async function searchMovieOnly(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const r = await api('/search/movie', { query: q, include_adult: 'false' });
  return (Array.isArray(r?.results) ? r.results : [])
    .slice(0, 12)
    .map(toMovieItem)
    .filter((x) => x.id && x.name);
}

/** 详情：总集数、别名、下一集。带 6 小时内存缓存。 */
export async function tvDetail(id, { maxAge = TTL_DETAIL } = {}) {
  const tid = Number(id);
  if (!tid) throw new Error('TMDB 条目 id 不合法');
  const hit = mem.get(tid);
  if (hit && Date.now() - hit.at < maxAge) return hit.data;
  const raw = await api(`/tv/${tid}`, { append_to_response: 'alternative_titles' });
  const data = normalizeTv(raw);
  mem.set(tid, { at: Date.now(), data });
  return data;
}

/** 电影详情：上映日、状态、别名。带 6 小时内存缓存（key 加 m 前缀避免和剧集撞 id）。 */
export async function movieDetail(id, { maxAge = TTL_DETAIL } = {}) {
  const tid = Number(id);
  if (!tid) throw new Error('TMDB 条目 id 不合法');
  const key = `m${tid}`;
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < maxAge) return hit.data;
  const raw = await api(`/movie/${tid}`, { append_to_response: 'alternative_titles' });
  const data = normalizeMovie(raw);
  mem.set(key, { at: Date.now(), data });
  return data;
}

/** 某一季的每一集（含播出日期）。按需调用，不做预取。 */
export async function seasonEpisodes(id, seasonNumber = 1) {
  const tid = Number(id);
  const sn = Number(seasonNumber);
  if (!tid || !Number.isFinite(sn)) throw new Error('参数不合法');
  const raw = await api(`/tv/${tid}/season/${sn}`);
  return (Array.isArray(raw?.episodes) ? raw.episodes : []).map((e) => ({
    episode: Number(e.episode_number) || 0,
    name: String(e.name || ''),
    airDate: String(e.air_date || ''),
    runtime: Number(e.runtime) || 0,
  })).filter((e) => e.episode > 0);
}

/** 设置页「测试连接」：返回用哪个域名通的，方便用户判断要不要改 */
export async function testConnection() {
  const started = Date.now();
  const r = await api('/configuration');
  return {
    ok: true,
    ms: Date.now() - started,
    images: String(r?.images?.secure_base_url || ''),
    auth: cfg().token ? 'bearer' : 'key',
  };
}

/** 测试用：清缓存 */
export function _resetTmdb() {
  mem.clear();
}
