import { CookieJar, httpRequest, encodeForm, decodeEntities, stripTags, extractHash } from '../lib/util.js';
import { loadSettings } from '../settings.js';
import { requireB } from './config.js';

/**
 * 资源库 B 客户端（网页型索引站）
 * - 站内搜索：POST {searchUrl}（中文关键词会被站点风控清掉，中文检索走本地片库）
 * - 详情页磁力：页面内 #secure-gate 带 rid/cid/hash，需先过 click-verify（挑战码 → 行为上报 → token）再取链接
 * - 站点地址全部来自 sites.json，代码里不写死
 */

const jar = new CookieJar();

let authToken = '';
let authAt = 0;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 构造一份看起来像真人点击的行为数据 */
function buildBehavior(nonce, serverTs) {
  const dwell = rand(2600, 5200);
  const t0 = Date.now();
  const track = [];
  let x = rand(300, 700);
  let y = rand(200, 500);
  for (let i = 0; i < rand(24, 36); i += 1) {
    x += rand(-9, 12);
    y += rand(-7, 10);
    track.push({ x, y, t: t0 + i * rand(32, 58) });
  }
  let dist = 0;
  for (let i = 1; i < track.length; i += 1) {
    dist += Math.hypot(track[i].x - track[i - 1].x, track[i].y - track[i - 1].y);
  }
  const direct = Math.hypot(track.at(-1).x - track[0].x, track.at(-1).y - track[0].y);
  const straightness = dist > 0 ? Math.min(1, direct / dist) : 0;
  const metrics = {
    track_distance: Number(dist.toFixed(2)),
    speed_std: Number((Math.random() * 0.3 + 0.2).toFixed(4)),
    straightness: Number(straightness.toFixed(4)),
    abnormal_moves: 0,
  };
  return {
    client_version: 'v4',
    token: 'click-verified',
    nonce,
    dwell_ms: dwell,
    mm: track.length,
    server_ts: serverTs,
    click_ts: t0 + dwell,
    click_dwell: rand(70, 140),
    drift: Number((Math.random() * 1.6 + 0.4).toFixed(1)),
    has_scrolled: false,
    track_len: track.length,
    abnormal_moves: 0,
    is_trusted: true,
    webdriver: false,
    hover_ms: rand(500, 1200),
    entered_btn: true,
    click_x_ratio: Number((Math.random() * 0.3 + 0.35).toFixed(4)),
    click_y_ratio: Number((Math.random() * 0.3 + 0.35).toFixed(4)),
    ...metrics,
    behavior_log: {
      version: 'v4',
      client_result: 'pending_server_verify',
      trusted_supported: true,
      is_trusted: true,
      webdriver: false,
      dwell_start: t0,
      click_ts: t0 + dwell,
      hover_ms: rand(500, 1200),
      entered_btn: true,
      mouse_moves: track.length,
      track_len: track.length,
      track,
      track_metrics: metrics,
      click_metrics: { click_dwell: 95, drift: 1.1, click_x_ratio: 0.5, click_y_ratio: 0.5 },
      page_metrics: {
        has_scrolled: false,
        viewport_width: 1920,
        viewport_height: 940,
        screen_width: 1920,
        screen_height: 1080,
      },
    },
  };
}

async function passVerify(referer) {
  const { apiUrl, siteUrl } = requireB();
  const chRes = await httpRequest(`${apiUrl}/get_challenge-v4.php`, { jar, headers: { Referer: referer } });
  let nonce = '';
  let ts = 0;
  try {
    const ch = JSON.parse(chRes.text);
    if (ch.status === 'ok') {
      nonce = ch.nonce;
      ts = ch.ts;
    }
  } catch {
    /* 降级：无 nonce 也尝试一次 */
  }
  const payload = buildBehavior(nonce, ts);
  const res = await httpRequest(`${apiUrl}/verify_pass-v4.php`, {
    method: 'POST',
    jar,
    headers: { 'Content-Type': 'application/json', Referer: referer, Origin: siteUrl },
    body: JSON.stringify(payload),
  });
  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error('站点验证接口返回异常');
  }
  if (data.status !== 'ok' || !data.token) {
    throw new Error(data.message || '站点人机验证未通过');
  }
  authToken = data.token;
  authAt = Date.now();
  return authToken;
}

