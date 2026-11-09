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
 * 挑下载引擎：种子 / 磁力优先给 qBittorrent（DHT/PEX/uTP 找 peer 更强），
 * 没配 qB 时回落 aria2，不至于因为没装 qB 就下不了。
 * 项目只下种子与磁力，不再有 http 直链分流；kind 参数保留给调用方。
 */
export function routeFor(kind) {
  const mode = engineMode();
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
