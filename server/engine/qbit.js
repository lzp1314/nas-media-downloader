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

/**
 * 普通接口失败的说法。绝不能复用 diagnoseLogin：
 * 下载任务出错时把 409 说成「登录失败」会把人带到错的方向（登录本来就是好的）。
 */
export function diagnoseApi(status, body) {
  const text = String(body || '');
  if (status === 409) return 'qBittorrent 拒绝这次操作（409）：种子可能已经在列表里，也可能它写不进指定的保存目录';
  if (status === 202) return 'qBittorrent 没能添加这个种子（202）：磁力 / 种子文件无效，或 tracker 全都连不上';
  if (status === 415) return '种子文件无效（415），换个资源试试';
  if (status === 401 || status === 403) return `会话失效（HTTP ${status}），已尝试重新登录`;
  if (status === 404) return '当前 qBittorrent 版本没有这个接口（404）';
  if (status >= 500) return `qBittorrent 内部出错（HTTP ${status}）${text ? `：${safeExcerpt(text, 60)}` : ''}`;
  return text ? safeExcerpt(text, 60) : `HTTP ${status}`;
}

/** 从磁力里取 infohash（只认 40 位 hex，base32 的交给 409 兜底逻辑处理） */
export function hashFromMagnet(magnet) {
  const m = String(magnet || '').match(/urn:btih:([0-9a-f]{40})(?:&|$)/i);
  return m ? m[1].toLowerCase() : '';
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

/**
 * qBittorrent 的 /torrents/info 单条记录 → 本项目的任务结构。
 * 抽成纯函数是为了能脱离网络单测（尤其是「连接数」这种容易取错字段的地方）。
 */
export function mapTorrent(t) {
  let status;
  if (t.state === 'error' || t.state === 'missingFiles') status = 'error';
  // 5.x 把 pausedXX 改名成 stoppedXX，两种都认
  else if (['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP'].includes(t.state)) status = 'paused';
  else if (t.state === 'queuedDL' || t.state === 'queuedUP') status = 'queued';
  else if (t.state === 'uploading' || t.state === 'stalledUP') status = 'done';
  else if (t.progress >= 1) status = 'done';
  else status = 'downloading';

  const leechers = t.num_leechs || 0;
  const seeds = t.num_seeds || 0;
  return {
    id: t.hash,
    engine: 'qbit',
    name: t.name,
    dir: t.save_path || '',
    size: t.size || 0,
    done: t.completed || 0,
    progress: (t.progress || 0) * 100,
    speed: t.dlspeed || 0,
    uploadSpeed: t.upspeed || 0,
    // num_leechs 只算「同样在下载的」，做种者不算在内。界面「连接」要的是总连接数，
    // 只取 num_leechs 会出现「连接 0 但还有下载速度」这种自相矛盾的显示。
    peers: leechers + seeds,
    leechers,
    seeders: seeds,
    status,
    error: t.state === 'error' ? '下载出错' : t.state === 'missingFiles' ? '文件缺失（可能被移动或删除）' : '',
    // 完成时间（毫秒）：已完成用完成时间，未完成用添加时间兜底，供前端「已完成」按时间倒序
    doneAt: (t.completion_on && t.completion_on > 0 ? t.completion_on : (t.added_on || 0)) * 1000,
  };
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

  async api(pathname, { method = 'GET', body, retry = true, accept = [] } = {}) {
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
    // accept 里的状态码交给调用方判断：5.2+ 的 /torrents/add 用 202（2xx）和 409 表达「加不上 / 已存在」
    if (accept.includes(res.status)) return { status: res.status, text };
    if (!res.ok) {
      throw new QbitError(`qBittorrent 接口 ${pathname} 返回 HTTP ${res.status}：${diagnoseApi(res.status, text)}`, {
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

  /** 这个 infohash 是否已经在 qBittorrent 里 */
  async has(hash) {
    if (!hash) return false;
    const list = await this.api(`/torrents/info?hashes=${encodeURIComponent(hash)}`);
    return Array.isArray(list) && list.length > 0;
  }

  async defaultSavePath() {
    const v = await this.api('/app/defaultSavePath');
    return typeof v === 'string' ? v : '';
  }

  addFailedMessage(status, dir, fallbackPath) {
    if (status === 409) {
      const parts = [
        `qBittorrent 拒绝了这次添加（HTTP 409）：这个种子可能已经在 qBittorrent 里，也可能它无法创建保存目录 ${dir}`,
      ];
      if (fallbackPath) {
        parts.push(
          `qBittorrent 的默认保存目录是 ${fallbackPath}；如果那边看不到 ${dir}，说明 qBittorrent 没挂载同一个媒体目录——要么换一个它看得见的目录，要么把挂载补上`,
        );
      }
      return parts.join('。');
    }
    return `qBittorrent 添加种子失败（HTTP ${status}）：${diagnoseApi(status, '')}`;
  }

  async add({ magnet, dir, urls, selectFile, hash }) {
    const list = Array.isArray(urls) && urls.length ? urls.map((u) => u.url || u) : [magnet];
    const target = hash || hashFromMagnet(magnet);
    const pick = () => {
      if (!selectFile || !target) return;
      this.applySelection(target, selectFile).catch((err) => console.warn('[qbit] 选集设置失败：', err.message));
    };
    // 5.2+ 对重复添加直接回 409。先问一次，能省掉一次必败的请求，也不会把「已存在」当错误弹给用户。
    if (target && (await this.has(target).catch(() => false))) {
      pick();
      return { id: target, count: list.length, already: true };
    }
    const r = await this.api('/torrents/add', {
      method: 'POST',
      body: encodeForm({ urls: list.join('\n'), savepath: dir, autoTMM: 'false' }),
      accept: [202, 409],
    });
    if (r && typeof r === 'object' && r.status) {
      // 409 也可能是「上一次其实加进去了」，再确认一次再决定报不报错
      if (r.status === 409 && target && (await this.has(target).catch(() => false))) {
        pick();
        return { id: target, count: list.length, already: true };
      }
      const fallback = await this.defaultSavePath().catch(() => '');
      throw new QbitError(this.addFailedMessage(r.status, dir, fallback), {
        url: `${this.base()}/api/v2/torrents/add`,
        http: r.status,
        body: safeExcerpt(r.text),
      });
    }
    pick();
    return { id: target || '', count: list.length };
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
    const tasks = (Array.isArray(torrents) ? torrents : []).map(mapTorrent);
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
