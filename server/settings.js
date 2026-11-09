import fs from 'node:fs';
import path from 'node:path';
import { siteStatus } from './sources/config.js';

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const DOWNLOAD_ROOT = process.env.DOWNLOADS_DIR || '/downloads';
const MEDIA_ROOT = process.env.MEDIA_ROOT || '/media';

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
 * 读容器内的挂载表（/proc/mounts，第二列是挂载点）。
 *
 * v1.2.25：基础镜像 node:22-alpine 自带 /media/cdrom、/media/floppy、/media/usb
 * 等空目录，Dockerfile 又声明了 VOLUME ["/media", "/config"] —— 若 /media 本身
 * 没被显式挂载，Docker 会建匿名卷并把镜像里这些目录复制进去。旧 autoRoots()
 * 无差别扫一级目录，就把它们全当成片库列到了设置页。
 *
 * 读不到挂载表（Windows/macOS 本地开发、运行时不暴露 /proc）时返回 null，
 * autoRoots 会沿用原来的扫描行为。
 * MEDIA_MOUNTS_FILE 只用于离线测试注入一份假挂载表，生产环境不设置。
 */
function readMountPoints() {
  const files = [process.env.MEDIA_MOUNTS_FILE, '/proc/mounts'].filter(Boolean);
  let text = null;
  for (const f of files) {
    try { text = fs.readFileSync(f, 'utf8'); break; } catch { /* 试下一个 */ }
  }
  if (text == null) return null;
  const out = new Set();
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    // /proc/mounts 把路径里的空格 / tab / 换行 / 反斜杠转义成 \040 \011 \012 \134
    const p = cols[1]
      .replace(/\\040/g, ' ').replace(/\\011/g, '\t')
      .replace(/\\012/g, '\n').replace(/\\134/g, '\\');
    if (!path.isAbsolute(p)) continue;
    out.add(path.resolve(p));
  }
  return out;
}

/**
 * 启动时扫描 MEDIA_ROOT（默认 /media）下的一级目录，作为「自动发现的片库」。
 * 把 /vol1/1000/影视 挂到 /media/影视 即可，库名直接取目录名。
 * 这份结果只在进程启动时算一次；加盘后重建容器即可被 mergeDirs 补进配置。
 *
 * v1.2.25：挂载表里存在 MEDIA_ROOT 下（含自身）的挂载点时，只把「真正挂进来的」
 * 一级目录当片库，镜像自带的空目录一律忽略。挂载表跟 MEDIA_ROOT 完全无关
 * （本地开发、离线测试）时沿用旧扫描行为，不影响已有用法。
 *
 * 边界：若把「整个盘」直接挂到 /media，一级目录本身不是挂载点，自动发现会返回
 * 空列表 —— 这种情况请用 DOWNLOADS_DIRS 显式列出片库。
 */
