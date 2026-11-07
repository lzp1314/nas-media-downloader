import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadSettings, saveSettings, publicSettings, allowedRoots, DOWNLOAD_ROOT, CONFIG_DIR } from './settings.js';
import { findRoot, resolveInside, humanSize } from './lib/util.js';
import { mergeSearchItems, normalizeResources } from './lib/aggregate.js';
import { sourceA } from './sources/a.js';
import { bDetail, bSearch, bEnabled } from './sources/b.js';
import { siteStatus } from './sources/config.js';
import { searchMagnet, cachedGroups, listSources, saveSources, sourceStatus, testSource } from './sources/magnet.js';
import { listTorrentFiles, readCachedTorrent } from './sources/torrent.js';
import { classifyLink, resolveShare, resolveDownloadUrls, detectEpisode, isVideo } from './sources/pan.js';
import { searchIndex, syncIndex, indexStatus, loadIndex } from './indexer.js';
import { currentEngine, aria2Engine, qbitEngine } from './engine/index.js';

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
  const engine = currentEngine();
  const ping = await engine.ping();
  const sites = siteStatus();
  sendJson(res, 200, {
    settings,
    engine: { name: engine.name, ...ping },
    index: indexStatus(),
    sources: {
      a: Boolean(sites.a.configured),
      b: Boolean(sites.b.configured),
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
      try {
        const r = await bSearch(kw);
        live = Array.isArray(r.items) ? r.items : [];
      } catch {
        // 实时搜索失败时静默降级到索引，只要还能出结果就不打扰用户
      }
      const merged = new Map();
      for (const it of [...live, ...local]) {
        const key = String(it.id || it.link || it.title);
        if (!key || merged.has(key)) continue;
        merged.set(key, it);
      }
      for (const it of merged.values()) raw.push({ source: 'b', item: it });
      if (!merged.size) notes.push('资源库 B 暂时没找到这部片，可换个片名或在设置里同步片库');
    }
  }

  // 磁力搜索源：结果先缓存，点开资源抽屉时按 key 取出，避免重复请求
  if ((source === 'all' || source === 'm') && sourceStatus().configured) {
    try {
      const r = await searchMagnet(kw);
      if (r.items.length) {
        raw.push({
          source: 'm',
          item: { id: r.key, title: kw, quality: '', tags: `磁力搜索 ${r.items.length}`, type: '' },
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
        if (d.seedCount && (d.groups || []).length === 0) {
          notes.push(`${label} 有 ${d.seedCount} 个资源但未返回内容，可能需要登录或开通会员`);
        }
        return { source: v.source, label, groups: d.groups || [] };
      } catch (err) {
        notes.push(`${label}：${cleanMsg(err.message)}`);
        return { source: v.source, label, groups: [] };
      }
    }),
  );

  const { total, groups } = normalizeResources(packs);
  if (!total && !notes.length) notes.push('没有解析到可用资源，换个片源或稍后重试');

  sendJson(res, 200, {
    title,
    image,
    meta,
    needLogin,
    total,
    groups,
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

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/^\.+/, '_').slice(0, 180) || 'download';
}

/** 把一段链接解析成可勾选的文件列表：磁力读种子元数据，网盘读分享页 */
on('POST', '/api/link/resolve', async (req, res) => {
  const { text = '', url = '' } = await readBody(req);
  const link = classifyLink(text || url);
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
    return sendJson(res, 200, {
      ok: true,
      kind: 'magnet',
      rid,
      title: info.name,
      files,
      notes: [info.cached ? '种子目录已缓存，勾选后直接下载' : '已读到种子里的文件清单，勾选后只下选中的集数'],
    });
  }
  if (link.kind === 'url') {
    const r = await resolveShare(link.url, link.passcode);
    const files = r.files.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      size: f.size,
      sizeText: f.sizeText,
      episode: f.episode,
      video: f.video,
      hasDirect: /^https?:\/\//i.test(f.url || '') || ['quark', 'uc', 'direct'].includes(r.provider),
    }));
    const rid = putLink('pan', { kind: 'pan', share: r.share, name: r.title });
    return sendJson(res, 200, {
      ok: true,
      kind: 'pan',
      rid,
      title: r.title,
      files,
      needCookie: r.needCookie,
      notes: r.notes,
    });
  }
  return sendJson(res, 400, { error: '没识别出磁力链接或网盘分享链接' });
});

on('POST', '/api/download', async (req, res) => {
  const { magnet, dir, rid, ids = [] } = await readBody(req);
  const target = findRoot(allowedRoots(), dir || loadSettings().defaultDir);
  if (!target) return sendJson(res, 403, { error: '目标目录不在允许范围内' });
  await fsp.mkdir(target.abs, { recursive: true });
  const engine = currentEngine();
  let r;
  if (rid) {
    const rec = linkCache.get(rid);
    if (!rec || Date.now() - rec.at > LINK_TTL) {
      return sendJson(res, 400, { error: '解析结果已过期，请重新解析一次链接' });
    }
    const picked = Array.isArray(ids) ? ids : [];
    if (!picked.length) return sendJson(res, 400, { error: '请先勾选要下载的文件' });
    if (rec.kind === 'magnet') {
      const sel = picked.map(Number).filter((n) => Number.isInteger(n) && n > 0).join(',');
      if (!sel) return sendJson(res, 400, { error: '文件序号不合法' });
      if (engine.name === 'qbit') {
        // qBittorrent 用磁力原链接添加，拿到文件列表后再把未勾选的设为不下载
        r = await engine.add({ magnet: rec.magnet, dir: target.abs, selectFile: sel, hash: rec.hash });
      } else {
        const buf = await readCachedTorrent(rec.hash);
        if (!buf) return sendJson(res, 400, { error: '种子缓存已失效，请重新解析' });
        r = await engine.add({ torrent: buf.toString('base64'), dir: target.abs, selectFile: sel });
      }
    } else {
      const urls = await resolveDownloadUrls(rec.share, picked);
      for (const u of urls) u.out = safeName(u.out);
      r = await engine.add({ urls, dir: target.abs });
    }
  } else {
    if (!magnet || !/^magnet:\?/i.test(String(magnet))) {
      return sendJson(res, 400, { error: '仅支持磁力链接下载' });
    }
    r = await engine.add({ magnet: String(magnet), dir: target.abs });
  }
  sendJson(res, 200, { ok: true, id: r.id, count: r.count || 1, dir: target.abs, engine: engine.name });
});

on('GET', '/api/tasks', async (req, res) => {
  const engine = currentEngine();
  const data = await engine.list();
  sendJson(res, 200, { engine: engine.name, ...data });
});

on('POST', '/api/tasks/:id/pause', async (req, res, params) => {
  await currentEngine().pause(params.id);
  sendJson(res, 200, { ok: true });
});

on('POST', '/api/tasks/:id/resume', async (req, res, params) => {
  await currentEngine().resume(params.id);
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
  const engine = currentEngine();
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
  const allowed = ['engine', 'dirs', 'defaultDir', 'aria2', 'qbit', 'a', 'b', 'pan'];
  const clean = {};
  for (const k of allowed) if (k in patch) clean[k] = patch[k];
  saveSettings(clean);
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

on('GET', '/api/index/status', async (req, res) => sendJson(res, 200, indexStatus()));

on('POST', '/api/index/sync', async (req, res) => {
  const { pages } = await readBody(req);
  sendJson(res, 200, await syncIndex({ pages }));
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[media-downloader] listening on :${PORT}`);
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
