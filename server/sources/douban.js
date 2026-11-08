import { httpRequest, DEFAULT_UA } from '../lib/util.js';
import { loadSettings } from '../settings.js';

/**
 * 豆瓣元数据（可选增强）。
 *
 * 只用它做两件事：补齐「总集数」和「别名」，以及可选地读「在看」列表。
 * 它不提供任何资源，也不参与每小时的资源轮询——豆瓣反爬严格，一天打一两次已经是上限。
 *
 * 两个接口的登录要求不同：
 *   subject_suggest  公开，不需要 Cookie（搜剧名、拿 id 和集数）
 *   subject/{id}/    风控更严，没 Cookie 常常返回空壳页（拿别名/首播日要它）
 */

const UA = DEFAULT_UA;
const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://movie.douban.com/',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function cookie() {
  return String(loadSettings().douban?.cookie || '').trim();
}

function cookieHeaders(extra = {}) {
  const c = cookie();
  return { ...BASE_HEADERS, ...extra, ...(c ? { Cookie: c } : {}) };
}

export function doubanReady() {
  return Boolean(cookie());
}

/** 搜索剧名 → 豆瓣候选。不需要登录。 */
export async function suggest(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(kw)}`;
  const res = await httpRequest(url, { headers: cookieHeaders({ Accept: 'application/json' }), timeout: 12000 });
  if (res.status === 403) throw new Error('豆瓣拒绝了这次请求（触发风控），过一会儿再试');
  let list;
  try {
    list = JSON.parse(res.text);
  } catch {
    throw new Error('豆瓣返回的不是 JSON，可能被风控拦截');
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && x.id && x.title)
    .slice(0, 12)
    .map((x) => ({
      id: String(x.id),
      title: String(x.title || '').trim(),
      subTitle: String(x.sub_title || '').trim(),
      episodes: Number(x.episodes) || 0,
      year: String(x.year || '').trim(),
      // 豆瓣 suggest 的 type 也是 movie，分不出剧集，这里只做提示，最终由用户选
      type: String(x.type || ''),
      img: String(x.img || '').replace(/\/s_ratio_poster\//, '/l_ratio_poster/'),
    }));
}

function textOf(html, re) {
  const m = String(html || '').match(re);
  return m ? String(m[1]).replace(/<[^>]*>/g, '').trim() : '';
}

/**
 * 条目详情：总集数、别名、首播日期。
 * 没配 Cookie 也能试，但很可能拿不到「集数」那一行。
 */
export async function subject(id) {
  const sid = String(id || '').replace(/\D/g, '');
  if (!sid) throw new Error('豆瓣条目 id 不合法');
  const url = `https://movie.douban.com/subject/${sid}/`;
  const res = await httpRequest(url, { headers: cookieHeaders(), timeout: 15000 });
  const html = res.text || '';
  if (res.status === 403 || /检测到有异常请求|sec\.douban\.com/.test(html)) {
    const err = new Error('豆瓣要求验证（触发风控），请在设置里更新豆瓣 Cookie 后重试');
    err.needCookie = true;
    throw err;
  }

  const totalEpisodes = Number(textOf(html, /集数:<\/span>\s*([\d]+)/)) || 0;
  const aliasRaw = textOf(html, /又名:<\/span>\s*([^<]+)/);
  const title = textOf(html, /<span property="v:itemreviewed">([^<]+)<\/span>/) || textOf(html, /<title>\s*([^<(]+)/);
  const year = textOf(html, /<span class="year">\((\d{4})\)<\/span>/);
  const firstAir = textOf(html, /首播:<\/span>\s*([^<]+)/);

  return {
    id: sid,
    title: title.trim(),
    year,
    totalEpisodes,
    firstAir: firstAir.trim(),
    aliases: aliasRaw
      .split(/\/|、|，|,/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 8),
    // 没有集数行 = 电影，或者页面被降级了。两种情况都让上层自己判断
    isSeries: totalEpisodes > 0,
    degraded: !totalEpisodes && !aliasRaw,
  };
}

/**
 * 「在看」列表，用于一键导入订阅。必须配 Cookie。
 * 只取第一页（用户通常不会同时追几十部），够用且对站点压力最小。
 */
export async function watching() {
  if (!doubanReady()) {
    const err = new Error('豆瓣「在看」需要先填 Cookie');
    err.needCookie = true;
    throw err;
  }
  const uid = String(loadSettings().douban?.uid || '').trim();
  if (!uid) {
    const err = new Error('还差豆瓣用户 id（个人主页地址里的那串数字）');
    err.needCookie = true;
    throw err;
  }
  const url = `https://movie.douban.com/people/${encodeURIComponent(uid)}/collect?status=do&type=tv`;
  const res = await httpRequest(url, { headers: cookieHeaders(), timeout: 15000 });
  const html = res.text || '';
  if (res.status === 403 || /检测到有异常请求/.test(html)) {
    const err = new Error('豆瓣要求验证，Cookie 可能过期了');
    err.needCookie = true;
    throw err;
  }
  const out = [];
  const re = /<a href="https:\/\/movie\.douban\.com\/subject\/(\d+)\/"[^>]*>([^<]{1,80})<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const title = m[2].trim();
    if (!title || out.some((x) => x.id === id)) continue;
    out.push({ id, title });
    if (out.length >= 30) break;
  }
  return out;
}