function autoRoots() {
  let entries;
  try {
    entries = fs.readdirSync(MEDIA_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'lost+found')
      .map((e) => ({ label: e.name, path: path.join(MEDIA_ROOT, e.name) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  } catch {
    return [];
  }
  const mounts = readMountPoints();
  if (!mounts) return entries;
  const root = path.resolve(MEDIA_ROOT);
  const related = [...mounts].some((p) => p === root || path.dirname(p) === root);
  if (!related) return entries;
  return entries.filter((e) => mounts.has(path.resolve(e.path)));
}

const AUTO_ROOTS = ENV_ROOTS.length ? [] : autoRoots();
const DEFAULT_ROOTS = ENV_ROOTS.length ? ENV_ROOTS : AUTO_ROOTS;

function defaults() {
  const dirs = DEFAULT_ROOTS.length ? DEFAULT_ROOTS : [{ label: '下载目录', path: DOWNLOAD_ROOT }];
  return {
    engine: 'auto',
    dirs,
    /** 用户在界面主动「移除」过的目录：重启时不再被自动发现加回来 */
    removedRoots: [],
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
    /** 豆瓣：只做元数据（总集数/别名），Cookie 与用户 id 都留空则完全不用 */
    douban: {
      cookie: '',
      uid: '',
    },
    /**
     * TMDB：比豆瓣更全的剧集元数据，能给出「下一集哪天播」。
     * token/v4 与 apiKey/v3 填一个即可，两个都填则以 token 为准。
     * base 留空表示自动在两个官方域名间切换（国内 api.themoviedb.org 会被 DNS 污染）。
     */
    tmdb: {
      token: '',
      apiKey: '',
      base: '',
    },
    /** 剧集订阅 */
    subscribe: {
      enabled: true,
      intervalMinutes: 60,
      // 周更剧：更新日（和次日，对付延迟上传）密查，其余时间低频
      updateIntervalMinutes: 30,
      offIntervalMinutes: 360,
      maxPerRun: 3,
      // 每天最多检查多少次（所有订阅合计）。密查窗口内每 30 分钟一次，
      // 单订阅「更新日 + 次日」两段窗口就能到 26 次，12 会在窗口后半段把调度掐死。
      dailyLimit: 36,
    },
  };
}

/**
 * 深合并：只覆盖 patch 里明确出现的字段，未出现的保持原值。
 *
 * 注意 base 可能是 null —— 默认配置里 user: null 这类占位就是 null，
 * 再往里写对象时（如登录后写入 user: {…}）若直接 `k in base` 会抛
 * “Cannot use 'in' operator to search for 'x' in null”，把整条调用链打断。
 * 所以这里统一把非对象的 base 视为空对象。
 */
function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === 'object') {
    const obj = base && typeof base === 'object' ? base : {};
    const out = { ...obj };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = Object.prototype.hasOwnProperty.call(obj, k) ? deepMerge(obj[k], v) : v;
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

/**
 * 把「自动发现的一级目录」增量合并进用户配置，而不是只在配置全失效时整份覆盖。
 *
 * 规则（按优先级）：
 *  1. compose 新挂的 /media/xxx 自动补进来 —— 加盘后重建容器就能在界面看到
 *  2. 用户手工加的自定义路径（不在自动发现空间里）始终保留
 *  3. 用户改过的显示名保留，不会被目录名覆盖
 *  4. 自动发现空间内已不存在的目录（盘拔了/挂载撤了）自动清掉，插回来会再次出现
 *  5. removedRoots 里记着用户主动点过「移除」的路径，不再自动加回
 *
 * DEFAULT_ROOTS 为空（例如没挂 /media）时返回原列表，完全沿用旧行为。
 */
function mergeDirs(s) {
  const old = Array.isArray(s.dirs) ? s.dirs : [];
  if (!DEFAULT_ROOTS.length) return old.length ? old : [{ label: '下载目录', path: path.resolve(DOWNLOAD_ROOT) }];

  const resolve = (p) => path.resolve(String(p || ''));
  const removed = new Set((Array.isArray(s.removedRoots) ? s.removedRoots : []).filter(Boolean).map(resolve));
  // 自动发现目录所在的父目录（一般是 /media）：只有这一层里消失的路径才算「盘被拔了」
  const autoParents = new Set(DEFAULT_ROOTS.map((d) => path.dirname(resolve(d.path))));
  const isAutoSpace = (p) => autoParents.has(path.dirname(p));
  const customNames = new Map();
  for (const d of old) if (d && d.path && d.label) customNames.set(resolve(d.path), String(d.label));

  const out = [];
  const seen = new Set();
  for (const d of DEFAULT_ROOTS) {
    const p = resolve(d.path);
    if (removed.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push({ label: customNames.get(p) || d.label || path.basename(p), path: p });
  }
  for (const d of old) {
    if (!d || !d.path) continue;
    const p = resolve(d.path);
    if (seen.has(p) || removed.has(p)) continue;
    if (isAutoSpace(p) && !fs.existsSync(p)) continue;
    seen.add(p);
    out.push({ label: customNames.get(p) || path.basename(p) || p, path: p });
  }
  return out.length ? out : [{ label: '下载目录', path: path.resolve(DOWNLOAD_ROOT) }];
}

let cache = null;

/** 统一规范化：目录必须存在且为绝对路径，保证白名单比较不因写法不同而误判 */
function normalize(s) {
  // 网盘功能已整体下线：历史配置里存过的网盘 Cookie 读进来就丢掉
  delete s.pan;
  // 「界面上主动移除过」的目录名单，防止下次启动又被自动发现加回来
  s.removedRoots = (Array.isArray(s.removedRoots) ? s.removedRoots : [])
    .filter((p) => p && String(p).trim())
    .map((p) => path.resolve(String(p)))
    .slice(-50);
  // 加盘后重建容器即自动补进列表；用户自定义路径、自定义显示名都保留
  s.dirs = mergeDirs(s);
  s.dirs = s.dirs
    .filter((d) => d && d.path)
    .map((d) => ({ label: d.label || path.basename(String(d.path)) || String(d.path), path: path.resolve(String(d.path)) }));
  s.defaultDir = path.resolve(String(s.defaultDir || s.dirs[0].path));
  if (!s.dirs.some((d) => d.path === s.defaultDir)) s.defaultDir = s.dirs[0].path;
  if (!['auto', 'aria2', 'qbit'].includes(s.engine)) s.engine = 'auto';
  // 订阅参数收敛到安全区间：间隔太短会打爆资源站，条数太多一次补太多集
  const sub = s.subscribe || {};
  s.subscribe = {
    enabled: sub.enabled !== false,
    intervalMinutes: Math.min(720, Math.max(15, Number(sub.intervalMinutes) || 60)),
    updateIntervalMinutes: Math.min(120, Math.max(10, Number(sub.updateIntervalMinutes) || 30)),
    offIntervalMinutes: Math.min(1440, Math.max(30, Number(sub.offIntervalMinutes) || 360)),
    maxPerRun: Math.min(10, Math.max(1, Number(sub.maxPerRun) || 3)),
    dailyLimit: Math.min(48, Math.max(1, Number(sub.dailyLimit) || 36)),
  };
  s.douban = { cookie: String(s.douban?.cookie || ''), uid: String(s.douban?.uid || '').replace(/\D/g, '') };
  // 密钥两端可能有换行/空格（从网页上复制很容易带上），不剪掉的话请求头会直接非法
  s.tmdb = {
    token: String(s.tmdb?.token || '').trim(),
    apiKey: String(s.tmdb?.apiKey || '').trim(),
    // 域名只留 scheme://host/路径，去掉结尾斜杠，允许用户填镜像
    base: String(s.tmdb?.base || '').trim().replace(/\/+$/, ''),
  };
  return s;
}

export function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

/**
 * v1 的 engine 只有 aria2 / qbit 二选一，没有「自动分流」这个概念，默认值是 'aria2'。
 * v2 起默认 auto：种子交 qB、http 直链交 aria2。老配置里那两个值要么是旧默认，
 * 要么是当时只能二选一时的将就，不代表用户不想要分流，所以统一迁到 auto——
 * 迁完写回文件打上 v，之后用户手动选单引擎就不会再被改回来。
 */
function migrate(raw) {
  let changed = false;
  // 注意写 !(x >= n) 而不是 x < n：老配置没有 v 字段，NaN < 2 是 false，
  // 会把「无版本号」的配置当成已迁过而跳过。
  if (!(Number(raw.v) >= 2)) {
    raw.engine = 'auto';
    raw.v = 2;
    changed = true;
  }
  // v3：订阅每天检查上限 12 → 36。
  // v2 时前端没有这个参数的入口，存下来的 12 一定是旧默认值，直接升不会覆盖用户选择。
  // 不升的话：更新日密查 6 小时就是 12 次，窗口后半段会被自己的上限拦住。
  if (!(Number(raw.v) >= 3)) {
    if (raw.subscribe && typeof raw.subscribe === 'object') raw.subscribe.dailyLimit = 36;
    raw.v = 3;
    changed = true;
  }
  // v4：网盘解析整块下线，历史配置里存过的网盘 Cookie 一并删除并写回文件，
  // 既不再被读取，也不该继续躺在 NAS 的配置目录里。
  if (!(Number(raw.v) >= 4)) {
    if ('pan' in raw) delete raw.pan;
    raw.v = 4;
    changed = true;
  }
  return changed;
}

function writeSettings(obj) {
  ensureConfigDir();
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
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
  const migrated = migrate(raw);
  cache = normalize(deepMerge(defaults(), raw));
  if (migrated) {
    try {
      writeSettings(cache);
    } catch (err) {
      console.warn('[settings] 分流迁移写回失败：', err.message);
    }
  }
  return cache;
}

export function saveSettings(patch) {
  const current = loadSettings();
  const input = patch && typeof patch === 'object' ? { ...patch } : {};
  // addDir / removeDir 是界面增删目录时传的控制量，只用来维护「主动移除」名单，不落盘
  const addDir = input.addDir ? path.resolve(String(input.addDir)) : '';
  const removeDir = input.removeDir ? path.resolve(String(input.removeDir)) : '';
  delete input.addDir;
  delete input.removeDir;
  const removed = new Set(Array.isArray(current.removedRoots) ? current.removedRoots : []);
  if (removeDir) removed.add(removeDir);
  if (addDir) removed.delete(addDir);
  // 显式出现在 dirs 里的路径，一律视为「用户要它」，解除此前的移除标记
  if (Array.isArray(input.dirs)) {
    for (const d of input.dirs) if (d && d.path) removed.delete(path.resolve(String(d.path)));
  }
  // 名单必须在 normalize 之前注入：mergeDirs 要靠它决定哪些盘不再自动加回
  const merged = deepMerge(current, input);
  merged.removedRoots = [...removed].slice(-50);
  cache = normalize(merged);
  writeSettings(cache);
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
  // 只下发末 4 位：让用户认出「存的是哪把钥匙」，又不至于把整串密钥摊在页面上
  const tail = (v) => {
    const x = String(v || '');
    return x.length >= 8 ? x.slice(-4) : '';
  };
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
    douban: {
      cookieSet: Boolean(s.douban?.cookie),
      uid: s.douban?.uid || '',
      ready: Boolean(s.douban?.cookie),
      cookieTail: tail(s.douban?.cookie),
    },
    // 密钥本身永远不下发：只告诉前端「填没填」「用的哪种鉴权」「末 4 位」「自定义了哪个域名」
    tmdb: {
      configured: Boolean(s.tmdb?.token || s.tmdb?.apiKey),
      auth: s.tmdb?.token ? 'token' : s.tmdb?.apiKey ? 'key' : '',
      base: s.tmdb?.base || '',
      tokenTail: tail(s.tmdb?.token),
      keyTail: tail(s.tmdb?.apiKey),
    },
    subscribe: s.subscribe,
    accessPasswordSet: Boolean(process.env.ACCESS_PASSWORD),
  };
}

export { CONFIG_DIR, DOWNLOAD_ROOT, SETTINGS_FILE };
