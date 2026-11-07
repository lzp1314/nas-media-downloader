import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../settings.js';
import { extractHash, sleep } from '../lib/util.js';
import { decodeTorrent } from '../lib/bencode.js';
import { aria2Engine } from '../engine/aria2.js';

/**
 * 磁力「先看目录再下」：
 * aria2 用 bt-metadata-only 只拿种子元数据并落盘 .torrent，
 * 解析出文件列表后缓存；用户勾好集数再用 addTorrent + select-file 下载。
 * 坑：元数据靠 DHT/peer 交换，没人做种时会超时；此时保留整包下载兜底。
 */
const TORRENT_DIR = path.join(CONFIG_DIR, 'torrents');
const META_TIMEOUT = Math.max(15000, Number(process.env.TORRENT_META_TIMEOUT || 70000));
const CACHE_TTL = 30 * 60 * 1000;
const cache = new Map();
const inflight = new Map();

const torrentPath = (hash) => path.join(TORRENT_DIR, `${hash}.torrent`);

export async function readCachedTorrent(hash) {
  if (!/^[0-9a-f]{32,40}$/i.test(String(hash || ''))) return null;
  try {
    return await fsp.readFile(torrentPath(String(hash).toLowerCase()));
  } catch {
    return null;
  }
}

function fromDisk(hash) {
  return readCachedTorrent(hash).then((buf) => {
    if (!buf) return null;
    const info = decodeTorrent(buf);
    if (!info.files.length) return null;
    const rec = { ...info, at: Date.now() };
    cache.set(hash, rec);
    return { kind: 'magnet', hash, ...info, cached: true };
  }).catch(() => null);
}

export async function listTorrentFiles(magnet) {
  const hash = extractHash(magnet);
  if (!hash) throw new Error('这条磁力里没识别到 infohash');

  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return { kind: 'magnet', hash, name: hit.name, files: hit.files, total: hit.total, cached: true };
  }
  const disk = await fromDisk(hash);
  if (disk) return disk;

  if (inflight.has(hash)) return inflight.get(hash);
  const task = fetchMetadata(magnet, hash).finally(() => inflight.delete(hash));
  inflight.set(hash, task);
  return task;
}

async function fetchMetadata(magnet, hash) {
  await fsp.mkdir(TORRENT_DIR, { recursive: true });
  const gid = await aria2Engine.rpc('aria2.addUri', [
    [magnet],
    {
      dir: TORRENT_DIR,
      'bt-metadata-only': 'true',
      'bt-save-metadata': 'true',
      'follow-torrent': 'false',
      'bt-remove-unselected-file': 'true',
    },
  ]);

  let infoHash = hash;
  let last = {};
  const deadline = Date.now() + META_TIMEOUT;
  try {
    while (Date.now() < deadline) {
      await sleep(1200);
      let st;
      try {
        st = await aria2Engine.rpc('aria2.tellStatus', [gid, ['status', 'infoHash', 'errorMessage', 'followedBy', 'files']]);
      } catch {
        break; // 引擎抖动时按下面「找文件」再判断一次
      }
      last = st || {};
      if (last.infoHash) infoHash = String(last.infoHash).toLowerCase();
      if (last.status === 'error') {
        throw new Error(`取种子目录失败：${String(last.errorMessage || '没有可用做种者').slice(0, 80)}`);
      }
      if (last.status === 'complete' || last.status === 'removed' || (last.followedBy || []).length) break;
    }
  } finally {
    for (const g of [gid, ...(last.followedBy || [])]) {
      await aria2Engine.rpc('aria2.forceRemove', [g]).catch(() => null);
      await aria2Engine.rpc('aria2.removeDownloadResult', [g]).catch(() => null);
    }
    aria2Engine.persist();
  }

  // aria2 保存的名字是 infohash.torrent；不同版本哈希写法可能不同，兜底扫目录里最新的文件
  const candidates = [torrentPath(infoHash), torrentPath(hash)];
  try {
    const entries = await fsp.readdir(TORRENT_DIR, { withFileTypes: true });
    const torrents = await Promise.all(
      entries
        .filter((e) => e.isFile() && /\.torrent$/i.test(e.name))
        .map(async (e) => {
          const p = path.join(TORRENT_DIR, e.name);
          const st = await fsp.stat(p).catch(() => null);
          return st ? { p, mtime: st.mtimeMs } : null;
        }),
    );
    torrents.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 3).forEach((x) => candidates.push(x.p));
  } catch { /* 目录不可读时只用哈希命名 */ }

  for (const p of [...new Set(candidates)]) {
    try {
      const buf = await fsp.readFile(p);
      const info = decodeTorrent(buf);
      if (!info.files.length) continue;
      const keep = torrentPath(hash);
      if (p !== keep) await fsp.copyFile(p, keep).catch(() => null);
      cache.set(hash, { ...info, at: Date.now() });
      return { kind: 'magnet', hash, name: info.name, files: info.files, total: info.total, cached: false };
    } catch { /* 尝试下一个候选 */ }
  }
  throw new Error('暂时没拿到种子里的文件列表（需要有人做种提供元数据），稍后点「重试」，或直接用「下载」整包下');
}
