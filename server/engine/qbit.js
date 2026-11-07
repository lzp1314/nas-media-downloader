import { loadSettings } from '../settings.js';
import { encodeForm } from '../lib/util.js';

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

  async login(force = false) {
    const { username, password } = this.cfg();
    if (!username || !password) throw new Error('未配置 qBittorrent 账号密码');
    if (!force && this.sid && Date.now() - this.loggedAt < 1000 * 60 * 30) return this.sid;
    const res = await fetch(`${this.base()}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: this.base() },
      body: encodeForm({ username, password }),
      signal: AbortSignal.timeout(12000),
    });
    const text = (await res.text()).trim();
    if (!text.toLowerCase().startsWith('ok')) throw new Error('qBittorrent 登录失败，请检查账号密码');
    const cookie = res.headers.getSetCookie?.() || [];
    const sid = cookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('SID='));
    if (!sid) throw new Error('qBittorrent 未返回会话');
    this.sid = sid;
    this.loggedAt = Date.now();
    return sid;
  }

  async api(pathname, { method = 'GET', body, retry = true } = {}) {
    const sid = await this.login();
    const headers = {
      Cookie: sid,
      Referer: this.base(),
      Origin: this.base(),
    };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(`${this.base()}/api/v2${pathname}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 403 && retry) {
      this.sid = '';
      await this.login(true);
      return this.api(pathname, { method, body, retry: false });
    }
    if (!res.ok) throw new Error(`qBittorrent 接口异常 ${res.status}`);
    const text = await res.text();
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
      return { ok: false, error: String(err.message || err) };
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
