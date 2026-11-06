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
import { searchIndex, syncIndex, indexStatus, loadIndex } from './indexer.js';
import { currentEngine, aria2Engine, qbitEngine } from './engine/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8080);
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const AUTH_COOKIE = 'nz_token';

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
  sendJson(res, 200, {
    settings,
    engine: { name: engine.name, ...ping },
    index: indexStatus(),
  });
});

/** 界面里不出现站点名，统一用「源 A / 源 B」标识 */
const SOURCE_LABEL = { a: '源 A', b: '源 B' };

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
      const local = searchIndex(kw, 60);
      if (local.length) {
        for (const it of local) raw.push({ source: 'b', item: it });
      } else if (/^[\x20-\x7e]+$/.test(kw)) {
        await bSearch(kw)
          .then((r) => {
            for (const it of r.items) raw.push({ source: 'b', item: it });
          })
          .catch((err) => notes.push(`资源库 B：${cleanMsg(err.message)}`));
      } else {
        notes.push('资源库 B 还没收录这部片，可在设置里同步片库');
      }
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
    variants.slice(0, 4).map(async (v) => {
      const label = SOURCE_LABEL[v.source] || v.source;
      try {
        const d = v.source === 'a' ? await sourceA.detail(v.id) : await bDetail(v.id);
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

on('POST', '/api/download', async (req, res) => {
  const { magnet, dir } = await readBody(req);
  if (!magnet || !/^magnet:\?/i.test(String(magnet))) {
    return sendJson(res, 400, { error: '仅支持磁力链接下载' });
  }
  const target = findRoot(allowedRoots(), dir || loadSettings().defaultDir);
  if (!target) return sendJson(res, 403, { error: '目标目录不在允许范围内' });
  await fsp.mkdir(target.abs, { recursive: true });
  const engine = currentEngine();
  const r = await engine.add({ magnet: String(magnet), dir: target.abs });
  sendJson(res, 200, { ok: true, id: r.id, dir: target.abs, engine: engine.name });
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
  const allowed = ['engine', 'dirs', 'defaultDir', 'aria2', 'qbit', 'a', 'b'];
  const clean = {};
  for (const k of allowed) if (k in patch) clean[k] = patch[k];
  saveSettings(clean);
  sendJson(res, 200, { ok: true, settings: publicSettings() });
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
    console.log(`[media-downloader] aria2: ${a.ok ? `ok ${a.version}` : `不可用 (${a.error})`}`);
    console.log(`[media-downloader] qbit : ${q.ok ? `ok ${q.version}` : '未连接'}`);
  });
});