async function ensureAuth(referer, force = false) {
  if (!force && authToken && Date.now() - authAt < 1000 * 60 * 30) return authToken;
  return passVerify(referer);
}

async function fetchLinks(meta, referer) {
  const { apiUrl, siteUrl } = requireB();
  const token = await ensureAuth(referer);
  const call = async (tk) =>
    httpRequest(`${apiUrl}/get_links-v4.php?action=get${tk ? `&auth_token=${encodeURIComponent(tk)}` : ''}`, {
      method: 'POST',
      jar,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: referer,
        Origin: siteUrl,
      },
      body: encodeForm({
        rid: meta.rid,
        cid: meta.cid,
        hash: meta.hash,
        auth_token: tk || undefined,
      }),
    });

  let res = await call(token);
  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error('下载链接接口返回异常（可能触发了站点风控）');
  }
  if (data.status === 'no_auth') {
    const tk = await ensureAuth(referer, true);
    res = await call(tk);
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new Error('下载链接接口返回异常');
    }
  }
  if (data.status !== 'success') throw new Error(data.message || '获取下载链接失败');
  return data;
}

function flattenLinks(data) {
  const groups = [];
  const push = (label, arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    const items = arr
      .map((it) => {
        const url = String(it.link || it.url || '').trim();
        if (!url) return null;
        const kind = it.type_key || (/^magnet:/i.test(url) ? 'magnet' : /^ed2k:/i.test(url) ? 'ed2k' : 'pan');
        return {
          group: label,
          name: String(it.name || '').trim(),
          size: String(it.size || '').trim(),
          magnet: /^magnet:/i.test(url) ? url : '',
          url,
          kind,
          typeName: String(it.type_name || '').trim(),
          hash: extractHash(url),
        };
      })
      .filter(Boolean);
    if (items.length) groups.push({ group: label, items });
  };

  const jd = data.json_data;
  if (jd && typeof jd === 'object' && !Array.isArray(jd)) {
    for (const [label, arr] of Object.entries(jd)) push(label, arr);
  }
  push('其他资源', data.phoneshow);
  push('其他资源', data.xunleishow);
  return groups;
}

/** 详情页：抓页面 → 过验证 → 取磁力 */
export async function bDetail(url) {
  const { siteUrl } = requireB();
  const page = await httpRequest(url, { jar, headers: { Referer: siteUrl } });
  const html = page.text;
  const gate = html.match(/id="secure-gate"[^>]*data-rid="(\d+)"[^>]*data-cid="(\d+)"[^>]*data-hash="([0-9a-zA-Z]+)"/);
  if (!gate) throw new Error('页面结构变化，未找到资源参数');

  const meta = { rid: gate[1], cid: gate[2], hash: gate[3] };
  const data = await fetchLinks(meta, url);

  const titleMatch =
    html.match(/《([^》]{1,80})》\s*(?:电影|电视剧|动漫|影片)?剧情简介/) || html.match(/<title>\s*([^<「]{1,80})/);
  const title = stripTags(data.title || (titleMatch ? titleMatch[1] : '')) || '未知资源';

  const grab = (label) => {
    const re = new RegExp(`${label}[：:]\\s*<?[^>]*>?\\s*([^<\\n]{1,80})`);
    const m = html.match(re);
    return m ? stripTags(m[1]) : '';
  };
  const imgMatch = html.match(/<img[^>]+src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/i);

  const groups = flattenLinks(data);
  return {
    source: 'b',
    id: url,
    title: decodeEntities(title),
    image: imgMatch ? imgMatch[1] : '',
    year: grab('年代'),
    score: grab('豆瓣评分'),
    meta: {
      导演: grab('导演'),
      主演: grab('主演'),
      类型: grab('类型'),
      地区: grab('地区'),
      片长: grab('片长'),
      语言: grab('语言'),
      更新: grab('更新时间'),
    },
    seedCount: groups.reduce((n, g) => n + g.items.length, 0),
    needLogin: false,
    groups,
  };
}

