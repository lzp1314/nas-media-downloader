import path from 'node:path';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 极简 Cookie 容器（按 host 隔离，够用且无依赖） */
export class CookieJar {
  constructor() {
    this.store = new Map(); // host -> Map(name -> value)
  }

  hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  capture(url, setCookieHeaders) {
    const host = this.hostOf(url);
    if (!host) return;
    if (!this.store.has(host)) this.store.set(host, new Map());
    const bucket = this.store.get(host);
    for (const raw of setCookieHeaders || []) {
      const first = String(raw).split(';')[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      if (name) bucket.set(name, value);
    }
  }

  set(url, name, value) {
    const host = this.hostOf(url);
    if (!host) return;
    if (!this.store.has(host)) this.store.set(host, new Map());
    this.store.get(host).set(name, value);
  }

  get(url) {
    const host = this.hostOf(url);
    const bucket = this.store.get(host);
    if (!bucket || bucket.size === 0) return '';
    return [...bucket.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clear() {
    this.store.clear();
  }
}

/**
 * 带 Cookie 的 fetch 封装：支持自动重定向、超时、编码。
 * 注意：不自动解压以外的额外处理，返回原始文本。
 */
export async function httpRequest(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    jar,
    timeout = 25000,
    redirect = 'follow',
  } = opts;

  const finalHeaders = {
    'User-Agent': DEFAULT_UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...headers,
  };
  if (jar) {
    const cookie = jar.get(url);
    if (cookie) finalHeaders.Cookie = cookie;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: finalHeaders,
      body,
      redirect,
      signal: controller.signal,
    });
    const text = await res.text();
    if (jar) {
      const setCookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      jar.capture(url, setCookies);
    }
    return { status: res.status, text, headers: res.headers, url: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

export function encodeForm(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    p.append(k, String(v));
  }
  return p.toString();
}

export function decodeEntities(str = '') {
  return String(str)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .trim();
}

export function stripTags(str = '') {
  return decodeEntities(String(str).replace(/<[^>]*>/g, ''));
}

/** 把 "4.97 GB" / "1.2 GiB" / "800 MB" 转成字节 */
export function parseSize(str) {
  if (!str) return 0;
  const m = String(str).match(/([\d.]+)\s*(TB|GB|MB|KB|B|T|G|M|K)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase()[0];
  const mul = { T: 1024 ** 4, G: 1024 ** 3, M: 1024 ** 2, K: 1024, B: 1 }[unit] || 0;
  return Math.round(n * mul);
}

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function extractHash(magnet = '') {
  const m = String(magnet).match(/xt=urn:btih:([a-zA-Z0-9]{32,40})/);
  return m ? m[1].toLowerCase() : '';
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 把相对/绝对路径解析到某个根目录内，越界返回 null */
export function resolveInside(root, target) {
  const rootAbs = path.resolve(root);
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(rootAbs, target || '');
  const rel = path.relative(rootAbs, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // 允许等于 root 本身
    if (abs !== rootAbs) return null;
  }
  return abs;
}

/** 在多个允许根里找到路径所属的根 */
export function findRoot(roots, target) {
  for (const r of roots) {
    const abs = resolveInside(r, target);
    if (abs) return { root: r, abs };
  }
  return null;
}
