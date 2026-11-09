import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * NAS 上很常见的一种「莫名 fetch failed」：
 * 片源域名同时有 A 和 AAAA 记录，Node 默认按解析顺序（多数是 IPv6 优先）发起连接，
 * 而某些宽带的 IPv6 到该站其实不通，于是连接直接失败、也不重试。
 * 这里固定 IPv4 优先，并打开自动择栈（happy eyeballs）：IPv4 不通再退 IPv6，
 * 只有 AAAA 记录的站点照样能连，行为比默认更稳。
 */
try {
  dns.setDefaultResultOrder('ipv4first');
} catch { /* 老版本 Node 没有这个开关，忽略即可 */ }
try {
  net.setDefaultAutoSelectFamily(true);
} catch { /* 同上 */ }

/**
 * 片源域名可以钉到指定 IP（sites.json 里的 hostMap），只影响本进程，不动系统 hosts。
 * 用途：站点某个 IP 在本地线路被封 / DNS 被污染时，换一个能连的 IP 就恢复。
 * 实现方式是在 DNS 解析这一层拦截，fetch、net 都会走到这里。
 */
function installHostOverrides() {
  const fallback = dns.lookup.bind(dns);
  let snap = { at: 0, map: {} };
  const mapOf = () => {
    if (Date.now() - snap.at < 5000) return snap.map;
    let map = {};
    try {
      map = hostMap();
    } catch { /* 配置读不到就退回系统解析 */ }
    snap = { at: Date.now(), map };
    return map;
  };
  const patched = function lookup(hostname, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    const ip = mapOf()[String(hostname || '').toLowerCase()];
    if (ip) {
      const family = ip.includes(':') ? 6 : 4;
      if (opts && opts.all) return process.nextTick(() => cb(null, [{ address: ip, family }]));
      return process.nextTick(() => cb(null, ip, family));
    }
    return fallback(hostname, opts, cb);
  };
  dns.lookup = patched;
}
installHostOverrides();

import { loadSettings, saveSettings, publicSettings, allowedRoots, DOWNLOAD_ROOT, CONFIG_DIR } from './settings.js';
import { findRoot, resolveInside, humanSize, httpRequest, DEFAULT_UA } from './lib/util.js';
import { parseTorrentMeta } from './lib/bencode.js';
import { mergeSearchItems, normalizeResources } from './lib/aggregate.js';
import { sourceA } from './sources/a.js';
import { bDetail, bSearch, bEnabled } from './sources/b.js';
import { siteStatus, requireA, hostMap } from './sources/config.js';
import { searchMagnet, cachedGroups, listSources, saveSources, sourceStatus, testSource } from './sources/magnet.js';
import { listTorrentFiles, readCachedTorrent, saveTorrentFile } from './sources/torrent.js';
import { classifyLink, detectEpisode, isVideo } from './lib/media.js';
import { createJob, getJob } from './lib/jobs.js';
import { getHot } from './sources/hot.js';
import { searchIndex, startIndexSync, indexStatus, loadIndex } from './indexer.js';
import { currentEngine, engineByName, engineMode, routeFor, qbitReady, aria2Engine, qbitEngine } from './engine/index.js';
import { listSubs, addSub, updateSub, removeSub, getSub, patchSub } from './subscribe/store.js';
import { runCheck, startScheduler, subStats } from './subscribe/runner.js';
import { scanEpisodes, missingEpisodes } from './subscribe/episodes.js';
import { suggest as doubanSuggest, subject as doubanSubject, watching as doubanWatching, doubanReady } from './sources/douban.js';
import { searchTv as tmdbSearch, tvDetail as tmdbDetail, seasonEpisodes as tmdbSeason, testConnection as tmdbTest, tmdbReady } from './sources/tmdb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8080);
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const AUTH_COOKIE = 'nz_token';
const UPDATE_REPO = process.env.UPDATE_REPO || 'lzp1314/nas-media-downloader';
const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return String(process.env.APP_VERSION || pkg.version || '1.0.0');
  } catch {
    return String(process.env.APP_VERSION || '1.0.0');
  }
})();
let updateCache = { at: 0, data: null };

/** 版本号比较：只比数字段，够用且不引入依赖 */
function newerVersion(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pb[i] || 0) > (pa[i] || 0)) return true;
    if ((pb[i] || 0) < (pa[i] || 0)) return false;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 极简路由                                                            */
/* ------------------------------------------------------------------ */
const routes = [];

function on(method, pattern, handler) {
  const parts = pattern.split('/').filter(Boolean);
  routes.push({ method, parts, handler, pattern });
}

