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
    return 'qBittorrent 返回 401：Host 头没通过校验。用裸 IP 访问、或反代域名没加进「服务器域名」白名单都会这样';
  }
  if (low.startsWith('fails')) {
    return 'qBittorrent 说账号或密码不对；也可能是失败次数过多被临时封禁，重启 qBittorrent 后再试';
  }
  if (/^\s*(<!doctype|<html)/i.test(text) || /<body|<form/i.test(text)) {
    return '这个地址返回的是网页，不是 qBittorrent 接口。检查 IP 和端口是不是 WebUI 端口，以及反代有没有多加一层登录页';
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

/** qBittorrent WebAPI v2 适配器 */
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
    if (!force && this.sid && Date.now() - this.loggedAt < 1000 * 60 * 30) return this.sid;
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
    if (!res.ok || !raw.trim().toLowerCase().startsWith('ok')) {
      throw new QbitError(diagnoseLogin(res.status, raw), detail);
    }
    const cookie = res.headers.getSetCookie?.() || [];
    const sid = cookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('SID='));
    if (!sid) {
      throw new QbitError('登录成功了，但没拿到会话 Cookie（SID）——多半是反代把 Set-Cookie 吞了', detail);
    }
    this.sid = sid;
    this.loggedAt = Date.now();
    return sid;
  }

  async api(pathname, { method = 'GET', body, retry = true } = {}) {
    const sid = await this.login();
    const url = `${this.base()}/api/v2${pathname}`;
    const headers = { Cookie: sid, ...this.browserHeaders() };
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
      if (t.state === 'pausedDL' || t.state === 'pausedUP' || t.state === 'stoppedDL') return 'paused';
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

  async pause(hash) {
    await this.api('/torrents/pause', { method: 'POST', body: encodeForm({ hashes: hash }) });
  }

  async resume(hash) {
    await this.api('/torrents/resume', { method: 'POST', body: encodeForm({ hashes: hash }) });
  }

  async remove(hash, deleteFiles = false) {
    await this.api('/torrents/delete', {
      method: 'POST',
      body: encodeForm({ hashes: hash, deleteFiles: deleteFiles ? 'true' : 'false' }),
    });
  }
}

export const qbitEngine = new QbitEngine();
