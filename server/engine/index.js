import { loadSettings } from '../settings.js';
import { aria2Engine } from './aria2.js';
import { qbitEngine } from './qbit.js';

export function engineByName(name) {
  return name === 'qbit' ? qbitEngine : aria2Engine;
}

/** qB 只有填了账号密码才算真接上了，光有地址不算 */
export function qbitReady() {
  const q = loadSettings().qbit || {};
  return Boolean(q.username && q.password);
}

/** 当前档位：auto（自动分流）/ aria2 / qbit，非法值一律当自动 */
export function engineMode() {
  const m = loadSettings().engine;
  return m === 'aria2' || m === 'qbit' ? m : 'auto';
}

/**
 * 按链接类型挑引擎——自动分流的唯一入口。
 *
 * 种子·磁力：qBittorrent 基于 libtorrent，有 DHT/PEX/uTP，找 peer 和连内网穿透都强于 aria2，
 *            配好了就交给它；没配就回落 aria2，不至于因为没装 qB 就不能下。
 * http 直链 ：qB 的 /torrents/add 只吃磁力和 .torrent 地址，喂普通直链必失败，
 *            所以无论档位怎么设都固定走 aria2（多连接分段下载也正是它的强项）。
 */
export function routeFor(kind) {
  const mode = engineMode();
  if (kind === 'direct') {
    return {
      engine: aria2Engine,
      mode,
      note: mode === 'qbit' ? '直链改由 aria2 处理（qB 不支持 http 直链）' : mode === 'auto' ? '直链走 aria2' : '',
    };
  }
  if (mode === 'aria2') return { engine: aria2Engine, mode, note: '' };
  if (mode === 'qbit') return { engine: qbitEngine, mode, note: '' };
  if (qbitReady()) return { engine: qbitEngine, mode, note: '种子走 qB' };
  return { engine: aria2Engine, mode, note: '未配置 qB，种子暂由 aria2 下载' };
}

/** 设置页的默认引擎（auto 时用 aria2 兜底，它一定在） */
export function currentEngine() {
  return engineMode() === 'qbit' ? qbitEngine : aria2Engine;
}

export { aria2Engine, qbitEngine };
