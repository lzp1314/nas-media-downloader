import fs from 'node:fs';
import path from 'node:path';
import { siteStatus } from './sources/config.js';

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const DOWNLOAD_ROOT = process.env.DOWNLOADS_DIR || '/downloads';

/**
 * 解析 DOWNLOADS_DIRS（支持多个挂载盘）：
 *   "影视=/media/movie,影视资源=/media/resource"
 *   "/media/movie,/media/resource"（自动用最后一段目录名做名称）
 * 分隔符支持 , ; 和换行。
 */
function parseRoots() {
  const raw = String(process.env.DOWNLOADS_DIRS || '');
  const out = [];
  for (const item of raw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const eq = item.indexOf('=');
    if (eq > 0) {
      const label = item.slice(0, eq).trim();
      const p = item.slice(eq + 1).trim();
      if (!p) continue;
      out.push({ label: label || path.basename(p) || p, path: p });
    } else {
      out.push({ label: path.basename(item) || item, path: item });
    }
  }
  return out;
}

const ENV_ROOTS = parseRoots();

/**
 * 自动发现 MEDIA_ROOT（默认 /media）下的一级目录作为片库：
 * 把 /vol1/1000/影视 挂到 /media/影视 即可，库名直接取目录名，
 * 后续加盘只要在 compose 里再加一行 volumes，无需改其它配置。
 */
function autoRoots() {
  const mediaRoot = process.env.MEDIA_ROOT || '/media';
  try {
    const entries = fs.readdirSync(mediaRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'lost+found')
      .map((e) => ({ label: e.name, path: path.join(mediaRoot, e.name) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  } catch {
    return [];
  }
}

const AUTO_ROOTS = ENV_ROOTS.length ? [] : autoRoots();
const DEFAULT_ROOTS = ENV_ROOTS.length ? ENV_ROOTS : AUTO_ROOTS;

function defaults() {
  const dirs = DEFAULT_ROOTS.length ? DEFAULT_ROOTS : [{ label: '下载目录', path: DOWNLOAD_ROOT }];
  return {
    engine: 'aria2',
    dirs,
    defaultDir: dirs[0].path,
    aria2: {
      rpc: process.env.ARIA2_RPC || 'http://127.0.0.1:6800/jsonrpc',
      secret: process.env.ARIA2_SECRET || '',
    },
    qbit: {
      url: process.env.QBIT_URL || 'http://127.0.0.1:8080',
      username: process.env.QBIT_USER || 'admin',
      password: process.env.QBIT_PASS || '',
    },
    /** 资源库 A 的登录态（令牌与账号） */
    a: {
      username: '',
      token: '',
      tokenAt: 0,
      user: null,
    },
    /** 资源库 B 的本地片库状态 */
    b: {
      enabled: true,
      pagesPerCategory: 40,
      lastSync: 0,
      count: 0,
    },
    /** 网盘分享解析：只存浏览器 Cookie，不下发到界面、不进仓库 */
    pan: {
      cookie: '',
    },
  };
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === 'object') {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

let cache = null;

/** 统一规范化：目录必须存在且为绝对路径，保证白名单比较不因写法不同而误判 */
function normalize(s) {
  // 从旧版本升级：历史配置里的目录在容器内全都不存在（换了挂载点），
  // 且环境里能识别出新的库时，直接用新的这份，避免界面上看不到刚挂载的库
  if (DEFAULT_ROOTS.length && Array.isArray(s.dirs) && s.dirs.length > 0) {
    const alive = s.dirs.some((d) => d && d.path && fs.existsSync(path.resolve(String(d.path))));
    if (!alive) s.dirs = DEFAULT_ROOTS;
  }
  if (!Array.isArray(s.dirs) || s.dirs.length === 0) {
    s.dirs = DEFAULT_ROOTS.length ? DEFAULT_ROOTS : [{ label: '下载目录', path: DOWNLOAD_ROOT }];
  }
  s.dirs = s.dirs
    .filter((d) => d && d.path)
    .map((d) => ({ label: d.label || path.basename(String(d.path)) || String(d.path), path: path.resolve(String(d.path)) }));
  s.defaultDir = path.resolve(String(s.defaultDir || s.dirs[0].path));
  if (!s.dirs.some((d) => d.path === s.defaultDir)) s.defaultDir = s.dirs[0].path;
  return s;
}

export function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadSettings() {
  if (cache) return cache;
  ensureConfigDir();
  let raw = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
      raw = {};
    }
  }
  cache = normalize(deepMerge(defaults(), raw));
  return cache;
}

export function saveSettings(patch) {
  const current = loadSettings();
  cache = normalize(deepMerge(current, patch || {}));
  ensureConfigDir();
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  return cache;
}

/** 允许写入的根目录白名单（统一规范化，避免同一路径两种写法） */
export function allowedRoots() {
  const s = loadSettings();
  const roots = new Set();
  for (const d of s.dirs) if (d && d.path) roots.add(path.resolve(d.path));
  // 目录列表为空这种异常情况才回落到默认目录，避免白名单多出不存在路径
  if (roots.size === 0) roots.add(path.resolve(DOWNLOAD_ROOT));
  return [...roots];
}

/** 所有挂载的电影库根目录（用于启动日志与状态展示） */
export function mediaRoots() {
  return loadSettings().dirs.map((d) => ({ label: d.label, path: d.path }));
}

export function publicSettings() {
  const s = loadSettings();
  const sites = siteStatus();
  return {
    engine: s.engine,
    dirs: s.dirs,
    defaultDir: s.defaultDir,
    downloadRoot: DOWNLOAD_ROOT,
    a: {
      username: s.a.username,
      loggedIn: Boolean(s.a.token),
      user: s.a.user,
      configured: sites.a.configured,
    },
    b: {
      enabled: s.b.enabled,
      pagesPerCategory: s.b.pagesPerCategory,
      lastSync: s.b.lastSync,
      count: s.b.count,
      configured: sites.b.configured,
    },
    qbit: {
      url: s.qbit.url,
      username: s.qbit.username,
      configured: Boolean(s.qbit.username && s.qbit.password),
    },
    aria2: { rpc: s.aria2.rpc, secretSet: Boolean(s.aria2.secret) },
    pan: { configured: Boolean(s.pan?.cookie) },
    accessPasswordSet: Boolean(process.env.ACCESS_PASSWORD),
  };
}

export { CONFIG_DIR, DOWNLOAD_ROOT, SETTINGS_FILE };
