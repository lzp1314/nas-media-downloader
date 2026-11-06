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
 * 每个源只需要一个搜索地址模板（{kw} 为关键词占位），通用解析器会：
 *   1) 抓结果页里的 magnet: 链接，并从 dn= / 周边文本补出标题、体积
 *   2) 结果页只有详情页链接时（detail: true），跟进抓详情页里的磁力
 *   3) 按 hash 去重，合并多个源的结果
 *
 * 配置文件按 mtime 热加载，界面里的开关/增删会直接写回该文件。
 */

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const FILE = process.env.MAGNET_SOURCES_FILE || path.join(CONFIG_DIR, 'magnet-sources.json');
const CACHE_TTL = 5 * 60 * 1000;

let cache = { mtime: 0, list: [] };
const resultCache = new Map();

function defaults() {
  return { version: 1, sources: [] };
}

function normalizeItem(raw, index) {
  const id = String(raw.id || '').trim() || `src-${index + 1}`;
  const url = String(raw.url || '').trim();
  return {
    id,
    name: String(raw.name || '').trim() || id,
    enabled: Boolean(raw.enabled),
    url,
    method: String(raw.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
    encoding: String(raw.encoding || 'utf-8').trim() || 'utf-8',
    referer: String(raw.referer || '').trim(),
    detail: Boolean(raw.detail),
    detailLimit: Math.max(1, Math.min(12, Number(raw.detailLimit) || 5)),
    timeout: Math.max(3000, Math.min(30000, Number(raw.timeout) || 12000)),
    usable: /^https?:\/\//i.test(url) && url.includes('{kw}'),
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

async function fetchText(url, source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeout);
  try {
    const res = await fetch(url, {
      method: source.method,
      headers: {
        'User-Agent': DEFAULT_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(source.referer ? { Referer: source.referer } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    try {
      return new TextDecoder(source.encoding).decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  } finally {
    clearTimeout(timer);
  }
}

const MAGNET_RE = /magnet:\?[^"'\s<>]+/gi;
const HASH_RE = /xt=urn:btih:([a-zA-Z0-9]{32,40})/i;
const SIZE_RE = /([\d.]+\s*(?:TB|GB|MB|KB|GiB|MiB))\b/i;

function cleanHtml(s = '') {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/g, '"')
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
function extractFromHtml(html, baseUrl, source, limit = 40) {
  const page = String(html || '');
  const found = page.match(MAGNET_RE) || [];
  const out = [];
  const seen = new Set();
  for (const raw of found) {
    const magnet = raw.replace(/&amp;/gi, '&').replace(/&#38;/gi, '&').trim();
    const hm = magnet.match(HASH_RE);
    if (!hm) continue;
    const hash = hm[1].toLowerCase();
    if (seen.has(hash)) continue;
    seen.add(hash);

    const at = page.indexOf(raw);
    let title = nameFromDn(magnet);
    if (!title) {
      // 磁力在 <a href="magnet:...">标题</a> 里：取这对标签中间的文字
      const start = page.lastIndexOf('<a', at);
      const tagEnd = page.indexOf('>', start);
      if (start >= 0 && tagEnd > at) {
        const close = page.indexOf('</a>', tagEnd);
        if (close > tagEnd) title = cleanHtml(page.slice(tagEnd + 1, close)).trim();
      }
      if (!title) {
        const around = page.slice(Math.max(0, at - 300), at + 300);
        const attr = around.match(/title\s*=\s*["']([^"']{3,120})["']/i);
        if (attr) title = cleanHtml(attr[1]).trim();
      }
    }
    // 体积优先取同一条结果块（li / tr / div）里的，避免抓到相邻条目
    const after = page.slice(at, at + 400);
    const block = after.split(/<li[\s>]|<tr[\s>]|<div[\s>]/i)[0];
    const size =
      (cleanHtml(block).match(SIZE_RE) || [])[1] ||
      (cleanHtml(after).match(SIZE_RE) || [])[1] ||
      '';
    out.push({
      id: `m:${hash}`,
      hash,
      title: title || `磁力 ${hash.slice(0, 10)}`,
      magnet,
      size,
      site: source.name,
      url: baseUrl,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 结果页没有磁力时，跟进一部分详情页 */
function detailLinks(html, baseUrl, limit) {
  const out = [];
  const seen = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let href = m[1].trim();
    if (/^(magnet:|javascript:|#|mailto:)/i.test(href)) continue;
    if (/\.(jpg|png|gif|css|js|ico|svg|webp)(\?|$)/i.test(href)) continue;
    try {
      const abs = new URL(href.replace(/&amp;/g, '&'), baseUrl).href;
      if (!/^https?:\/\//i.test(abs) || seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    } catch {
      /* 忽略无效链接 */
    }
  }
  return out;
}

async function searchOne(source, keyword) {
  const url = source.url.replace('{kw}', encodeURIComponent(keyword));
  const html = await fetchText(url, source);
  let items = extractFromHtml(html, url, source);
  if (!items.length && source.detail) {
    const links = detailLinks(html, url, source.detailLimit);
    const settled = await Promise.allSettled(links.map((u) => fetchText(u, source)));
    for (let i = 0; i < settled.length; i += 1) {
      if (settled[i].status !== 'fulfilled') continue;
      items.push(...extractFromHtml(settled[i].value, links[i], source, 8));
    }
  }
  return items;
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
    for (const it of r.value) {
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

/** 界面「测试」按钮：用一个关键词试搜，返回条数与样例，方便筛选可用的源 */
export async function testSource(raw, keyword = '流浪地球') {
  const source = normalizeItem(raw, 0);
  if (!source.usable) throw new Error('搜索地址必须是 http(s) 且包含 {kw} 占位');
  const items = await searchOne(source, String(keyword || '流浪地球').trim());
  return { count: items.length, sample: items.slice(0, 3).map((x) => x.title) };
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
