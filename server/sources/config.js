import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

/**
 * 片源接入配置。
 *
 * 所有站点地址、接口参数都从这里读取，代码里不出现任何具体站点：
 *   1) 配置文件：$CONFIG_DIR/sites.json（默认 /config/sites.json，已被 .gitignore 排除）
 *   2) 环境变量：SITE_A_BASE / SITE_A_APP_ID / SITE_A_IDENTITY、SITE_B_SITE / SITE_B_API / SITE_B_SEARCH
 *
 * 两者都没配置时，对应片源自动置为「未接入」，搜索会跳过它而不是报错。
 *
 * 另有一个可选的 hostMap：把片源域名钉到指定 IP（只对本程序生效，相当于给片源单独配 hosts）。
 * 站点某个 IP 在本地线路不通、或 DNS 被污染时，换一个能连的 IP 就能恢复，不用改系统。
 */

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const FILE = process.env.SITES_FILE || path.join(CONFIG_DIR, 'sites.json');

const EMPTY = {
  sourceA: { baseUrl: '', mirrors: [], appId: '', identity: '' },
  sourceB: { siteUrl: '', apiUrl: '', searchUrl: '', proxy: '' },
  hostMap: {},
};

const trimUrl = (v) => String(v || '').trim().replace(/\/+$/, '');
const str = (v) => String(v || '').trim();

function envSites() {
  const e = process.env;
  const out = { sourceA: {}, sourceB: {} };
  if (e.SITE_A_BASE) out.sourceA.baseUrl = e.SITE_A_BASE;
  if (e.SITE_A_MIRRORS) out.sourceA.mirrors = e.SITE_A_MIRRORS.split(',').map((x) => x.trim()).filter(Boolean);
  if (e.SITE_A_APP_ID) out.sourceA.appId = e.SITE_A_APP_ID;
  if (e.SITE_A_IDENTITY) out.sourceA.identity = e.SITE_A_IDENTITY;
  if (e.SITE_B_SITE) out.sourceB.siteUrl = e.SITE_B_SITE;
  if (e.SITE_B_API) out.sourceB.apiUrl = e.SITE_B_API;
  if (e.SITE_B_SEARCH) out.sourceB.searchUrl = e.SITE_B_SEARCH;
  if (e.SITE_B_PROXY) out.sourceB.proxy = e.SITE_B_PROXY;
  return out;
}

/** hostMap：只接受「域名 → IP 字面量」，写错的条目直接丢掉，绝不把域名指向域名 */
function sanitizeHostMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const host = String(k || '').trim().toLowerCase().replace(/\.$/, '');
    const ip = String(v || '').trim();
    if (!host || !net.isIP(ip)) continue;
    out[host] = ip;
  }
  return out;
}

function normalize(raw = {}) {
  const a = { ...EMPTY.sourceA, ...(raw.sourceA || {}) };
  const b = { ...EMPTY.sourceB, ...(raw.sourceB || {}) };
  return {
    sourceA: {
      baseUrl: trimUrl(a.baseUrl),
      mirrors: (Array.isArray(a.mirrors) ? a.mirrors : []).map(trimUrl).filter(Boolean),
      appId: str(a.appId),
      identity: str(a.identity),
    },
    sourceB: {
      siteUrl: trimUrl(b.siteUrl),
      apiUrl: trimUrl(b.apiUrl),
      searchUrl: trimUrl(b.searchUrl),
      proxy: str(b.proxy),
    },
    hostMap: sanitizeHostMap(raw.hostMap),
  };
}

let cache = null;
let cacheStamp = -1;

/** 读取配置；文件被改动后自动重新加载，不必重启进程 */
export function loadSites() {
  let stamp = 0;
  try {
    stamp = fs.statSync(FILE).mtimeMs;
  } catch {
    stamp = 0;
  }
  if (cache && stamp === cacheStamp) return cache;

  let raw = {};
  if (stamp) {
    try {
      raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      raw = {};
    }
  }
  const env = envSites();
  cache = normalize({
    sourceA: { ...(raw.sourceA || {}), ...env.sourceA },
    sourceB: { ...(raw.sourceB || {}), ...env.sourceB },
    hostMap: raw.hostMap,
  });
  cacheStamp = stamp;
  return cache;
}

/** 只暴露「是否接入」，不把地址回传给前端 */
export function siteStatus() {
  const s = loadSites();
  return {
    a: { configured: Boolean(s.sourceA.baseUrl && s.sourceA.appId) },
    b: { configured: Boolean(s.sourceB.siteUrl && s.sourceB.apiUrl), proxy: Boolean(s.sourceB.proxy) },
  };
}

/** 片源域名 → 指定 IP（可为空对象） */
export function hostMap() {
  return loadSites().hostMap || {};
}

function unconfigured(label) {
  const err = new Error(`${label} 未接入，请先填写片源配置`);
  err.code = 'unconfigured';
  return err;
}

export function requireA() {
  const a = loadSites().sourceA;
  if (!a.baseUrl || !a.appId) throw unconfigured('资源库 A');
  return a;
}

export function requireB() {
  const b = loadSites().sourceB;
  if (!b.siteUrl || !b.apiUrl) throw unconfigured('资源库 B');
  return b;
}

export function sitesConfigured() {
  const s = siteStatus();
  return { a: s.a.configured, b: s.b.configured };
}

export { FILE as SITES_FILE_PATH };
