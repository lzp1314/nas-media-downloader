import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_UA } from '../lib/util.js';

/**
 * 磁力搜索源插件层。
 *
 * 站点地址完全由配置文件提供，代码里不内置任何站点：
 *   $CONFIG_DIR/magnet-sources.json（默认 /config/magnet-sources.json，已 gitignore）
 *
 * 配置字段：
 *   url        搜索地址模板，{kw} = URL 编码关键词，{kw_b64} = base64 关键词，{kw_raw} = 原样
 *   method     GET / POST
 *   postBody   POST 表单模板，例如 q={kw}（关键词不在 URL 里时用）
 *   encoding   页面编码，GBK 页面填 gbk
 *   detail     auto（默认，结果页没磁力时自动跟进详情页）/ true / false
 *   referer    可选
 *
 * 「测试」会自动探测站点真实的搜索入口（首页表单、302 跳转、常见搜索路径），
 * 不需要用户先猜对地址；探测成功会把可用配置返回给界面，一键添加即可。
 *
 * 配置文件按 mtime 热加载，界面里的开关/增删会直接写回该文件。
 */

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const FILE = process.env.MAGNET_SOURCES_FILE || path.join(CONFIG_DIR, 'magnet-sources.json');
const CACHE_TTL = 5 * 60 * 1000;
const TEST_KEYWORD = '流浪地球';

let cache = { mtime: 0, list: [] };
const resultCache = new Map();

function defaults() {
  return { version: 1, sources: [] };
}

/* ---------------- 通用小工具 ---------------- */

/** 域名归一化：忽略 www. 与协议差异（同一站点常同时出现 http/https） */
function siteKey(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
}

/**
 * 界面列表会把 POST 源显示成「地址 · POST 参数」，用户很可能原样复制回输入框。
 * 这里把这种展示串拆回 url / method / postBody，避免把整串当网址去请求。
 */
export function splitMethodSuffix(url, method, postBody) {
  const s = String(url || '').trim();
  const m = s.match(/^(.*?)\s+[·•]\s*(POST|GET)\s+(\S.*)?$/i);
  if (!m) return { url: s, method, postBody: String(postBody || '').trim() };
  return {
    url: m[1].trim(),
    method: (m[2] || method || 'GET').toUpperCase(),
    postBody: String(postBody || m[3] || '').trim(),
  };
}

function normalizeItem(raw, index) {
  const id = String(raw?.id || '').trim() || `src-${index + 1}`;
  const cleaned = splitMethodSuffix(raw?.url, raw?.method, raw?.postBody);
  const url = cleaned.url;
  const postBody = cleaned.postBody;
  const detailRaw = raw?.detail;
  const detail = detailRaw === true || detailRaw === 'true' ? true
    : detailRaw === false || detailRaw === 'false' ? false : 'auto';
  return {
    id,
    name: String(raw?.name || '').trim() || id,
    enabled: Boolean(raw?.enabled),
    url,
    method: String(cleaned.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
    postBody,
    encoding: String(raw?.encoding || 'utf-8').trim() || 'utf-8',
    referer: String(raw?.referer || '').trim(),
    detail,
    detailLimit: Math.max(1, Math.min(12, Number(raw?.detailLimit) || 8)),
    timeout: Math.max(3000, Math.min(30000, Number(raw?.timeout) || 12000)),
    usable: /^https?:\/\//i.test(url) && (url.includes('{kw') || (postBody && postBody.includes('{kw'))),
  };
}

function readFile() {
  try {
    const st = fs.statSync(FILE);
    const mtime = st.mtimeMs;
    if (cache.mtime === mtime) return cache.list;
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const list = (Array.isArray(raw?.sources) ? raw.sources : [])
      .map(normalizeItem)
      .filter((x) => x.id && x.url);
    cache = { mtime, list };
    return list;
  } catch {
    cache = { mtime: 0, list: [] };
    return [];
  }
}

export function listSources() {
  return readFile().map((s) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    url: s.url,
    method: s.method,
    postBody: s.postBody,
    usable: s.usable,
    detail: s.detail,
  }));
}

export function enabledSources() {
  return readFile().filter((s) => s.enabled && s.usable);
}

export function sourceStatus() {
  const all = readFile();
  const on = all.filter((s) => s.enabled && s.usable);
  return { total: all.length, enabled: on.length, configured: on.length > 0, file: FILE };
}

