import path from 'node:path';
import { loadSettings } from '../settings.js';

const KEYS = [
  'gid',
  'status',
  'totalLength',
  'completedLength',
  'downloadSpeed',
  'uploadSpeed',
  'connections',
  'numSeeders',
  'errorMessage',
  'files',
  'bittorrent',
  'followedBy',
  'dir',
];

function nameOf(st) {
  const bt = st.bittorrent?.info?.name;
  if (bt) return bt;
  const f = Array.isArray(st.files) ? st.files[0] : null;
  if (f?.path) return path.basename(f.path);
  return st.gid;
}

function mapStatus(st) {
  switch (st.status) {
    case 'active':
      return 'downloading';
    case 'waiting':
      return 'queued';
    case 'paused':
      return 'paused';
    case 'complete':
      return 'done';
    case 'error':
      return 'error';
    case 'removed':
      return 'removed';
    default:
      return st.status || 'unknown';
  }
}

/** 底层网络错误换成用户能看懂的提示，避免界面只显示 "fetch failed" */
function engineError(err) {
  const msg = String(err?.message || err);
  if (err?.name === 'AbortError') return new Error('下载引擎响应超时，请查看容器日志');
  const code = String(err?.cause?.code || '');
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|socket hang up|UND_ERR/i.test(`${msg} ${code}`)) {
    return new Error('下载引擎未启动（离线），请重启容器并查看 aria2 日志');
  }
  return err instanceof Error ? err : new Error(msg);
}

class Aria2Engine {
  get name() {
    return 'aria2';
  }

  cfg() {
    return loadSettings().aria2;
  }

  async rpc(method, params = []) {
    const { rpc, secret } = this.cfg();
    const body = {
      jsonrpc: '2.0',
      id: `nz-${Date.now()}`,
      method,
      params: secret ? [`token:${secret}`, ...params] : params,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => null);
      if (!json) throw new Error('aria2 返回异常');
      if (json.error) throw new Error(json.error.message || 'aria2 调用失败');
      return json.result;
    } catch (err) {
      throw engineError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 每次任务变更后立刻把会话写入 /config/aria2.session。
   * 容器被强制 kill 时来不及优雅退出，靠这个保证重启后任务列表不丢。
   */
  persist() {
    this.rpc('aria2.saveSession').catch(() => null);
  }

  async ping() {
    try {
      const v = await this.rpc('aria2.getVersion');
      return { ok: true, version: v.version };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  /**
   * 三种入口：
   *  - torrent(base64) + selectFile：只下种子里勾选的文件（剧集选集）
   *  - magnet：整包下载（旧行为）
   *  - urls：普通 http 下载（引擎保留的通用能力；本项目只下种子 / 磁力，不会走这里）
   */
  async add({ magnet, dir, selectFile, torrent, urls }) {
    const opts = { dir };
    if (selectFile) {
      opts['select-file'] = String(selectFile);
      opts['bt-remove-unselected-file'] = 'true';
    }
    if (torrent) {
      const gid = await this.rpc('aria2.addTorrent', [String(torrent), [], { ...opts, 'bt-save-metadata': 'true' }]);
      this.persist();
      return { id: gid, count: 1 };
    }
    if (Array.isArray(urls) && urls.length) {
      const ids = [];
      for (const u of urls) {
        const o = { ...opts };
        if (u.out) o.out = u.out;
        if (Array.isArray(u.headers) && u.headers.length) o.header = u.headers;
        const gid = await this.rpc('aria2.addUri', [[u.url], o]);
        ids.push(gid);
      }
      this.persist();
      return { id: ids[0] || '', ids, count: ids.length };
    }
    if (!magnet) throw new Error('缺少下载地址');
    const gid = await this.rpc('aria2.addUri', [[magnet], { ...opts, 'bt-save-metadata': 'true' }]);
    this.persist();
    return { id: gid, count: 1 };
  }

  async list() {
    const [active, waiting, stopped, stat] = await Promise.all([
      this.rpc('aria2.tellActive', [KEYS]),
      this.rpc('aria2.tellWaiting', [0, 200, KEYS]),
      this.rpc('aria2.tellStopped', [0, 200, KEYS]),
      this.rpc('aria2.getGlobalStat'),
    ]);
    const all = [...active, ...waiting, ...stopped];
    const tasks = all.map((st) => {
      const total = Number(st.totalLength) || 0;
      const done = Number(st.completedLength) || 0;
      return {
        id: st.gid,
        engine: 'aria2',
        name: nameOf(st),
        dir: st.dir || '',
        size: total,
        done,
        progress: total > 0 ? Math.min(100, (done / total) * 100) : 0,
        speed: Number(st.downloadSpeed) || 0,
        uploadSpeed: Number(st.uploadSpeed) || 0,
        peers: Number(st.connections) || 0,
        seeders: Number(st.numSeeders) || 0,
        status: mapStatus(st),
        error: st.errorMessage || '',
        // aria2 默认不返回完成时间戳，这里置 0 以保持其原生顺序（qB 任务按完成时间排在其前）
        doneAt: 0,
      };
    });
    return {
      tasks,
      globalSpeed: Number(stat.downloadSpeed) || 0,
      globalUpload: Number(stat.uploadSpeed) || 0,
      active: Number(stat.numActive) || 0,
      waiting: Number(stat.numWaiting) || 0,
      stopped: Number(stat.numStopped) || 0,
    };
  }

  async pause(gid) {
    try {
      await this.rpc('aria2.pause', [gid]);
    } catch {
      await this.rpc('aria2.forcePause', [gid]);
    }
    this.persist();
  }

  async resume(gid) {
    await this.rpc('aria2.unpause', [gid]);
    this.persist();
  }

  async remove(gid) {
    try {
      await this.rpc('aria2.forceRemove', [gid]);
    } catch {
      /* 已停止的任务忽略 */
    }
    await this.rpc('aria2.removeDownloadResult', [gid]).catch(() => null);
    this.persist();
  }
}

export const aria2Engine = new Aria2Engine();
