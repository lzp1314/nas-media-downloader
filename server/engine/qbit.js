import { loadSettings } from '../settings.js';
import { encodeForm } from '../lib/util.js';

/** 常规浏览器 UA：部分反代 / WAF 会拦截没有 UA 的请求 */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 带诊断详情的错误，/api/meta 会把 detail 下发给设置页 */
export class QbitError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'QbitError';
    this.detail = detail;
  }
}

/** 只留响应摘要：去 HTML 标签、压空白、遮蔽可能带凭据的字段 */
export function safeExcerpt(raw, max = 120) {
  return String(raw || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(password|passwd|pwd|token|sid|cookie|authorization)=[^&\s"']+/gi, '$1=***')
    .trim()
    .slice(0, max);
}

/**
 * 会话 Cookie 名字在不同版本都不一样：
 * 5.1- 是 SID（可自定义），5.2+ 是 QBT_SID_<qB 自身 WebUI 端口>（如 QBT_SID_8088）。
 * 端口映射 / 反代后从 URL 根本推不出来，所以只回显登录响应实际签发的那一个，不按名字匹配。
 */
export function sessionCookie(res) {
  const h = res.headers;
  let lines = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
  if (!lines.length) {
    const merged = h.get('set-cookie');
    lines = merged ? String(merged).split(/,(?=\s*[A-Za-z_][A-Za-z0-9_]*=)/) : [];
  }
  const pairs = lines
    .map((line) => String(line).split(';')[0].trim())
    .filter((pair) => /^[A-Za-z_][A-Za-z0-9_]*=[^;\s]+/.test(pair));
  // 反代可能自己也塞一个会话 Cookie，优先取 qB 的 SID，再退而求其次
  return pairs.find((p) => /^(QBT_SID|SID)(_\d+)?=/i.test(p)) || pairs[0] || '';
}

/** 把 qBittorrent / 反代的各种失败翻译成人话 */
export function diagnoseLogin(status, body) {
  const text = String(body || '');
  const low = text.trim().toLowerCase();
  if (status >= 300 && status < 400) {
    return '被反向代理重定向了（外面可能还有一层登录认证，或 HTTP / HTTPS 写反了）。检查地址协议，以及反代有没有额外密码';
  }
  if (status === 403 || /forbidden|banned/i.test(text)) {
    return 'qBittorrent 拒绝了这次登录（403）。常见原因：WebUI 的「Host 头验证 / CSRF 保护」拦了反代域名，或同一 IP 失败次数过多被临时封禁（重启 qBittorrent 可清）';
  }
  if (status === 401 || /unauthorized/i.test(text)) {
    return 'qBittorrent 返回 401：5.2+ 版本账号或密码不对就是这个响应；也可能是 Host 头没通过校验（裸 IP 访问、反代域名没加进「服务器域名」白名单）';
  }
  if (low.startsWith('fails')) {
    return 'qBittorrent 说账号或密码不对；也可能是失败次数过多被临时封禁，重启 qBittorrent 后再试';
  }
  if (/^\s*(<!doctype|<html)/i.test(text) || /<body|<form/i.test(text)) {
    return '这个地址返回的是网页，不是 qBittorrent 接口。检查 IP 和端口是不是 WebUI 端口，以及反代有没有多加一层登录页';
  }
  if (status === 204 && !text.trim()) {
    return '登录已通过（新版 204 空响应），但没拿到会话 Cookie：反代可能吞了 Set-Cookie，或 qBittorrent 开了免登录白名单';
  }
  if (!text.trim()) return `qBittorrent 返回了空响应（HTTP ${status}）`;
  return `qBittorrent 登录失败（HTTP ${status}）：${safeExcerpt(text, 60)}`;
}

function networkMessage(err) {
  const s = String(err?.message || err);
  if (/timeout|abort/i.test(String(err?.name || '')) || /timeout/i.test(s)) {
    return '连接超时：地址不通、端口不对，或防火墙 / 反代挡住了';
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(s)) {
    return '连不上这个地址：确认 qBittorrent 已启动、IP 与端口正确；容器是 host 网络，同机可用 127.0.0.1';
  }
  return `连接失败：${safeExcerpt(s, 80)}`;
}

/** qBittorrent WebAPI v2 适配器：同时兼容 5.1- 与 5.2+ 的登录契约 */
class QbitEngine {
  constructor() {
    this.sid = '';
    this.loggedAt = 0;
  }

  get name() {
    return 'qbit';
  }

  cfg() {
    return loadSettings().qbit;
  }

  base() {
    return this.cfg().url.replace(/\/+$/, '');
  }

  /** 改过地址 / 密码后清掉旧会话，避免「保存并测试」还在用上一份 SID */
  reset() {
    this.sid = '';
    this.loggedAt = 0;
  }

  /** 与浏览器保持一致：Origin 是纯 origin（无路径），Referer 带尾斜杠 */
  browserHeaders() {
    return {
      Referer: `${this.base()}/`,
      Origin: this.base(),
      'User-Agent': UA,
    };
  }

  async login(force = false) {
    const { username, password } = this.cfg();
    if (!username || !password) throw new QbitError('未配置 qBittorrent 账号密码');
    // 免登录白名单模式不签发 Cookie，用登录时间缓存而不是 sid 判断
    if (!force && this.loggedAt && Date.now() - this.loggedAt < 1000 * 60 * 30) return this.sid;
    const url = `${this.base()}/api/v2/auth/login`;
    const detail = { url, http: 0, body: '' };
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        // 反代常把未认证请求 302 到登录页；跟随之后 POST 变 GET，只会拿到一堆 HTML
        redirect: 'manual',
        headers: { ...this.browserHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeForm({ username, password }),
        signal: AbortSignal.timeout(12000),
      });
    } catch (err) {
      throw new QbitError(networkMessage(err), detail);
    }
    detail.http = res.status;
    const raw = await res.text().catch(() => '');
    detail.body = safeExcerpt(raw);
    const low = raw.trim().toLowerCase();
    const looksHtml = /^\s*(<!doctype|<html)/i.test(raw) || /<form/i.test(raw);
    const sid = sessionCookie(res);
    // 5.1-：200 + "Ok."；5.2+：204 + 空正文；个别版本 / 免登录模式只发 Cookie。
    // 跨版本唯一可靠判据是「服务端签发了会话」，而不是响应正文。
    const ok = res.ok && !looksHtml && (low.startsWith('ok') || res.status === 204 || Boolean(sid));
    if (!ok) throw new QbitError(diagnoseLogin(res.status, raw), detail);
    this.sid = sid; // 免登录白名单时为空，后续请求就不带 Cookie
    this.loggedAt = Date.now();
    return sid;
  }

  async api(pathname, { method = 'GET', body, retry = true } = {}) {
    const sid = await this.login();
    const url = `${this.base()}/api/v2${pathname}`;
    const headers = { ...this.browserHeaders() };
    if (sid) headers.Cookie = sid;
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new QbitError(networkMessage(err), { url, http: 0, body: '' });
    }
    if (res.status === 403 && retry) {
      this.reset();
      await this.login(true);
      return this.api(pathname, { method, body, retry: false });
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new QbitError(`qBittorrent 接口 ${pathname} 返回 HTTP ${res.status}：${diagnoseLogin(res.status, text)}`, {
        url,
        http: res.status,
        body: safeExcerpt(text),
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async ping() {
    try {
      const v = await this.api('/app/version');
      return { ok: true, version: String(v) };
    } catch (err) {
      return { ok: false, error: String(err.message || err), detail: err.detail || null };
    }
  }

  async add({ magnet, dir, urls, selectFile, hash }) {
    const list = Array.isArray(urls) && urls.length ? urls.map((u) => u.url || u) : [magnet];
    await this.api('/torrents/add', {
      method: 'POST',
      body: encodeForm({ urls: list.join('\n'), savepath: dir, autoTMM: 'false' }),
    });
    // 磁力选集：等 qBittorrent 拿到文件列表后把没勾的设为不下载
    if (selectFile && hash) {
      this.applySelection(hash, selectFile).catch((err) => console.warn('[qbit] 选集设置失败：', err.message));
    }
    return { id: hash || '', count: list.length };
  }

  async applySelection(hash, selectFile) {
    const picked = new Set(
      String(selectFile)
        .split(/[,\s]+/)
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0),
    );
    let files = [];
    for (let i = 0; i < 20; i += 1) {
      files = await this.api(`/torrents/files?hash=${encodeURIComponent(hash)}`).catch(() => []);
      if (Array.isArray(files) && files.length) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!files.length) throw new Error('尚未拿到种子文件列表');
    // qBittorrent 的文件 index 从 0 开始，aria2 从 1 开始
    const wanted = files.filter((f) => picked.has(Number(f.index) + 1)).map((f) => f.index);
    const unwanted = files.filter((f) => !picked.has(Number(f.index) + 1)).map((f) => f.index);
    if (unwanted.length) {
      await this.api('/torrents/filePrio', {
        method: 'POST',
        body: encodeForm({ hash, id: unwanted.join('|'), priority: 0 }),
      });
    }
    if (wanted.length) {
      await this.api('/torrents/filePrio', {
        method: 'POST',
        body: encodeForm({ hash, id: wanted.join('|'), priority: 1 }),
      });
    }
  }

  async list() {
    const [torrents, transfer] = await Promise.all([
      this.api('/torrents/info'),
      this.api('/transfer/info'),
    ]);
    const mapStatus = (t) => {
      if (t.state === 'error' || t.state === 'missingFiles') return 'error';
      // 5.x 把 pausedXX 改名成 stoppedXX，两种都认
      if (['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP'].includes(t.state)) return 'paused';
      if (t.state === 'queuedDL' || t.state === 'queuedUP') return 'queued';
      if (t.state === 'uploading' || t.state === 'stalledUP') return 'done';
      if (t.progress >= 1) return 'done';
      return 'downloading';
    };
    const tasks = (Array.isArray(torrents) ? torrents : []).map((t) => ({
      id: t.hash,
      engine: 'qbit',
      name: t.name,
      dir: t.save_path || '',
      size: t.size || 0,
      done: t.completed || 0,
      progress: (t.progress || 0) * 100,
      speed: t.dlspeed || 0,
      uploadSpeed: t.upspeed || 0,
      peers: t.num_leechs || 0,
      seeders: t.num_seeds || 0,
      status: mapStatus(t),
      error: t.state === 'error' ? '下载出错' : '',
    }));
    return {
      tasks,
      globalSpeed: transfer?.dl_info_speed || 0,
      globalUpload: transfer?.up_info_speed || 0,
      active: tasks.filter((t) => t.status === 'downloading').length,
      waiting: tasks.filter((t) => t.status === 'queued').length,
      stopped: tasks.filter((t) => t.status === 'done' || t.status === 'error').length,
    };
  }

  /** qBittorrent 5.x 把 pause/resume 改名成 stop/start；按 404 自动回退，无需探测版本 */
  async control(paths, hash) {
    let lastErr;
    for (const p of paths) {
      try {
        await this.api(p, { method: 'POST', body: encodeForm({ hashes: hash }) });
        return;
      } catch (err) {
        if (!/HTTP 404\b/.test(String(err.message))) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async pause(hash) {
    await this.control(['/torrents/stop', '/torrents/pause'], hash);
  }

  async resume(hash) {
    await this.control(['/torrents/start', '/torrents/resume'], hash);
  }

  async remove(hash, deleteFiles = false) {
    await this.api('/torrents/delete', {
      method: 'POST',
      body: encodeForm({ hashes: hash, deleteFiles: deleteFiles ? 'true' : 'false' }),
    });
  }
}

export const qbitEngine = new QbitEngine();