/** 界面保存：整体覆盖，写回配置文件（原子写） */
export function saveSources(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((x, i) => normalizeItem(x, i))
    .filter((x) => x.id && x.url)
    .map(({ usable, ...rest }) => rest);
  const payload = { version: 1, sources: clean };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  cache = { mtime: 0, list: [] };
  return listSources();
}

/** 模板占位符：{kw} URL 编码 / {kw_b64} base64 无 padding / {kw_raw} 原样 */
export function fillTemplate(tpl, keyword) {
  const kw = String(keyword || '');
  const b64 = Buffer.from(kw, 'utf8').toString('base64').replace(/=+$/, '');
  return String(tpl || '')
    .replace(/\{kw_b64\}/gi, b64)
    .replace(/\{kw\}/gi, encodeURIComponent(kw))
    .replace(/\{kw_raw\}/gi, kw);
}

/** 请求一个页面，返回文本与响应信息；HTTP 非 200 不抛错，交给调用方判断 */
async function fetchPage(url, source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeout || 12000);
  try {
    const isPost = source.method === 'POST';
    const headers = {
      'User-Agent': DEFAULT_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(source.referer ? { Referer: source.referer } : {}),
    };
    let body;
    if (isPost) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = source.postBody || '';
    }
    let res;
    if (!isPost) {
      res = await fetch(url, { method: 'GET', headers, signal: controller.signal, redirect: 'follow' });
    } else {
      // POST 不能直接交给 fetch 跟重定向：301/302 会被降级成 GET，表单内容（关键词）就丢了，
      // 站点一跳域就只剩首页，看起来像「页面里没有磁力」。这里手工跟，保持 method+body。
      const visited = new Set();
      let cur = url;
      for (let hop = 0; hop < 5; hop += 1) {
        res = await fetch(cur, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' });
        const loc = res.headers.get('location');
        if (res.status === 303 && loc) {
          // 303 是「去那边用 GET 看」，按规范换 GET
          res = await fetch(new URL(loc, cur).href, { method: 'GET', headers, signal: controller.signal, redirect: 'follow' });
          break;
        }
        if (![301, 302, 307, 308].includes(res.status) || !loc) break;
        const next = new URL(loc, cur).href;
        if (visited.has(next)) break;
        visited.add(next);
        cur = next;
      }
    }
    const buf = await res.arrayBuffer();
    let text = '';
    try {
      text = new TextDecoder(source.encoding || 'utf-8').decode(buf);
    } catch {
      text = new TextDecoder('utf-8').decode(buf);
    }
    return { text, status: res.status, url: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

const MAGNET_RE = /magnet:\?[^"'\s<>]+/gi;
const HASH_RE = /xt=urn:btih:([a-zA-Z0-9]{32,40})/i;
const SIZE_RE = /([\d.]+\s*(?:TB|GB|MB|KB|GiB|MiB))\b/i;
const SIZE_LABEL_RE = /(?:种子大小|文件大小|资源大小|内容大小|大小|content\s*size|file\s*size|total\s*size|torrent\s*size|size)\s*[:：]?\s*([\d.]+\s*(?:TB|GB|MB|KB|GiB|MiB))/i;
const HASH40_RE = /\b([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})\b/;
// 详情页磁力按钮上的泛用文案，不能当片名
const GENERIC_TITLE_RE = /^(打开链接|复制链接|下载|点击下载|立即下载|磁力链接|magnet|download|link|点此|下载地址|获取磁力|复制|打开连接|在线云播|种子下载|copy|copy link|open link)$/i;

function titleFromPage(page) {
  const t = page.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  if (!t) return '';
  return cleanHtml(t[1]).replace(/\s*[_|\-–]\s*[^_|\-–]{1,20}\s*$/, '').trim();
}

/**
 * 详情页的结构化标题：<h1>/<h2>（class 像标题的加权）。
 * 很多站把片名放在这里，而 <title> 会拼上站名、按钮文案又太泛。
 */
function structuralTitle(page) {
  const re = /<h([12])([^>]*)>([\s\S]{0,300}?)<\/h\1>/gi;
  const cands = [];
  let m;
  while ((m = re.exec(page))) {
    const cls = (m[2].match(/class\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const text = cleanHtml(m[3]).replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 160) continue;
    cands.push({ text, weight: /title|magnet|bt-|subject|name|head|movie|file/i.test(cls) ? 2 : 1 });
  }
  if (!cands.length) return '';
  cands.sort((a, b) => b.weight - a.weight || b.text.length - a.text.length);
  return cands[0].text;
}

function cleanHtml(s = '') {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/<[^>]*>/g, ' ');
}

function nameFromDn(magnet) {
  try {
    const m = String(magnet).match(/[?&]dn=([^&]+)/i);
    if (!m) return '';
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim().slice(0, 160);
  } catch {
    return '';
  }
}

/** 从一段 HTML 中抽出磁力条目；磁力通常在 <a href> 属性里，不能先删标签再找 */
export function extractFromHtml(html, baseUrl, source, limit = 40, meta = {}) {
  const page = String(html || '');
  const found = page.match(MAGNET_RE) || [];
  // 有些详情页只给 40 位 hash，不拼 magnet: 前缀，这里补成可用磁力
  const bareHashes = found.length ? [] : (page.match(/\b[a-fA-F0-9]{40}\b/g) || []);
  const candidates = found.length ? found : bareHashes.map((h) => `magnet:?xt=urn:btih:${h}`);
  // 整页剥标签后的纯文本，用于「Content Size : 6.85 GB」这类被标签隔开的标签值
  const plain = cleanHtml(page).replace(/\s+/g, ' ');
  const structural = structuralTitle(page);
  const labelSize = (plain.match(SIZE_LABEL_RE) || [])[1] || '';
  const pageTitle = titleFromPage(page);
  const out = [];
  const seen = new Set();
  for (const raw of candidates) {
    const magnet = String(raw).replace(/&amp;/gi, '&').replace(/&#38;/gi, '&').trim();
    const hm = magnet.match(HASH_RE);
    if (!hm) continue;
    const hash = hm[1].toLowerCase();
    if (seen.has(hash)) continue;
    seen.add(hash);

    const at = page.indexOf(raw);
    let title = nameFromDn(magnet);
    if (!title && at >= 0) {
      // 磁力在 <a href="magnet:...">标题</a> 里：取这对标签中间的文字
      const start = page.lastIndexOf('<a', at);
      const tagEnd = page.indexOf('>', start);
      if (start >= 0 && tagEnd > at) {
        const close = page.indexOf('</a>', tagEnd);
        if (close > tagEnd) {
          const anchor = cleanHtml(page.slice(tagEnd + 1, close)).trim();
          if (anchor && !GENERIC_TITLE_RE.test(anchor)) title = anchor;
        }
      }
      // 详情页常见的结构化标题（<h1 class="bt-title"> / <h2 class="magnet-title">）
      if (!title && structural && !GENERIC_TITLE_RE.test(structural)) title = structural;
      if (!title) {
        const around = page.slice(Math.max(0, at - 300), at + 300);
        const attr = around.match(/title\s*=\s*["']([^"']{3,120})["']/i);
        if (attr && !GENERIC_TITLE_RE.test(attr[1].trim())) title = cleanHtml(attr[1]).trim();
      }
    }
    if (!title || GENERIC_TITLE_RE.test(title)) {
      // 详情页常见：<title>片名_站点</title>
      title = pageTitle || structural || meta.title || '';
    }
    if (!title) title = `磁力 ${hash.slice(0, 10)}`;

    // 体积优先取同一条结果块（li / tr / div）里的，避免抓到相邻条目
    let size = '';
    if (at >= 0) {
      const after = page.slice(at, at + 400);
      const block = after.split(/<li[\s>]|<tr[\s>]|<div[\s>]/i)[0];
      size = (cleanHtml(block).match(SIZE_RE) || [])[1] || (cleanHtml(after).match(SIZE_RE) || [])[1] || '';
    }
    if (!size) size = labelSize;
    if (!size) size = meta.size || '';

    out.push({
      id: `m:${hash}`,
      hash,
      title: title.slice(0, 160),
      magnet,
      size,
      site: source.name,
      url: baseUrl,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 详情页链接识别（不依赖站点特征）。
 *
 * 老做法是猜路径白名单（/detail/、/torrent/、.html、40 位 hash），
 * 但真实站点的详情页形态千奇百怪：有的 /!AbCd12，有的 /seed/AbCd12，
 * 还有的把链接写成 http:// 而页面本身是 https://。猜不全就一直「没找到磁力」。
 *
 * 改成看结构：把列表页里的同站链接按路径段聚类，哪一段的取值有 3 种以上、
 * 且几乎都长得像 id，就认定「这一层是详情页」，按页面顺序取前 N 条跟进。
 */
const NOISE_SEG = /^(search|list|listing|tag|tags|sort|page|user|users|login|logout|register|signup|about|contact|tool|tools|help|faq|dmca|upload|home|index|rss|sitemap|static|assets?|public|api|category|browse|top|new|hot|latest|comments?|forum|misc|member|space|plugin|link|links|friend|ad|ads)$/i;
const PAGE_EXT_RE = /\.(?:s?html?|php|aspx?|jsp|cgi)$/i;
const ID_SEG_RE = /^[!@~$]?[A-Za-z0-9_-]{3,32}(?:\.(?:s?html?|php|aspx?|jsp|cgi))?$/i;
const QUERY_KEY_RE = /^(q|kw|wd|keyword|keywords|search|s|query|term|terms|name)$/i;
const PAGING_KEY_RE = /^(p|page|pg|pn|start|offset|sort|order|orderby|asc|desc)$/i;

/** 这条链接值不值得当详情页跟进（先排掉搜索页、分页、导航） */
function keepCandidate(u) {
  const segs = u.pathname.split('/').filter(Boolean);
  const keys = [...u.searchParams.keys()];
  if (keys.some((k) => QUERY_KEY_RE.test(k))) return false;
  const pagingKey = keys.find((k) => PAGING_KEY_RE.test(k));
  if (pagingKey) {
    const val = u.searchParams.get(pagingKey) || '';
    const looksPaging = /^\d+$/.test(val) && (!segs.length || segs.some((s) => /^(search|list|listing|tag|category)$/i.test(s)));
    if (looksPaging) return false;
  }
  // 纯路径的导航/工具页直接丢；带查询参数的留给下面的聚类判断
  if (!keys.length && segs.some((s) => NOISE_SEG.test(s))) return false;
  return true;
}

/** 详情页链接：同站链接按路径段聚类，取最像「条目列表」的那一层 */
export function detailLinks(html, baseUrl, limit = 8) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }

  const rows = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let m;
  let at = 0;
  while ((m = re.exec(html))) {
    const href = m[1].trim().replace(/&amp;/gi, '&');
    if (/^(magnet:|javascript:|mailto:|tel:|data:|#)/i.test(href)) continue;
    if (/\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff2?|mp4|mkv|avi|zip|rar|7z|torrent)(\?|#|$)/i.test(href.split(/[?#]/)[0])) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (siteKey(u.hostname) !== siteKey(base.hostname)) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    if (!keepCandidate(u)) continue;
    rows.push({ href: u.href, segs: u.pathname.split('/').filter(Boolean), at: at++ });
  }
  if (rows.length < 3) return [];

  // 按路径段数分组，逐段判断「这一段的取值是不是随手生成的 id」
  const byDepth = new Map();
  for (const r of rows) {
    if (!r.segs.length || r.segs.length > 5) continue;
    const k = r.segs.length;
    if (!byDepth.has(k)) byDepth.set(k, []);
    byDepth.get(k).push(r);
  }

  // 只按段数分组还不够：/doc/AbC12.html 与 /q/5rbW… 都是 2 段，会混进同一桶，
  // 结果把「排序链接」当成详情页。所以先把「除变化位以外的固定部分」当成模板键。
  const templates = [];
  for (const [depth, group] of byDepth) {
    if (group.length < 3) continue;

    // A) 某一段是随手生成的 id：逐个位置试，按剩下的固定段分桶
    const byTpl = new Map();
    for (let i = 0; i < depth; i += 1) {
      for (const r of group) {
        const ext = (r.segs[i].match(PAGE_EXT_RE) || [''])[0];
        const tpl = '/' + r.segs.map((s, j) => (j === i ? `:id${ext}` : s)).join('/');
        let entry = byTpl.get(tpl);
        if (!entry) { entry = { i, rows: [] }; byTpl.set(tpl, entry); }
        entry.rows.push(r);
      }
    }
    for (const [tpl, { i, rows }] of byTpl) {
      if (rows.length < 3) continue;
      if (new Set(rows.map((r) => r.segs[i])).size < 3) continue;
      const idRatio = rows.filter((r) => ID_SEG_RE.test(r.segs[i])).length / rows.length;
      if (idRatio < 0.8) continue;
      templates.push({ tpl, group: rows });
    }

    // B) 路径完全一样、靠查询参数区分的站（/index.php?id=xxx），排除分页参数
    const byPath = new Map();
    for (const r of group) {
      const p = '/' + r.segs.join('/');
      if (!byPath.has(p)) byPath.set(p, []);
      byPath.get(p).push(r);
    }
    for (const [p, rows] of byPath) {
      if (rows.length < 3) continue;
      const parsed = rows.map((r) => new URL(r.href));
      const keys = [...new Set(parsed.flatMap((u) => [...u.searchParams.keys()]))]
        .filter((k) => !PAGING_KEY_RE.test(k) && !QUERY_KEY_RE.test(k));
      const queryKey = keys.find((k) => new Set(parsed.map((u) => u.searchParams.get(k))).size >= 3);
      if (!queryKey) continue;
      templates.push({ tpl: `${p}?${queryKey}=:id`, group: rows });
    }
  }
  if (!templates.length) return [];

  // 同一层的条目越多越可信；同层内按页面顺序取，保证「第一条结果」在最前
  templates.sort((a, b) => b.group.length - a.group.length);
  const out = [];
  const picked = new Set();
  for (const t of templates) {
    for (const r of t.group.slice().sort((a, b) => a.at - b.at)) {
      if (picked.has(r.href)) continue;
      picked.add(r.href);
      out.push(r.href);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 一组详情页并发抓取；结果页条目块里的体积/标题会传给详情页做兜底 */
async function followDetails(html, pageUrl, source, pageMeta = {}) {
  const links = detailLinks(html, pageUrl, source.detailLimit);
  if (!links.length) return { items: [], followed: 0 };
  const settled = await Promise.allSettled(links.map((u) => fetchPage(u, { ...source, method: 'GET' })));
  const items = [];
  let followed = 0;
  for (let i = 0; i < settled.length; i += 1) {
    if (settled[i].status !== 'fulfilled') continue;
    followed += 1;
    if (settled[i].value.status !== 200) continue;
    items.push(...extractFromHtml(settled[i].value.text, links[i], source, 8, pageMeta));
  }
  return { items, followed };
}

function shouldFollow(source) {
  return source.detail === true || source.detail === 'auto';
}

/**
 * 有些站的关键词必须 base64（浏览器里由页面 JS 转换，地址栏才会出现 ?q=5rWB…）。
 * 我们直接拼明文过去，站点回一个「keyword error / 关键词过短」的跳转页。
 * 这里只做判断，不动配置——发现这种页就用 base64 再试一次。
 */
function looksLikeKeywordError(page) {
  if (!page || page.status !== 200) return false;
  const text = String(page.text || '');
  if (!text || text.length > 80000) return false;
  if (/(keyword\s*error|invalid\s*keyword|keyword\s*invalid|关键词过短|关键词错误|关键词无效|关键字过短|关键字错误|搜索词过短|搜索词错误)/i.test(text)) return true;
  const title = (text.match(/<title[^>]*>([\s\S]{0,80}?)<\/title>/i) || [])[1] || '';
  return /(跳转提示|系统提示|错误提示)/.test(title)
    && /(页面自动\s*跳转|等待时间|error)/i.test(text)
    && text.length < 12000;
}

/** 把 URL / POST 表单里的明文关键词换成 base64，生成备用请求 */
function b64Alt(url, body, keyword) {
  const kw = String(keyword || '');
  if (!kw) return null;
  const enc = encodeURIComponent(kw);
  const b64 = Buffer.from(kw, 'utf8').toString('base64').replace(/=+$/, '');
  const swap = (s) => {
    if (!s) return '';
    if (s.includes(enc)) return s.split(enc).join(b64);
    if (s.includes(kw)) return s.split(kw).join(b64);
    return '';
  };
  const u2 = swap(url);
  const b2 = swap(body);
  if (!u2 && !b2) return null;
  return { url: u2 || url, postBody: b2 || body || '' };
}

async function runSearch(url, cfg, source) {
  const page = await fetchPage(url, cfg);
  if (page.status !== 200) throw new Error(`HTTP ${page.status}`);
  let items = extractFromHtml(page.text, page.url, source);
  let followed = 0;
  if (!items.length && shouldFollow(source)) {
    const r = await followDetails(page.text, page.url, source);
    items = r.items;
    followed = r.followed;
  }
  return { items, page, followed };
}

/** 用一份配置跑一次完整搜索：明文不灵时自动换 base64 关键词重试一次 */
async function searchOne(source, keyword) {
  const url = fillTemplate(source.url, keyword);
  const cfg = { ...source, postBody: source.postBody ? fillTemplate(source.postBody, keyword) : '' };
  const first = await runSearch(url, cfg, source);
  first.retried = '';
  if (first.items.length || String(source.url).includes('{kw_b64}')) return first;
  const alt = b64Alt(url, cfg.postBody, keyword);
  if (!alt) return first;
  try {
    const second = await runSearch(alt.url, { ...cfg, postBody: alt.postBody }, source);
    if (second.items.length) {
      second.retried = 'b64';
      return second;
    }
    // 明文那页是「关键词错误」，换编码后成了正常结果页（只是这词没结果）→ 用新的
    if (looksLikeKeywordError(first.page) && !looksLikeKeywordError(second.page)) {
      second.retried = 'b64';
      return second;
    }
  } catch {
    /* 换编码也没成，保留第一次的结果 */
  }
  return first;
}

/** 并发搜索所有启用的源，结果缓存 5 分钟，返回缓存 key 给 /api/resolve 使用 */
export async function searchMagnet(keyword) {
  const sources = enabledSources();
  if (!sources.length) return { key: '', items: [], notes: [] };
  const kw = String(keyword || '').trim();
  if (!kw) return { key: '', items: [], notes: [] };

  const settled = await Promise.allSettled(sources.map((s) => searchOne(s, kw)));
  const notes = [];
  const byHash = new Map();
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      notes.push(`${sources[i].name}：${String(r.reason?.message || r.reason).slice(0, 60)}`);
      return;
    }
    for (const it of r.value.items) {
      if (!byHash.has(it.hash)) byHash.set(it.hash, it);
    }
  });
  const items = [...byHash.values()];
  const key = crypto.createHash('sha1').update(`${kw}|${Date.now()}`).digest('hex').slice(0, 16);
  resultCache.set(key, { at: Date.now(), items });
  if (resultCache.size > 80) {
    const cutoff = Date.now() - CACHE_TTL;
    for (const [k, v] of resultCache) if (v.at < cutoff) resultCache.delete(k);
  }
  return { key, items, notes };
}

/* ------------------------------------------------------------------ */
/* 搜索入口自动探测                                                    */
/* ------------------------------------------------------------------ */

function absoluteUrl(href, origin) {
  try { return new URL(href, origin).href; } catch { return ''; }
}

/** 从首页 HTML 里解析搜索表单，生成候选配置模板 */
function formsToCandidates(html, origin) {
  const out = [];
  const forms = String(html).match(/<form[\s\S]{0,2000}?<\/form>/gi) || [];
  for (const form of forms) {
    const action = (form.match(/<form[^>]*\baction\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const method = /<form[^>]*\bmethod\s*=\s*["']post["']/i.test(form) ? 'POST' : 'GET';
    const names = [...form.matchAll(/<input[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>/gi)]
      .map((m) => ({ name: m[1], tag: m[0] }))
      .filter((x) => !/^(submit|button|reset|hidden|csrf|token)$/i.test(x.name)
        && !/\btype\s*=\s*["'](submit|button|hidden|checkbox|radio)["']/i.test(x.tag));
    const field = names[0]?.name || 'q';
    const url = absoluteUrl(action || '/', origin);
    if (!url || !url.startsWith(origin)) continue;
    if (method === 'POST') {
      out.push({ url, method, postBody: `${field}={kw}`, label: `首页表单 POST ${new URL(url).pathname}` });
      out.push({ url, method, postBody: `${field}={kw_b64}`, label: `首页表单 POST ${new URL(url).pathname}（base64）` });
    } else {
      const sep = url.includes('?') ? '&' : '?';
      out.push({ url: `${url}${sep}${field}={kw}`, method, postBody: '', label: `首页表单 GET ${new URL(url).pathname}` });
      out.push({ url: `${url}${sep}${field}={kw_b64}`, method, postBody: '', label: `首页表单 GET ${new URL(url).pathname}（base64）` });
    }
  }
  return out;
}

/**
 * 用户常常直接复制「搜过的结果页地址」粘进来（?q=5rWB… 这种已经是 base64 的值）。
 * 把 query 里的值换成占位符，就能变成可复用的模板。
 */
function templateUrlCandidates(rawUrl) {
  const out = [];
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { return out; }
  if (!u.search) return out;
  for (const [k, v] of u.searchParams.entries()) {
    if (!v || v.length < 2) continue;
    if (/^\d+$/.test(v)) continue; // 页码/分页
    if (QUERY_KEY_RE.test(k) === false && v.length < 4) continue;
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const holder of ['{kw}', '{kw_b64}']) {
      const qs = u.search.replace(new RegExp(`([?&]${esc}=)[^&]*`), `$1${holder}`);
      out.push({
        url: `${u.origin}${u.pathname}${qs}`,
        method: 'GET',
        postBody: '',
        label: `粘贴地址里的参数 ${k}（${holder === '{kw}' ? '明文' : 'base64'}）`,
      });
    }
  }
  return out;
}

/** 去重后的候选模板列表 */
function buildCandidates(raw) {
  const list = [];
  const push = (c) => {
    if (!c?.url || !/^https?:\/\//i.test(c.url)) return;
    const key = `${c.method}|${c.url}|${c.postBody || ''}`;
    if (list.some((x) => x.key === key)) return;
    list.push({ ...c, key });
  };
  let origin = '';
  try { origin = new URL(String(raw.url || '')).origin; } catch { return { origin: '', list }; }
  if (!origin) return { origin: '', list };

  // 1) 用户自己填的地址（最常见，优先）
  if (String(raw.url).includes('{kw')) {
    push({ url: raw.url, method: raw.method || 'GET', postBody: raw.postBody || '', label: '自定义地址' });
  } else {
    // 粘的是「带关键词的结果页」→ 还原成模板，比乱猜路径靠谱
    for (const c of templateUrlCandidates(raw.url)) push(c);
  }
  // 2) 常见搜索路径（用户填了首页或错误路径时兜底）
  const common = [
    `${origin}/search?q={kw}`, `${origin}/search?q={kw_b64}`,
    `${origin}/search?wd={kw}`, `${origin}/search?wd={kw_b64}`,
    `${origin}/search/{kw}`, `${origin}/s?q={kw}`,
    `${origin}/search?keyword={kw}`, `${origin}/so?q={kw}`, `${origin}/q/{kw}`,
    `${origin}/q/{kw_b64}`, `${origin}/search/{kw_b64}`,
    `${origin}/?s={kw}`, `${origin}/?q={kw}`,
  ];
  for (const url of common) push({ url, method: 'GET', postBody: '', label: `常见路径 ${new URL(url).pathname}` });
  return { origin, list };
}

/**
 * 探测一个源：按候选入口逐个试，遇到能出磁力的就返回可直接保存的配置。
 * 返回 { ok, count, sample, detected, steps, hint }
 */
export async function probeSource(raw, keyword = TEST_KEYWORD) {
  const kw = String(keyword || TEST_KEYWORD).trim() || TEST_KEYWORD;
  const base = normalizeItem({ ...raw, enabled: true }, 0);
  const steps = [];
  const built = buildCandidates(base);
  if (!built.origin) return { ok: false, count: 0, sample: [], steps, hint: '搜索地址必须是 http(s) 开头的完整网址' };

  const candidates = [...built.list];
  // 首页表单（抓取后动态追加，优先级放在常见路径之前）
  try {
    const homepage = await fetchPage(`${built.origin}/`, { ...base, method: 'GET' });
    const forms = formsToCandidates(homepage.text, built.origin);
    steps.push({ label: '站点首页', status: homepage.status, found: 0, note: forms.length ? `发现 ${forms.length} 个搜索表单` : '没有可识别的搜索表单' });
    candidates.splice(1, 0, ...forms);
  } catch (e) {
    steps.push({ label: '站点首页', status: 0, found: 0, note: String(e.cause?.code || e.message).slice(0, 50) });
  }

  const tried = new Set();
  let best = { count: 0 };
  for (const c of candidates) {
    if (tried.has(c.key)) continue;
    tried.add(c.key);
    if (steps.length > 18) break;
    const source = normalizeItem({ ...base, url: c.url, method: c.method, postBody: c.postBody, detail: 'auto', enabled: true }, 0);
    try {
      const r = await searchOne(source, kw);
      const note = r.items.length
        ? `命中 ${r.items.length} 条${r.retried ? '（换 base64 关键词后命中）' : ''}`
        : r.followed
          ? `结果页有内容，跟进了 ${r.followed} 个详情页仍无磁力`
          : looksLikeKeywordError(r.page)
            ? '站点对关键词有要求（编码或参数名不对）'
            : '页面里没有磁力链接';
      steps.push({ label: c.label, status: r.page.status, found: r.items.length, note });
      if (r.items.length > best.count) {
        best = { count: r.items.length, sample: r.items.slice(0, 3).map((x) => x.title), source, c, retried: r.retried };
      }
      if (r.items.length >= 2) break; // 够用了，不必把所有路径试完
    } catch (e) {
      steps.push({ label: c.label, status: 0, found: 0, note: String(e.cause?.code || e.message).slice(0, 50) });
    }
  }

  if (!best.count) {
    const sawKwErr = steps.some((s) => /对关键词有要求/.test(s.note));
    const sawResults = steps.some((s) => /结果页有内容/.test(s.note));
    let hint = '没抓到磁力：';
    if (sawKwErr) hint += '这个站要求 base64 关键词，程序已自动换编码重试仍没出结果，可能是当前测试词没收录，换个词再测。';
    else if (sawResults) hint += '结果页能打开，但详情页没取到磁力（可能要先登录或过验证）。';
    else hint += '站点可能需要 JS 渲染或验证码；也可以只填站点首页地址，让程序自己找表单。';
    return { ok: false, count: 0, sample: [], steps, hint };
  }
  const s = best.source;
  // 靠 base64 才通的站，直接把模板存成 base64 版，省掉以后每次都要先错一遍
  let finalUrl = s.url;
  let finalBody = s.postBody;
  if (best.retried === 'b64') {
    finalUrl = String(finalUrl).replace(/\{kw\}/gi, '{kw_b64}');
    finalBody = String(finalBody || '').replace(/\{kw\}/gi, '{kw_b64}');
  }
  return {
    ok: true,
    count: best.count,
    sample: best.sample,
    detected: {
      url: finalUrl, method: s.method, postBody: finalBody,
      encoding: s.encoding, detail: 'auto', referer: s.referer,
      detailLimit: s.detailLimit,
    },
    steps,
    hint: `已找到可用入口（${best.c.label}），点「添加」会自动采用它。`,
  };
}

/** 界面「测试」按钮：优先按现有配置直连，不行再自动探测真实入口 */
export async function testSource(raw, keyword = TEST_KEYWORD) {
  const kw = String(keyword || TEST_KEYWORD).trim() || TEST_KEYWORD;
  const source = normalizeItem({ ...raw, detail: raw?.detail ?? 'auto' }, 0);
  if (source.usable) {
    try {
      const r = await searchOne(source, kw);
      if (r.items.length) {
        return {
          ok: true, count: r.items.length, sample: r.items.slice(0, 3).map((x) => x.title),
          detected: { url: source.url, method: source.method, postBody: source.postBody, encoding: source.encoding, detail: source.detail },
          steps: [{ label: '当前配置', status: r.page.status, found: r.items.length, note: r.followed ? `自动跟进了 ${r.followed} 个详情页` : '结果页直接命中' }],
          hint: '这个地址可以直接用。',
        };
      }
    } catch {
      // 落到自动探测
    }
  }
  return probeSource(raw, kw);
}

export function cachedItems(key) {
  const hit = resultCache.get(String(key || ''));
  if (!hit || Date.now() - hit.at > CACHE_TTL) return [];
  return hit.items;
}

/** 把缓存条目转换成资源抽屉需要的格式 */
export function cachedGroups(key) {
  const items = cachedItems(key);
  if (!items.length) return [];
  return [{
    group: '磁力搜索',
    items: items.map((it) => ({ name: it.title, size: it.size, magnet: it.magnet, hash: it.hash })),
  }];
}