/** 站内搜索（英文/数字有效；中文会被站点风控拦掉，返回空） */
export async function bSearch(keyword) {
  const { searchUrl, siteUrl } = requireB();
  const res = await httpRequest(searchUrl, {
    method: 'POST',
    jar,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${siteUrl}/`,
      Origin: siteUrl,
    },
    body: encodeForm({ show: 'title,ftitle,actor', keyboard: keyword }),
  });
  return parseResultPage(res.text);
}

/** 搜索结果页解析（与分类列表同构，复用通用解析） */
export function parseResultPage(html) {
  const items = parseItems(html).map((it) => ({
    source: 'b',
    id: it.u,
    title: it.t,
    image: '',
    score: it.s,
    quality: it.q,
    year: '',
    cat: it.c,
    link: it.u,
  }));
  return { total: items.length, items };
}

/**
 * 列表项通用解析：兼容两种版式
 *  1) 卡片版：<li><a class="e" href="/cat/id.html"><picture>…</picture></a><span class="score">7.3</span><span class="listtype">1080p</span>…<p><a href="…">标题</a></p><p>类型</p></li>
 *  2) 纯文本版：<li><a href="/cat/id.html"><font>标题</font></a><em>1080p</em><span>7.3</span></li>
 */
function parseItems(html, cat) {
  const { siteUrl } = requireB();
  const out = [];
  const seen = new Set();
  const chunks = String(html).split(/<li[\s>]/i).slice(1);
  for (const raw of chunks) {
    const chunk = raw.slice(0, 2000);
    // 结果页用绝对地址，分类页用相对地址，这里都兼容
    const link = chunk.match(/href="(?:https?:\/\/[^"/]+)?\/([a-z_0-9]+)\/(\d+)\.html"/);
    if (!link) continue;
    const url = `${siteUrl}/${link[1]}/${link[2]}.html`;
    if (seen.has(url)) continue;

    let title = '';
    const pTitle = chunk.match(/<p>\s*<a[^>]*>([\s\S]{0,200}?)<\/a>\s*<\/p>/);
    if (pTitle) title = stripTags(pTitle[1]);
    if (!title) {
      const aTitle = chunk.match(/<a[^>]*>([\s\S]{0,200}?)<\/a>/);
      if (aTitle) title = stripTags(aTitle[1]);
    }
    if (!title) continue;
    if (/^(科幻片|动画片|动作片|喜剧片|爱情片|恐怖片|战争片|剧情片|纪录片|高清|首页)$/.test(title)) continue;

    const score =
      (chunk.match(/class="score">\s*([\d.]*)/) || chunk.match(/<span>\s*([\d.]*)\s*<\/span>/))?.[1] || '';
    const quality =
      (chunk.match(/class="listtype">\s*([^<]*)/) || chunk.match(/<em>\s*([^<]*)\s*<\/em>/))?.[1] || '';

    seen.add(url);
    out.push({
      t: title,
      u: url,
      c: cat || link[1],
      q: quality.trim(),
      s: score.trim(),
    });
  }
  return out;
}

/** 分类列表页解析（供本地片库索引使用） */
export function parseListPage(html, cat) {
  return parseItems(html, cat);
}

export function bEnabled() {
  return loadSettings().b.enabled !== false;
}

export const CATEGORIES = [
  { key: 'dongzuopian', label: '动作片', group: 'movie' },
  { key: 'xijupian', label: '喜剧片', group: 'movie' },
  { key: 'aiqingpian', label: '爱情片', group: 'movie' },
  { key: 'kehuanpian', label: '科幻片', group: 'movie' },
  { key: 'kongbupian', label: '恐怖片', group: 'movie' },
  { key: 'zhanzhengpian', label: '战争片', group: 'movie' },
  { key: 'juqingpian', label: '剧情片', group: 'movie' },
  { key: 'm_jlp', label: '纪录片', group: 'movie' },
  { key: 'donghuapian', label: '动画片', group: 'anime' },
  { key: 'gaoqing', label: '高清', group: 'movie' },
  { key: 'guochanju', label: '国产剧', group: 'tv' },
  { key: 'gangju', label: '港剧', group: 'tv' },
  { key: 'taiwanju', label: '台剧', group: 'tv' },
  { key: 'riju', label: '日剧', group: 'tv' },
  { key: 'hanju', label: '韩剧', group: 'tv' },
  { key: 'oumeiju', label: '美剧', group: 'tv' },
  { key: 'taiguoju', label: '泰剧', group: 'tv' },
  { key: 'haiwaiju', label: '海外剧', group: 'tv' },
  { key: 'weidianying', label: '微电影', group: 'movie' },
];