function match(route, segs) {
  if (route.parts.length !== segs.length) return null;
  const params = {};
  for (let i = 0; i < route.parts.length; i += 1) {
    const p = route.parts[i];
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
    else if (p !== segs[i]) return null;
  }
  return params;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function authToken() {
  return crypto.createHash('sha256').update(`${ACCESS_PASSWORD}::nas-downloader`).digest('hex').slice(0, 32);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* 接口                                                                */
/* ------------------------------------------------------------------ */
on('POST', '/api/login', async (req, res) => {
  const body = await readBody(req);
  if (!ACCESS_PASSWORD) return sendJson(res, 200, { ok: true });
  if (String(body.password || '') !== ACCESS_PASSWORD) return sendJson(res, 401, { error: '密码错误' });
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${authToken()}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
  return sendJson(res, 200, { ok: true });
});

on('GET', '/api/health', async (req, res) => sendJson(res, 200, { ok: true, uptime: process.uptime() }));

on('GET', '/api/meta', async (req, res) => {
  const settings = publicSettings();
  const mode = engineMode();
  // auto 档两个引擎都可能被用到，状态都得查；单档模式下另一个只作为提示
  const [aria2Ping, qbitPing] = await Promise.all([
    aria2Engine.ping(),
    mode === 'aria2' && !qbitReady() ? Promise.resolve(null) : qbitEngine.ping(),
  ]);
  const primaryName = mode === 'qbit' ? 'qbit' : 'aria2';
  const primary = primaryName === 'qbit' ? qbitPing || aria2Ping : aria2Ping;
  const sites = siteStatus();
  sendJson(res, 200, {
    settings,
    engine: { name: primaryName, mode, ...primary },
    engines: { aria2: aria2Ping, qbit: qbitPing },
    index: indexStatus(),
    sources: {
      a: Boolean(sites.a.configured),
      b: Boolean(sites.b.configured),
      bProxy: Boolean(sites.b.proxy),
      m: Boolean(sourceStatus().configured),
    },
    version: VERSION,
  });
});

on('GET', '/api/version', async (req, res) => {
  sendJson(res, 200, { version: VERSION, repo: UPDATE_REPO });
});

/** 检测更新：对比仓库里 package.json 的版本号；多个镜像源兜底，每个请求独立超时 */
async function fetchJsonWithTimeout(url, ms = 7000, headers = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { 'User-Agent': 'nas-media-downloader', ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

on('GET', '/api/update/check', async (req, res) => {
  const fresh = updateCache.data && Date.now() - updateCache.at < 10 * 60 * 1000;
  if (fresh && !/force=1/.test(String(req.url || ''))) return sendJson(res, 200, updateCache.data);
  const out = {
    ok: false,
    current: VERSION,
    latest: VERSION,
    hasUpdate: false,
    repo: UPDATE_REPO,
    releaseUrl: `https://github.com/${UPDATE_REPO}/commits/main`,
    checkedAt: new Date().toISOString(),
  };
  // 依次尝试多个可读到 package.json 的入口，任一成功即可
  const candidates = [
    { url: `https://raw.githubusercontent.com/${UPDATE_REPO}/main/package.json`, headers: {} },
    { url: `https://cdn.jsdelivr.net/gh/${UPDATE_REPO}@main/package.json`, headers: {} },
    { url: `https://api.github.com/repos/${UPDATE_REPO}/contents/package.json?ref=main`, headers: { Accept: 'application/vnd.github+json' }, github: true },
  ];
  for (const c of candidates) {
    try {
      const j = await fetchJsonWithTimeout(c.url, 7000, c.headers);
      if (c.github && j?.content) {
        const txt = Buffer.from(String(j.content).replace(/\s/g, ''), 'base64').toString('utf8');
        out.latest = String(JSON.parse(txt).version || VERSION);
      } else {
        out.latest = String(j?.version || VERSION);
      }
      out.ok = true;
      out.hasUpdate = newerVersion(VERSION, out.latest);
      out.via = new URL(c.url).host;
      break;
    } catch { /* 换下一个源 */ }
  }
  // 提交信息只做补充，失败不影响版本判断
  try {
    const c = await fetchJsonWithTimeout(`https://api.github.com/repos/${UPDATE_REPO}/commits/main`, 6000, { Accept: 'application/vnd.github+json' });
    out.latestSha = String(c.sha || '').slice(0, 7);
    out.latestNote = String(c.commit?.message || '').split(/\r?\n/)[0].slice(0, 100);
    out.latestDate = c.commit?.committer?.date || '';
  } catch { /* 忽略 */ }
  if (!out.ok) {
    out.error = '暂时连不上仓库，无法检查更新';
    out.hint = '可点「查看仓库」手动比对，或稍后重试（容器需要能访问 GitHub）';
  }
  updateCache = { at: Date.now(), data: out };
  sendJson(res, 200, out);
});

/** 界面里不出现站点名，统一用「源 A / 源 B」标识 */
const SOURCE_LABEL = { a: '源 A', b: '源 B', m: '磁力搜索' };

/** 提示信息里抹掉域名，避免把站点地址暴露到界面上 */
function cleanMsg(s) {
  return String(s || '')
    .replace(/https?:\/\/[^\s，。；、)）]+/g, '片源')
    .slice(0, 120);
}

on('POST', '/api/search', async (req, res) => {
  const { keyword = '', source = 'all', scope = 'all', page = 1 } = await readBody(req);
  const kw = String(keyword).trim();
  if (!kw) return sendJson(res, 200, { items: [], notes: [], indexCount: indexStatus().total });

  const notes = [];
  const raw = [];
  const tasks = [];
  const sites = siteStatus();

  if (source === 'all' || source === 'a') {
    if (!sites.a.configured) {
      notes.push('资源库 A 未接入：在 config/sites.json 填好片源地址后可用');
    } else {
      tasks.push(
        sourceA
          .search({ keyword: kw, scope, page: Number(page) || 1, limit: 24 })
          .then((r) => {
            for (const it of r.items) raw.push({ source: 'a', item: it });
          })
          .catch((err) => notes.push(`资源库 A：${cleanMsg(err.message)}`)),
      );
    }
  }

  if ((source === 'all' || source === 'b') && bEnabled()) {
    if (!sites.b.configured) {
      notes.push('资源库 B 未接入：在 config/sites.json 填好片源地址后可用');
    } else {
      // 站内实时搜索 + 本地片库索引并用：
      // 实时搜索覆盖全站（中文关键词也有效），索引在站点抖动时兜底。
      const local = searchIndex(kw, 60);
      let live = [];
      let liveErr = '';
      try {
        const r = await bSearch(kw);
        live = Array.isArray(r.items) ? r.items : [];
      } catch (err) {
        // 实时搜索失败时降级到本地索引；真一条都没有，就把失败原因带出来，
        // 「暂时没找到」和「站点连不上」是两件事，不能让用户分不清
        liveErr = cleanMsg(err.message);
      }
      const merged = new Map();
      for (const it of [...live, ...local]) {
        const key = String(it.id || it.link || it.title);
        if (!key || merged.has(key)) continue;
        merged.set(key, it);
      }
      for (const it of merged.values()) raw.push({ source: 'b', item: it });
      if (!merged.size) {
        notes.push(
          liveErr
            ? `资源库 B 这次没连上：${liveErr}`
            : '资源库 B 暂时没找到这部片，可换个片名或在设置里同步片库',
        );
      }
    }
  }

  // 磁力搜索源：结果先缓存，点开资源抽屉时按 key 取出，避免重复请求
  if ((source === 'all' || source === 'm') && sourceStatus().configured) {
    try {
      const r = await searchMagnet(kw);
      if (r.items.length) {
        const names = (r.sources || []).map((s) => s.name).filter(Boolean);
        raw.push({
          source: 'm',
          item: {
            id: r.key,
            title: kw,
            quality: '',
            tags: names.length ? `磁力 ${r.items.length}` : `磁力搜索 ${r.items.length}`,
            type: '',
            mSources: names,
            mCount: r.items.length,
          },
        });
      }
      for (const n of r.notes) notes.push(`磁力搜索：${cleanMsg(n)}`);
    } catch (err) {
      notes.push(`磁力搜索：${cleanMsg(err.message)}`);
    }
  }

  await Promise.all(tasks);
  const items = mergeSearchItems(raw, kw);
  sendJson(res, 200, { items, notes, indexCount: indexStatus().total });
});

/** 单个来源取详情（保留，便于排查） */
on('POST', '/api/detail', async (req, res) => {
  const { source, id } = await readBody(req);
  if (!source || !id) return sendJson(res, 400, { error: '缺少参数' });
  if (source === 'a') return sendJson(res, 200, await sourceA.detail(id));
  if (source === 'b') return sendJson(res, 200, await bDetail(id));
  return sendJson(res, 400, { error: '未知来源' });
});

/**
 * 一次解析一部片在所有来源下的资源，合并去重后按清晰度分档返回。
 * 前端只需把搜索结果的 variants 原样传上来。
 */
on('POST', '/api/resolve', async (req, res) => {
  const { variants = [], title = '' } = await readBody(req);
  if (!Array.isArray(variants) || variants.length === 0) {
    return sendJson(res, 400, { error: '缺少资源定位参数' });
  }

  const notes = [];
  let needLogin = false;
  let meta = {};
  let image = '';
  // 站点自己声明的种子数量：用来判断「有数字但没明细」，避免用户以为是程序丢的
  const seedExpect = [];
  let aStatus = null;

  const packs = await Promise.all(
    variants.slice(0, 6).map(async (v) => {
      const label = SOURCE_LABEL[v.source] || v.source;
      try {
        const d =
          v.source === 'a'
            ? await sourceA.detail(v.id)
            : v.source === 'm'
              ? { groups: cachedGroups(v.id), meta: {}, seedCount: 0 }
              : await bDetail(v.id);
        if (d.needLogin) needLogin = true;
        if (d.image && !image) image = d.image;
        for (const [k, val] of Object.entries(d.meta || {})) {
          if (val && !meta[k] && String(val).length < 40) meta[k] = val;
        }
        if (d.seedCount > 0) {
          // 声明有种子却一条明细分不到：顺手确认登录态，好把原因说准（未登录 / 已失效 / 权限）
          const gotSeed = (d.groups || []).some((g) =>
            (g.items || []).some((x) => x.kind === 'magnet' || x.kind === 'torrent' || x.kind === 'seed'),
          );
          if (v.source === 'a' && !gotSeed && !aStatus) {
            aStatus = await sourceA.status().catch(() => null);
          }
          seedExpect.push({ label, count: d.seedCount, needLogin: Boolean(d.needLogin), login: aStatus });
        }
        return { source: v.source, label, groups: d.groups || [] };
      } catch (err) {
        notes.push(`${label}：${cleanMsg(err.message)}`);
        return { source: v.source, label, groups: [] };
      }
    }),
  );

  const { total, groups, facets } = normalizeResources(packs);
  const expectSeed = seedExpect.reduce((sum, x) => sum + x.count, 0);
  if (expectSeed > (facets.seed || 0)) {
    const who = seedExpect[0]?.label || '片源';
    const reason = aStatus?.reason || '';
    let hint;
    if (reason === 'expired') {
      hint = `${who}：登录状态已失效，站点不给 ${expectSeed} 个种子的明细。点右边「重新登录」重登${who}账号后会自动刷新`;
    } else if (reason === 'none') {
      hint = `${who}：站点要求登录后才下发种子明细，这里还没登录${who}账号。点右边「登录${who}」登录后会自动刷新`;
    } else if (reason === 'error') {
      hint = `${who}：账号校验没通过（${aStatus.message || '站点返回异常'}），站点不给 ${expectSeed} 个种子的明细。可以点右边「重新登录」再试`;
    } else if (reason === 'ok') {
      hint = `${who}：账号已登录（${aStatus.vip ? '会员' : '普通用户'}），但站点这次仍没下发 ${expectSeed} 个种子的明细，多为站点限流或权限限制，稍后重开本面板可再试`;
    } else {
      hint = `${who}：站点有 ${expectSeed} 个种子但没有下发明细，登录${who}账号后重开本面板可再试`;
    }
    notes.push(hint);
  }
  if (!total && !notes.length) notes.push('没有解析到可用资源，换个片源或稍后重试');

  sendJson(res, 200, {
    title,
    image,
    meta,
    needLogin,
    total,
    groups,
    facets,
    seedExpect: expectSeed,
    login: aStatus,
    notes: [...new Set(notes)],
  });
});

/* 最近一次「链接解析」结果只留在服务端，浏览器拿 rid 回来勾选文件 */
const linkCache = new Map();
const LINK_TTL = 30 * 60 * 1000;

function putLink(kind, payload) {
  for (const [k, v] of linkCache) if (Date.now() - v.at > LINK_TTL) linkCache.delete(k);
  const rid = `${kind}-${crypto.randomBytes(6).toString('hex')}`;
  linkCache.set(rid, { ...payload, at: Date.now() });
  return rid;
}

/** 站点只给 .torrent 下载地址时：取回种子 → 还原磁力 → 落盘缓存，之后完全复用磁力链路 */
const seedCache = new Map();
async function loadSeed(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('种子地址无效');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('种子地址协议不支持');
  // 只允许请求已配置片源的域名，避免这个入口被用来探测内网
  const hosts = new Set();
  try {
    const a = requireA();
    for (const base of [a.baseUrl, ...(a.mirrors || [])]) {
      if (base) hosts.add(new URL(base).host);
    }
  } catch { /* 未配置片源时跳过白名单校验 */ }
  if (hosts.size && !hosts.has(url.host)) throw new Error('种子地址不在已配置的片源域名内');

  const hit = seedCache.get(url.toString());
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) {
    await saveTorrentFile(hit.meta.hash, hit.buf); // 磁盘缓存可能被清过，命中时补一次
    return hit.meta;
  }
  let buf = Buffer.alloc(0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await httpRequest(url.toString(), {
      binary: true,
      headers: { Referer: `${url.origin}/`, 'User-Agent': DEFAULT_UA },
      jar: sourceA.jar,
      timeout: 20000,
    });
    buf = res.buffer || Buffer.alloc(0);
    if (res.status === 200 && buf.length >= 20 && buf[0] === 0x64) break;
    // 站点前置 JS Cookie 校验页：按页面脚本写入 Cookie 再取一次，服务端冷启动也能拿到种子
    const m = buf.subarray(0, 4096).toString('utf8')
      .match(/document\.cookie\s*=\s*"([^=]+)=([^;]+);/);
    if (!m || attempt === 1) break;
    sourceA.jar.set(url.toString(), m[1].trim(), m[2].trim());
  }
  if (buf.length < 20 || buf[0] !== 0x64) {
    throw new Error('种子文件没取到（站点可能需要登录或会员）');
  }
  let meta;
  try {
    meta = parseTorrentMeta(buf);
  } catch (err) {
    throw new Error(`种子文件解析失败：${err.message}`);
  }
  await saveTorrentFile(meta.hash, buf);
  if (seedCache.size > 200) seedCache.clear();
  seedCache.set(url.toString(), { meta, buf, at: Date.now() });
  return meta;
}

/** 真正干活的解析逻辑，放进后台任务里跑，返回结构保持不变 */
async function resolveLinkPayload(link, opts = {}) {
  if (opts.torrentUrl) {
    const seed = await loadSeed(opts.torrentUrl);
    // 种子已落盘，listTorrentFiles 会直接命中缓存，选集/下载与普通磁力完全一致
    return resolveLinkPayload({ kind: 'magnet', url: seed.magnet });
  }
  // 粘贴框里直接贴 .torrent 地址：落盘后走和普通磁力完全一样的选集链路
  if (link.kind === 'torrent') return resolveLinkPayload(null, { torrentUrl: link.url });
  if (link.kind === 'magnet') {
    const info = await listTorrentFiles(link.url);
    const files = info.files.map((f) => {
      const base = path.basename(f.path);
      return {
        id: String(f.index),
        index: f.index,
        name: base,
        path: f.path,
        size: f.length,
        sizeText: humanSize(f.length),
        episode: detectEpisode(`${f.path} ${base}`),
        video: isVideo(f.path),
      };
    });
    const rid = putLink('bt', { kind: 'magnet', hash: info.hash, name: info.name, magnet: link.url });
    return {
      ok: true,
      kind: 'magnet',
      rid,
      title: info.name,
      files,
      notes: [info.cached ? '种子目录已缓存，勾选后直接下载' : '已读到种子里的文件清单，勾选后只下选中的集数'],
    };
  }
  throw new Error('只支持磁力链接或 .torrent 种子地址');
}

/** 立刻回任务号，避免长请求被反代掐断 */
on('POST', '/api/link/resolve', async (req, res) => {
  const { text = '', url = '', torrentUrl = '' } = await readBody(req);
  if (torrentUrl) {
    const job = createJob(() => resolveLinkPayload(null, { torrentUrl }));
    return sendJson(res, 200, { pending: true, jobId: job.id, kind: 'magnet' });
  }
  const link = classifyLink(text || url);
  if (link.kind === 'unknown') {
    return sendJson(res, 400, { error: '只支持磁力链接或 .torrent 种子地址；网盘分享链接请到网盘官方客户端转存' });
  }
  const job = createJob(() => resolveLinkPayload(link));
  sendJson(res, 200, { pending: true, jobId: job.id, kind: link.kind });
});

on('GET', '/api/link/status', async (req, res, params, url) => {
  const job = getJob(url.searchParams.get('id'));
  if (!job) return sendJson(res, 404, { error: '解析任务已过期，请重新点「解析」' });
  if (job.state === 'running') {
    return sendJson(res, 200, { state: 'running', elapsed: Math.round((Date.now() - job.startedAt) / 1000) });
  }
  if (job.state === 'error') return sendJson(res, 200, { state: 'error', error: cleanMsg(job.error) });
  return sendJson(res, 200, { state: 'done', result: job.result });
});

on('POST', '/api/download', async (req, res) => {
  const { magnet, dir, rid, ids = [], torrentUrl = '' } = await readBody(req);
  const target = findRoot(allowedRoots(), dir || loadSettings().defaultDir);
  if (!target) return sendJson(res, 403, { error: '目标目录不在允许范围内' });
  await fsp.mkdir(target.abs, { recursive: true });
  let r;
  let route;
  if (rid) {
    const rec = linkCache.get(rid);
    if (!rec || Date.now() - rec.at > LINK_TTL) {
      return sendJson(res, 400, { error: '解析结果已过期，请重新解析一次链接' });
    }
    const picked = Array.isArray(ids) ? ids : [];
    if (!picked.length) return sendJson(res, 400, { error: '请先勾选要下载的文件' });
    if (rec.kind !== 'magnet') return sendJson(res, 400, { error: '解析结果已过期，请重新解析一次链接' });
    const sel = picked.map(Number).filter((n) => Number.isInteger(n) && n > 0).join(',');
    if (!sel) return sendJson(res, 400, { error: '文件序号不合法' });
    route = routeFor('torrent');
    if (route.engine.name === 'qbit') {
      // qBittorrent 用磁力原链接添加，拿到文件列表后再把未勾选的设为不下载
      r = await route.engine.add({ magnet: rec.magnet, dir: target.abs, selectFile: sel, hash: rec.hash });
    } else {
      const buf = await readCachedTorrent(rec.hash);
      if (!buf) return sendJson(res, 400, { error: '种子缓存已失效，请重新解析' });
      r = await route.engine.add({ torrent: buf.toString('base64'), dir: target.abs, selectFile: sel });
    }
  } else if (torrentUrl) {
    // 站点只给 .torrent：还原成磁力（带 tracker），两个引擎都走现成的整包下载分支
    const seed = await loadSeed(torrentUrl);
    route = routeFor('torrent');
    r = await route.engine.add({ magnet: seed.magnet, dir: target.abs, hash: seed.hash });
  } else {
    if (!magnet || !/^magnet:\?/i.test(String(magnet))) {
      return sendJson(res, 400, { error: '仅支持磁力链接下载' });
    }
    route = routeFor('torrent');
    r = await route.engine.add({ magnet: String(magnet), dir: target.abs });
  }
  sendJson(res, 200, {
    ok: true,
    id: r.id,
    count: r.count || 1,
    dir: target.abs,
    engine: route.engine.name,
    mode: route.mode,
    note: route.note,
    already: Boolean(r.already),
  });
});

/**
 * 任务列表把两个引擎合并返回。
 * 以前只查当前引擎，切到 qB 后 aria2 里正在跑的任务就「凭空消失」——其实一直在下，只是没显示。
 * 临时连不上的引擎歇 60 秒再试，避免每次轮询都卡在超时上。
 */
const engineDownAt = { aria2: 0, qbit: 0 };

on('GET', '/api/tasks', async (req, res) => {
  // 自动分流档下两个引擎都在干活，没有「主引擎」一说，都查
  const mode = engineMode();
  const active = mode === 'auto' ? 'auto' : mode;
  const engines = [aria2Engine, qbitEngine].filter((e) => {
    const must = active === 'auto' ? e.name === 'aria2' : e.name === active;
    if (must) return true;
    if (e.name === 'qbit' && !qbitReady()) return false;
    return Date.now() >= (engineDownAt[e.name] || 0);
  });
  const settled = await Promise.allSettled(engines.map((e) => e.list()));
  const data = { engine: active, tasks: [], globalSpeed: 0, globalUpload: 0, speeds: {}, active: 0, waiting: 0, stopped: 0, errors: [] };
  settled.forEach((r, i) => {
    const e = engines[i];
    if (r.status === 'rejected') {
      engineDownAt[e.name] = Date.now() + 60000;
      data.errors.push({ engine: e.name, message: String(r.reason?.message || r.reason) });
      return;
    }
    data.tasks.push(...r.value.tasks);
    data.globalSpeed += r.value.globalSpeed || 0;
    data.globalUpload += r.value.globalUpload || 0;
    // 分开记一份，前端要把「总速度」拆成各引擎的速度
    data.speeds[e.name] = r.value.globalSpeed || 0;
  });
  data.active = data.tasks.filter((t) => t.status === 'downloading').length;
  data.waiting = data.tasks.filter((t) => t.status === 'queued').length;
  data.stopped = data.tasks.filter((t) => ['done', 'error', 'removed'].includes(t.status)).length;
  // 只有「必用的引擎自己挂了」才算失败：另一个引擎连不上只提示，不能把整个任务页打空
  const activeErr = data.errors.find((x) => x.engine === (active === 'auto' ? 'aria2' : active));
  if (!data.tasks.length && activeErr) throw new Error(activeErr.message);
  sendJson(res, 200, data);
});

/** 任务操作按任务自带的引擎走，不能一律用「当前引擎」 */
function engineFor(url) {
  const name = url.searchParams.get('engine');
  return name === 'aria2' || name === 'qbit' ? engineByName(name) : currentEngine();
}

on('POST', '/api/tasks/:id/pause', async (req, res, params, url) => {
  await engineFor(url).pause(params.id);
  sendJson(res, 200, { ok: true });
});

on('POST', '/api/tasks/:id/resume', async (req, res, params, url) => {
  await engineFor(url).resume(params.id);
  sendJson(res, 200, { ok: true });
});

async function purgeFiles(targetDir, name) {
  const roots = allowedRoots().map((r) => path.resolve(r));
  const candidates = [];
  if (targetDir && name) candidates.push(path.join(targetDir, name));
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (roots.includes(abs)) continue;
    const inside = roots.some((r) => resolveInside(r, abs) === abs);
    if (!inside) continue;
    try {
      const st = await fsp.lstat(abs);
      if (st.isDirectory()) await fsp.rm(abs, { recursive: true, force: true });
      else await fsp.unlink(abs);
      return true;
    } catch {
      /* 不存在 */
    }
  }
  return false;
}

on('DELETE', '/api/tasks/:id', async (req, res, params, url) => {
  const engine = engineFor(url);
  const withFiles = url.searchParams.get('files') === '1';
  let snapshot = null;
  if (withFiles) {
    const data = await engine.list();
    snapshot = data.tasks.find((t) => t.id === params.id) || null;
  }
  await engine.remove(params.id, withFiles);
  let purged = false;
  if (withFiles && snapshot) purged = await purgeFiles(snapshot.dir, snapshot.name);
  sendJson(res, 200, { ok: true, purged });
});

async function dirTree(root, depth = 2) {
  const out = { path: root, label: path.basename(root) || root, dirs: [] };
  async function walk(node, level) {
    if (level > depth) return;
    let entries = [];
    try {
      entries = await fsp.readdir(node.path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const child = { path: path.join(node.path, e.name), label: e.name, dirs: [] };
      node.dirs.push(child);
      if (level < depth) await walk(child, level + 1);
    }
    node.dirs.sort((a, b) => a.label.localeCompare(b.label));
  }
  await walk(out, 1);
  return out;
}

on('GET', '/api/dirs', async (req, res) => {
  const trees = [];
  for (const r of allowedRoots()) trees.push(await dirTree(r, 2));
  sendJson(res, 200, { roots: trees, defaultDir: loadSettings().defaultDir });
});

on('POST', '/api/dirs/mkdir', async (req, res) => {
  const { parent, name } = await readBody(req);
  const clean = String(name || '').replace(/[\\/:*?"<>|]/g, '').trim();
  if (!clean) return sendJson(res, 400, { error: '目录名不合法' });
  const target = findRoot(allowedRoots(), path.join(parent || '', clean));
  if (!target) return sendJson(res, 403, { error: '目录不在允许范围内' });
  await fsp.mkdir(target.abs, { recursive: true });
  sendJson(res, 200, { ok: true, path: target.abs });
});

on('GET', '/api/disk', async (req, res) => {
  const disks = [];
  for (const r of allowedRoots()) {
    try {
      const st = await fsp.statfs(r);
      disks.push({
        path: r,
        total: st.blocks * st.bsize,
        free: st.bavail * st.bsize,
        totalText: humanSize(st.blocks * st.bsize),
        freeText: humanSize(st.bavail * st.bsize),
      });
    } catch {
      /* 忽略 */
    }
  }
  sendJson(res, 200, { disks });
});

on('POST', '/api/settings', async (req, res) => {
  const patch = await readBody(req);
  const allowed = ['engine', 'dirs', 'defaultDir', 'aria2', 'qbit', 'a', 'b', 'douban', 'tmdb', 'subscribe'];
  const clean = {};
  for (const k of allowed) if (k in patch) clean[k] = patch[k];
  if ('engine' in clean && !['auto', 'aria2', 'qbit'].includes(clean.engine)) {
    return sendJson(res, 400, { error: '下载引擎只能是 auto / aria2 / qbit' });
  }
  saveSettings(clean);
  // 改了 qBittorrent 地址或账号后丢掉旧会话，否则「保存并测试」可能还在用上一份 SID
  if ('qbit' in clean || clean.engine === 'qbit' || clean.engine === 'auto') qbitEngine.reset();
  sendJson(res, 200, { ok: true, settings: publicSettings() });
});

on('GET', '/api/magnet/sources', async (req, res) => {
  sendJson(res, 200, { sources: listSources(), ...sourceStatus() });
});

on('POST', '/api/magnet/sources', async (req, res) => {
  const { sources } = await readBody(req);
  const list = Array.isArray(sources) ? sources.slice(0, 30) : [];
  for (const s of list) {
    const url = String(s?.url || '').trim();
    const body = String(s?.postBody || '').trim();
    if (!/^https?:\/\//i.test(url) || (!url.includes('{kw') && !body.includes('{kw'))) {
      return sendJson(res, 400, { error: `「${String(s?.name || '未命名')}」的搜索地址不合法：需要 http(s) 开头，且地址或 POST 表单里带 {kw}` });
    }
  }
  sendJson(res, 200, { ok: true, sources: saveSources(list) });
});

on('POST', '/api/magnet/test', async (req, res) => {
  const body = await readBody(req);
  try {
    const r = await testSource(body, body.keyword || '流浪地球');
    sendJson(res, 200, { ok: true, ...r });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: cleanMsg(err.message) });
  }
});

on('GET', '/api/a/captcha', async (req, res) => {
  sendJson(res, 200, await sourceA.captcha());
});

on('POST', '/api/a/login', async (req, res) => {
  const { username, password, code, key } = await readBody(req);
  if (!username || !password) return sendJson(res, 400, { error: '请输入账号密码' });
  const r = await sourceA.login({ username, password, code, key });
  sendJson(res, 200, { ok: true, ...r });
});

on('POST', '/api/a/logout', async (req, res) => {
  sourceA.logout();
  sendJson(res, 200, { ok: true });
});

on('GET', '/api/a/me', async (req, res) => {
  sendJson(res, 200, { user: await sourceA.me() });
});

/** 登录态自检：token 有不一定还有效，这里真去站点问一次（结果缓存 60 秒） */
on('GET', '/api/a/status', async (req, res, params, url) => {
  const fresh = url.searchParams.get('fresh') === '1';
  const st = await sourceA.status({ fresh }).catch((e) => ({ hasToken: false, valid: false, reason: 'error', message: e.message }));
  sendJson(res, 200, st);
});

/** 详情只给种子 id 时，按 id 单独换磁力（站点未登录会拒绝） */
on('POST', '/api/a/magnet', async (req, res) => {
  const { id } = await readBody(req);
  if (!id) return sendJson(res, 400, { error: '缺少种子 id' });
  try {
    const magnet = await sourceA.magnet(id);
    sendJson(res, 200, { magnet });
  } catch (err) {
    sendJson(res, 409, {
      error: cleanMsg(err.message),
      needLogin: Boolean(err.needLogin),
      needVip: Boolean(err.needVip),
    });
  }
});

/** 首页热播推荐词；refresh=1 为手动刷新，其余情况走缓存后台更新 */
on('GET', '/api/hot', async (req, res, params, url) => {
  const refresh = url.searchParams.get('refresh') === '1';
  sendJson(res, 200, await getHot({ refresh }));
});

on('GET', '/api/index/status', async (req, res) => sendJson(res, 200, indexStatus()));

on('POST', '/api/index/sync', async (req, res) => {
  const { pages } = await readBody(req);
  sendJson(res, 200, startIndexSync({ pages }));
});

/* ------------------------------------------------------------------ */
/* 剧集订阅                                                            */
/* ------------------------------------------------------------------ */
on('GET', '/api/sub', async (req, res) => {
  const items = listSubs().map((s) => ({
    ...s,
    engineMode: loadSettings().engine,
    pending: Object.values(s.sent || {}).filter((x) => x.state === 'failed').length,
  }));
  sendJson(res, 200, { items, stats: subStats(), douban: { ready: doubanReady() }, tmdb: { ready: tmdbReady() } });
});

/** 单条详情：顺带把本地已有集扫出来，前端才能显示「已有 / 目标」 */
on('GET', '/api/sub/:id/status', async (req, res, params) => {
  const item = getSub(params.id);
  if (!item) return sendJson(res, 404, { error: '订阅不存在' });
  const roots = allowedRoots().map((r) => path.resolve(r));
  const abs = path.resolve(item.dir);
  const inside = roots.some((r) => abs === r || abs.startsWith(`${r}${path.sep}`));
  const have = inside ? await scanEpisodes(abs).catch(() => ({ episodes: [], files: 0, bytes: 0 })) : { episodes: [], files: 0, bytes: 0 };
  const to = Math.max(item.totalEpisodes || 0, ...(have.episodes.length ? have.episodes : [0]));
  const missing = inside ? missingEpisodes({ have: have.episodes, sent: item.sent, from: item.startEpisode, to }) : [];
  sendJson(res, 200, { item, have, missing, to, inside });
});

on('POST', '/api/sub', async (req, res) => {
  const body = await readBody(req);
  try {
    const item = addSub(body);
    // 新建的订阅立刻排在队首，用户不用等一个轮询周期才看到第一次结果
    patchSub(item.id, { nextCheckAt: Date.now() });
    sendJson(res, 200, { ok: true, item });
  } catch (err) {
    sendJson(res, 400, { error: cleanMsg(err.message) });
  }
});

on('POST', '/api/sub/:id', async (req, res, params) => {
  const body = await readBody(req);
  try {
    sendJson(res, 200, { ok: true, item: updateSub(params.id, body) });
  } catch (err) {
    sendJson(res, 400, { error: cleanMsg(err.message) });
  }
});

on('DELETE', '/api/sub/:id', async (req, res, params) => {
  try {
    removeSub(params.id);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: cleanMsg(err.message) });
  }
});

/** 手动触发一次检查：可能几十秒，走后台任务 + 轮询，避免被反代掐断 */
on('POST', '/api/sub/:id/check', async (req, res, params) => {
  const item = getSub(params.id);
  if (!item) return sendJson(res, 404, { error: '订阅不存在' });
  const job = createJob(() => runCheck(params.id, { force: true }));
  sendJson(res, 200, { pending: true, jobId: job.id });
});

on('GET', '/api/job', async (req, res, params, url) => {
  const job = getJob(url.searchParams.get('id'));
  if (!job) return sendJson(res, 404, { error: '任务已过期' });
  if (job.state === 'running') return sendJson(res, 200, { state: 'running', elapsed: Math.round((Date.now() - job.startedAt) / 1000) });
  if (job.state === 'error') return sendJson(res, 200, { state: 'error', error: cleanMsg(job.error) });
  sendJson(res, 200, { state: 'done', result: job.result });
});

/* 豆瓣：只做元数据，搜剧名公开可用，条目详情和「在看」要 Cookie */
on('GET', '/api/douban/search', async (req, res, params, url) => {
  const q = url.searchParams.get('q') || '';
  if (!q.trim()) return sendJson(res, 200, { items: [] });
  try {
    sendJson(res, 200, { items: await doubanSuggest(q) });
  } catch (err) {
    sendJson(res, 409, { error: cleanMsg(err.message), items: [] });
  }
});

on('POST', '/api/douban/lookup', async (req, res) => {
  const { id } = await readBody(req);
  if (!id) return sendJson(res, 400, { error: '缺少豆瓣条目 id' });
  try {
    sendJson(res, 200, await doubanSubject(id));
  } catch (err) {
    sendJson(res, 409, { error: cleanMsg(err.message), needCookie: Boolean(err.needCookie) });
  }
});

on('GET', '/api/douban/watching', async (req, res) => {
  try {
    sendJson(res, 200, { items: await doubanWatching() });
  } catch (err) {
    sendJson(res, 409, { error: cleanMsg(err.message), needCookie: Boolean(err.needCookie) });
  }
});

/* TMDB：同样只做元数据。比豆瓣多一个关键能力——「下一集哪天播」 */
on('GET', '/api/tmdb/search', async (req, res, params, url) => {
  const q = String(url.searchParams.get('q') || '').trim();
  if (!q) return sendJson(res, 200, { items: [] });
  try {
    sendJson(res, 200, { items: await tmdbSearch(q) });
  } catch (err) {
    sendJson(res, 409, { error: cleanMsg(err.message), code: err.code || '', needKey: err.code === 'ENEEDAUTH', items: [] });
  }
});

on('POST', '/api/tmdb/lookup', async (req, res) => {
  const { id } = await readBody(req);
  if (!Number(id)) return sendJson(res, 400, { error: '缺少 TMDB 条目 id' });
  try {
    sendJson(res, 200, await tmdbDetail(id));
  } catch (err) {
    sendJson(res, 409, { error: cleanMsg(err.message), code: err.code || '', needKey: err.code === 'ENEEDAUTH' });
  }
});

/** 某一季的逐集播出日期：目前界面不用，留给「看播出日历」这类需求 */
on('GET', '/api/tmdb/season', async (req, res, params, url) => {
  const id = Number(url.searchParams.get('id'));
  const n = Number(url.searchParams.get('n') || 1);
  if (!id) return sendJson(res, 400, { error: '缺少 TMDB 条目 id' });
  try {
    sendJson(res, 200, { episodes: await tmdbSeason(id, n) });
  } catch (err) {
    sendJson(res, 409, { error: cleanMsg(err.message), code: err.code || '' });
  }
});

/** 测试连接：由 NAS 自己发请求，能同时验证「网络通不通」和「Key 对不对」 */
on('POST', '/api/tmdb/test', async (req, res) => {
  try {
    sendJson(res, 200, await tmdbTest());
  } catch (err) {
    sendJson(res, 409, { error: cleanMsg(err.message), code: err.code || '' });
  }
});

/* ------------------------------------------------------------------ */
/* 服务器                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 访问密码门禁
  if (ACCESS_PASSWORD) {
    const isApi = pathname.startsWith('/api');
    const openPath = ['/login', '/api/login', '/api/health'].includes(pathname);
    const staticish = ['/style.css', '/app.js', '/favicon.svg', '/favicon.ico', '/logo.svg'].includes(pathname);
    const authed = parseCookies(req)[AUTH_COOKIE] === authToken();
    if (!openPath && !(staticish && !isApi) && !authed) {
      if (isApi) return sendJson(res, 401, { error: '未登录', needLogin: true });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
  }

  // 静态文件
  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(publicDir, 'index.html'));
    if (pathname === '/login') return serveFile(res, path.join(publicDir, 'login.html'));
    const staticMap = {
      '/style.css': 'style.css',
      '/app.js': 'app.js',
      '/favicon.svg': 'favicon.svg',
      '/favicon.ico': 'favicon.svg',
      '/logo.svg': 'logo.svg',
    };
    if (staticMap[pathname]) return serveFile(res, path.join(publicDir, staticMap[pathname]));
  }

  const segs = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const params = match(route, segs);
    if (!params) continue;
    try {
      await route.handler(req, res, params, url);
    } catch (err) {
      const message = String(err?.message || err);
      console.error('[api]', req.method, pathname, message);
      if (!res.headersSent) {
        sendJson(res, err?.code === 10103 ? 401 : 500, {
          error: message,
          needVip: Boolean(err?.needVip),
          unconfigured: err?.code === 'unconfigured',
        });
      }
    }
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
});

loadIndex();

/**
 * 监听地址决定能不能用 IPv6 访问。
 *
 * 以前写死 '0.0.0.0'，只接 IPv4。移动/联通家宽现在普遍给了公网 IPv6，
 * 而 IPv4 基本都在运营商 NAT 后面（WAN 口拿到 100.64.x.x 拿不到公网地址），
 * 所以 IPv6 是外网访问的唯一入口——写死 IPv4 等于把这条路堵死。
 *
 * 不指定 host 时 Node 监听 ::，Linux 默认双栈，IPv4 与 IPv6 同时能进。
 * 万一系统禁用了 IPv6（:: 会报 EAFNOSUPPORT/EADDRNOTAVAIL），退回 IPv4-only，
 * 不能因为这一条就让整个容器起不来。
 */
function listenDual(onReady) {
  const attempt = (host) => {
    const onError = (err) => {
      if (host !== '0.0.0.0' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(err.code)) {
        console.warn(`[media-downloader] IPv6 不可用（${err.code}），退回只监听 IPv4`);
        server.removeListener('error', onError);
        attempt('0.0.0.0');
        return;
      }
      throw err;
    };
    server.once('error', onError);
    if (host) server.listen(PORT, host, onReady);
    else server.listen(PORT, onReady);
  };
  attempt('');
}

listenDual(() => {
  console.log(`[media-downloader] listening on :${PORT} (${server.address()?.family || 'IPv4'})`);
  startScheduler();
  console.log(`[media-downloader] config: ${CONFIG_DIR}`);
  for (const r of allowedRoots()) {
    const ok = fs.existsSync(r);
    console.log(`[media-downloader] 存储库: ${r} ${ok ? '✓ 可读写' : '✗ 未挂载（请检查 volumes）'}`);
  }
  Promise.all([aria2Engine.ping(), qbitEngine.ping().catch(() => ({ ok: false }))]).then(([a, q]) => {
    if (a.ok) console.log(`[media-downloader] aria2: ok ${a.version}`);
    else console.error(`[media-downloader] aria2 离线：${a.error} —— 下载功能不可用，请查看 /config/aria2.log`);
    console.log(`[media-downloader] qbit : ${q.ok ? `ok ${q.version}` : '未连接'}`);
  });
});
