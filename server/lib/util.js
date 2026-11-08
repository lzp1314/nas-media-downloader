import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

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

function errWith(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

/** 代理地址解析：支持 http:// https:// socks5://，不写协议按 http 处理 */
export function parseProxy(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  const proto = u.protocol.replace(':', '').toLowerCase();
  const isSocks = proto === 'socks5' || proto === 'socks5h' || proto === 'socks';
  if (!isSocks && proto !== 'http' && proto !== 'https') return null;
  const port = Number(u.port || (isSocks ? 1080 : 8080));
  if (!u.hostname || !port) return null;
  const auth = u.username
    ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`
    : '';
  return { kind: isSocks ? 'socks5' : 'http', host: u.hostname, port, auth };
}

function connectProxy(proxy, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    const fail = (e) => {
      sock.destroy();
      reject(errWith(`连不上代理 ${proxy.host}:${proxy.port}（${e.code || e.message || '无响应'}）`, e.code || 'EPROXYCONN'));
    };
    sock.once('connect', () => {
      sock.setTimeout(0);
      resolve(sock);
    });
    sock.once('error', fail);
    sock.setTimeout(timeout, () => fail(errWith('连接代理超时', 'ETIMEDOUT')));
  });
}

/**
 * 带缓冲的套接字读取器：握手阶段读固定字节或读到分隔符。
 * 用单一 data 监听 + 队列，避免 unshift 丢包和 TCP 粘包/拆包问题。
 */
function makeReader(sock, timeout) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  let dead = false;

  const fail = (err) => {
    dead = true;
    while (waiters.length) {
      const w = waiters.shift();
      w.reject(err);
    }
  };

  const flush = () => {
    while (waiters.length) {
      const w = waiters[0];
      let take = 0;
      if (w.until) {
        const idx = buf.indexOf(w.until);
        if (idx < 0) break;
        take = idx + w.until.length;
      } else {
        if (buf.length < w.n) break;
        take = w.n;
      }
      waiters.shift();
      const out = buf.subarray(0, take);
      buf = buf.subarray(take);
      w.resolve(Buffer.from(out));
    }
  };

  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    flush();
  };
  const onError = (e) => fail(e);
  const onTimeout = () => fail(errWith('代理响应超时', 'ETIMEDOUT'));

  sock.on('data', onData);
  sock.once('error', onError);
  sock.setTimeout(timeout, onTimeout);

  const need = (opts) => new Promise((resolve, reject) => {
    if (dead) {
      reject(errWith('代理连接已断开', 'EPROXY'));
      return;
    }
    waiters.push({ n: opts.n, until: opts.until, resolve, reject });
    flush();
  });

  return {
    read: (n) => need({ n }),
    readUntil: (token) => need({ until: Buffer.from(token, 'latin1') }),
    detach: () => {
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      sock.setTimeout(0);
    },
  };
}

async function httpTunnel(proxy, host, port, timeout) {
  const sock = await connectProxy(proxy, timeout);
  const reader = makeReader(sock, timeout);
  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`, 'Proxy-Connection: keep-alive'];
  if (proxy.auth) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth, 'utf8').toString('base64')}`);
  }
  sock.write(`${lines.join('\r\n')}\r\n\r\n`);
  let head;
  try {
    head = (await reader.readUntil('\r\n\r\n')).toString('latin1');
  } finally {
    reader.detach();
  }
  const statusLine = head.split('\r\n')[0] || '';
  const m = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  if (!m || m[1] !== '200') {
    sock.destroy();
    throw errWith(`代理拒绝转发（${statusLine.slice(0, 48) || '无响应'}）`, 'EPROXYDENY');
  }
  return sock;
}

async function socks5Tunnel(proxy, host, port, timeout) {
  const sock = await connectProxy(proxy, timeout);
  const reader = makeReader(sock, timeout);
  try {
    const needAuth = Boolean(proxy.auth);
    sock.write(Buffer.from(needAuth ? [5, 2, 0, 2] : [5, 1, 0]));
    const hello = await reader.read(2);
    if (hello[0] !== 5) throw errWith('代理不是 SOCKS5 协议', 'EPROXY');
    if (hello[1] === 2) {
      const [user, pass] = String(proxy.auth).split(':');
      const ub = Buffer.from(user || '', 'utf8');
      const pb = Buffer.from(pass || '', 'utf8');
      sock.write(Buffer.concat([Buffer.from([1, ub.length]), ub, Buffer.from([pb.length]), pb]));
      const ok = await reader.read(2);
      if (ok[1] !== 0) throw errWith('代理账号或密码不对', 'EPROXYAUTH');
    } else if (hello[1] !== 0) {
      throw errWith('代理不接受免密连接', 'EPROXYAUTH');
    }

    const ipVer = net.isIP(host);
    let addr;
    if (ipVer === 4) {
      addr = Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))]);
    } else if (ipVer === 6) {
      const full = host.includes('::')
        ? (() => {
            const [a, b] = host.split('::');
            const left = a ? a.split(':') : [];
            const right = b ? b.split(':') : [];
            const mid = new Array(Math.max(0, 8 - left.length - right.length)).fill('0');
            return [...left, ...mid, ...right];
          })()
        : host.split(':');
      const bytes = [];
      for (const part of full) {
        const n = parseInt(part || '0', 16);
        bytes.push((n >> 8) & 255, n & 255);
      }
      addr = Buffer.concat([Buffer.from([4]), Buffer.from(bytes)]);
    } else {
      const hb = Buffer.from(host, 'utf8');
      addr = Buffer.concat([Buffer.from([3, hb.length]), hb]);
    }
    sock.write(Buffer.concat([
      Buffer.from([5, 1, 0]),
      addr,
      Buffer.from([(port >> 8) & 255, port & 255]),
    ]));
    const reply = await reader.read(4);
    if (reply[1] !== 0) throw errWith(`代理未能建立连接（错误码 ${reply[1]}）`, 'EPROXYDENY');
    // 把绑定地址读掉，避免污染后续数据
    const atyp = reply[3];
    if (atyp === 1) await reader.read(4 + 2);
    else if (atyp === 4) await reader.read(16 + 2);
    else if (atyp === 3) {
      const len = await reader.read(1);
      await reader.read(len[0] + 2);
    }
    return sock;
  } catch (err) {
    sock.destroy();
    throw err;
  } finally {
    reader.detach();
  }
}

function tunnelTo(proxy, host, port, timeout) {
  return proxy.kind === 'socks5'
    ? socks5Tunnel(proxy, host, port, timeout)
    : httpTunnel(proxy, host, port, timeout);
}

function tlsOver(socket, servername, timeout) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername, ALPNProtocols: ['http/1.1'] });
    s.once('secureConnect', () => {
      s.setTimeout(0);
      resolve(s);
    });
    s.once('error', (e) => {
      s.destroy();
      reject(errWith(`TLS 握手失败（${e.code || e.message}）`, e.code || 'ETLS'));
    });
    s.setTimeout(timeout, () => {
      s.destroy();
      reject(errWith('TLS 握手超时', 'ETIMEDOUT'));
    });
  });
}

function agentOver(socket) {
  const Base = socket.encrypted ? https.Agent : http.Agent;
  class TunnelAgent extends Base {
    createConnection() {
      return socket;
    }
  }
  return new TunnelAgent({ keepAlive: false, maxSockets: 1 });
}

function requestOver(socket, { isHttps, hostname, port, method, path: reqPath, headers, body, timeout }) {
  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;
    let req;
    try {
      req = lib.request({
        host: hostname,
        port,
        path: reqPath,
        method,
        headers,
        agent: agentOver(socket),
        servername: hostname,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', (e) => reject(errWith(e.message || '代理响应异常', e.code || 'EPROXY')));
      });
    } catch (e) {
      socket.destroy();
      reject(errWith(e.message || '请求构造失败', e.code || 'EPROXY'));
      return;
    }
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(errWith('代理请求超时', 'ETIMEDOUT'));
    });
    req.on('error', (e) => {
      socket.destroy();
      reject(errWith(e.message || '代理请求失败', e.code || 'EPROXY'));
    });
    if (body) req.write(body);
    req.end();
  });
}

function decompressBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
  } catch {
    // 解压失败就按原始字节返回，交给上层按文本处理
  }
  return buf;
}

/** 走代理发一次请求（自带重定向与 Cookie） */
async function proxyRequest(url, opts, proxy) {
  const {
    method = 'GET',
    headers = {},
    body,
    jar,
    timeout = 25000,
    redirect = 'follow',
    binary = false,
  } = opts;

  let current = url;
  let curMethod = method;
  let curBody = body;
  const baseHeaders = { ...headers };

  for (let hop = 0; hop <= 5; hop += 1) {
    const u = new URL(current);
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port || (isHttps ? 443 : 80));
    const hdrs = { ...baseHeaders };
    if (jar) {
      const cookie = jar.get(current);
      if (cookie) hdrs.Cookie = cookie;
    }
    if (!Object.keys(hdrs).some((k) => k.toLowerCase() === 'accept-encoding')) {
      hdrs['Accept-Encoding'] = 'identity';
    }

    const raw = await tunnelTo(proxy, u.hostname, port, timeout);
    const socket = isHttps ? await tlsOver(raw, u.hostname, timeout) : raw;
    const res = await requestOver(socket, {
      isHttps,
      hostname: u.hostname,
      port,
      method: curMethod,
      path: `${u.pathname}${u.search}`,
      headers: hdrs,
      body: curBody,
      timeout,
    });

    if (jar) {
      const setCookies = res.headers['set-cookie'];
      if (setCookies) jar.capture(current, Array.isArray(setCookies) ? setCookies : [setCookies]);
    }

    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    if (redirect === 'follow' && isRedirect && res.headers.location) {
      const next = new URL(res.headers.location, current).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod !== 'GET' && curMethod !== 'HEAD')) {
        curMethod = 'GET';
        curBody = undefined;
        for (const k of Object.keys(baseHeaders)) {
          if (k.toLowerCase() === 'content-type' || k.toLowerCase() === 'content-length') delete baseHeaders[k];
        }
      }
      current = next;
      continue;
    }

    const buf = decompressBody(res.body, res.headers['content-encoding']);
    return {
      status: res.status,
      text: binary ? '' : buf.toString('utf8'),
      buffer: binary ? buf : null,
      headers: res.headers,
      url: current,
    };
  }
  throw errWith('重定向次数过多', 'EREDIRECT');
}

/**
 * 带 Cookie 的 fetch 封装：支持自动重定向、超时、编码。
 * 注意：不自动解压以外的额外处理，返回原始文本。
 * opts.proxy 传代理地址时改走代理隧道（源 B 出口被挡时用）。
 */
export async function httpRequest(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    jar,
    timeout = 25000,
    redirect = 'follow',
    binary = false,
    proxy = '',
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

  // 配了代理就走隧道：源站把本机出口 IP 挡了时，换一条线路出去
  const viaProxy = proxy ? parseProxy(proxy) : null;
  if (proxy && !viaProxy) throw errWith(`代理地址写法不对：${String(proxy).slice(0, 40)}`, 'EPROXYURL');
  if (viaProxy) {
    return proxyRequest(url, {
      method, headers: finalHeaders, body, jar, timeout, redirect, binary,
    }, viaProxy);
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
    // 二进制读取（.torrent 等）：用 arrayBuffer 保留原始字节，不能走 text() 的 UTF-8 解码
    const buffer = binary ? Buffer.from(await res.arrayBuffer()) : null;
    const text = binary ? '' : await res.text();
    if (jar) {
      const setCookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      jar.capture(url, setCookies);
    }
    return { status: res.status, text, buffer, headers: res.headers, url: res.url || url };
  } catch (err) {
    // fetch 只会抛一句「fetch failed」，真正的原因藏在 cause 里（ENOTFOUND / EHOSTUNREACH / 证书过期…）。
    // 这里把它带出来，面板上就能看到到底卡在哪一层，不用再去容器里猜。
    if (err?.name === 'AbortError') {
      const e = new Error(`请求超时（${Math.round(timeout / 1000)} 秒）`);
      e.code = 'ETIMEDOUT';
      throw e;
    }
    const cause = err?.cause || {};
    // 多地址同时尝试（happy eyeballs）失败时抛的是 AggregateError，码在 errors[] 里
    const codes = Array.isArray(cause.errors)
      ? [...new Set(cause.errors.map((x) => String(x?.code || '').trim()).filter(Boolean))]
      : [];
    const code = String(cause.code || cause.errno || codes.join('/') || '').trim();
    if (code) {
      const e = new Error(`${err.message || 'fetch failed'}（${code}）`);
      e.code = code;
      throw e;
    }
    throw err;
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
