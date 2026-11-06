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

function normalizeItem(raw, index) {
  const id = String(raw?.id || '').trim() || `src-${index + 1}`;
  const url = String(raw?.url || '').trim();
  const postBody = String(raw?.postBody || '').trim();
  const detailRaw = raw?.detail;
  const detail = detailRaw === true || detailRaw === 'true' ? true
    : detailRaw === false || detailRaw === 'false' ? false : 'auto';
  return {
    id,
    name: String(raw?.name || '').trim() || id,
    enabled: Boolean(raw?.enabled),
    url,
    method: String(raw?.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
    postBody,
    encoding: String(raw?.encoding || 'utf-8').trim() || 'utf-8',
    referer: String(raw?.referer || '').trim(),
    detail,
    detailLimit: Math.max(1, Math.min(12, Number(raw?.detailLimit) || 5)),
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
    const res = await fetch(url, { method: isPost ? 'POST' : 'GET', headers, body, signal: controller.signal, redirect: 'follow' });
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
const HASH40_RE = /\b([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})\b/;
// 详情页磁力按钮上的泛用文案，不能当片名
const GENERIC_TITLE_RE = /^(打开链接|复制链接|下载|点击下载|立即下载|磁力链接|magnet|download|link|点此|下载地址|获取磁力|复制)$/i;

function titleFromPage(page) {
  const t = page.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  if (!t) return '';
  return cleanHtml(t[1]).replace(/\s*[_|\-–]\s*[^_|\-–]{1,20}\s*$/, '').trim();
}

function cleanHtml(s = '') {
  return String(s)
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
function extractFromHtml(html, baseUrl, source, limit = 40, meta = {}) {
  const page = String(html || '');
  const found = page.match(MAGNET_RE) || [];
  // 有些详情页只给 40 位 hash，不拼 magnet: 前缀，这里补成可用磁力
  const bareHashes = found.length ? [] : (page.match(/\b[a-fA-F0-9]{40}\b/g) || []);
  const candidates = found.length ? found : bareHashes.map((h) => `magnet:?xt=urn:btih:${h}`);
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
      if (!title) {
        const around = page.slice(Math.max(0, at - 300), at + 300);
        const attr = around.match(/title\s*=\s*["']([^"']{3,120})["']/i);
        if (attr && !GENERIC_TITLE_RE.test(attr[1].trim())) title = cleanHtml(attr[1]).trim();
      }
    }
    if (!title || GENERIC_TITLE_RE.test(title)) {
      // 详情页常见：<title>片名_站点</title>
      title = titleFromPage(page) || meta.title || '';
    }
    if (!title) title = `磁力 ${hash.slice(0, 10)}`;

    // 体积优先取同一条结果块（li / tr / div）里的，避免抓到相邻条目
    let size = '';
    if (at >= 0) {
      const after = page.slice(at, at + 400);
      const block = after.split(/<li[\s>]|<tr[\s>]|<div[\s>]/i)[0];
      size = (cleanHtml(block).match(SIZE_RE) || [])[1] || (cleanHtml(after).match(SIZE_RE) || [])[1] || '';
    }
    if (!size) {
      const labelled = page.match(/(?:种子大小|文件大小|资源大小|大小)\s*[:：]?\s*([\d.]+\s*(?:TB|GB|MB|KB|GiB|MiB))/i);
      if (labelled) size = labelled[1].trim();
    }
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

/** 详情页链接：只取同源、路径像详情页的，跳过导航/分页/静态资源 */
function detailLinks(html, baseUrl, limit) {
  const out = [];
  const seen = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let base;
  try { base = new URL(baseUrl); } catch { return out; }
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let href = m[1].trim().replace(/&amp;/gi, '&');
    if (/^(magnet:|javascript:|#|mailto:)/i.test(href)) continue;
    if (/\.(jpg|png|gif|css|js|ico|svg|webp|woff2?)(\?|$)/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (u.origin !== base.origin || seen.has(u.href)) continue;
      const looksDetail = /\/(doc|detail|details|info|hash|torrent|view|d|t|item|file)\//i.test(u.pathname)
        || /\/[a-z0-9_-]{4,}\.html?$/i.test(u.pathname)
        || HASH40_RE.test(u.pathname)
        || /[?&](hash|id|btih|infohash)=/i.test(u.search);
      if (!looksDetail) continue;
      seen.add(u.href);
      out.push(u.href);
    } catch {
      /* 忽略无效链接 */
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

/** 用一份配置跑一次完整搜索 */
async function searchOne(source, keyword) {
  const url = fillTemplate(source.url, keyword);
  const cfg = { ...source, postBody: source.postBody ? fillTemplate(source.postBody, keyword) : '' };
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
    } else {
      const sep = url.includes('?') ? '&' : '?';
      out.push({ url: `${url}${sep}${field}={kw}`, method, postBody: '', label: `首页表单 GET ${new URL(url).pathname}` });
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
  try { origin = new URL(String(raw.url || '')).origin; } catch { return []; }
  if (!origin) return [];

  // 1) 用户自己填的地址（最常见，优先）
  if (String(raw.url).includes('{kw')) {
    push({ url: raw.url, method: raw.method || 'GET', postBody: raw.postBody || '', label: '自定义地址' });
  }
  // 2) 常见搜索路径（用户填了首页或错误路径时兜底）
  const common = [
    `${origin}/search?q={kw}`, `${origin}/search/{kw}`, `${origin}/s?q={kw}`,
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
  const built = buildCandidates(raw);
  if (!built.origin) return { ok: false, count: 0, sample: [], steps, hint: '搜索地址必须是 http(s) 开头的完整网址' };

  const candidates = [...built.list];
  // 首页表单（抓取后动态追加，优先级放在常见路径之前）
  let homepage = null;
  try {
    homepage = await fetchPage(`${built.origin}/`, { ...base, method: 'GET' });
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
      const page = await fetchPage(fillTemplate(c.url, kw), { ...source, postBody: source.postBody ? fillTemplate(source.postBody, kw) : '' });
      let items = page.status === 200 ? extractFromHtml(page.text, page.url, source) : [];
      let followed = 0;
      if (!items.length && page.status === 200) {
        const r = await followDetails(page.text, page.url, source);
        items = r.items;
        followed = r.followed;
      }
      const note = page.status !== 200
        ? `HTTP ${page.status}`
        : items.length ? `命中 ${items.length} 条` : followed ? `跟进了 ${followed} 个详情页，仍无磁力` : '页面里没有磁力链接';
      steps.push({ label: c.label, status: page.status, found: items.length, note });
      if (items.length > best.count) {
        best = { count: items.length, sample: items.slice(0, 3).map((x) => x.title), source, c };
      }
      if (items.length >= 2) break; // 够用了，不必把所有路径试完
    } catch (e) {
      steps.push({ label: c.label, status: 0, found: 0, note: String(e.cause?.code || e.message).slice(0, 50) });
    }
  }

  if (!best.count) {
    return {
      ok: false, count: 0, sample: [], steps,
      hint: '没抓到磁力：站点可能需要 JS 渲染/验证码，或搜索入口是 POST 且带校验参数；可试填站点首页地址让程序自己找表单。',
    };
  }
  const s = best.source;
  return {
    ok: true,
    count: best.count,
    sample: best.sample,
    detected: {
      url: s.url, method: s.method, postBody: s.postBody,
      encoding: s.encoding, detail: 'auto', referer: s.referer,
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
