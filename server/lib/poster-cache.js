/**
 * 搜索结果海报缓存（纯内存，进程重启即清空）。
 *
 * 为什么需要：源 A 的搜索接口直接给海报，源 B 与磁力卡以前没有；用户切成
 * 「源 B」「磁力搜索」单独搜时，那一次请求里没有 A 的结果，就算聚合层有
 * 「同名合并借图」也借不到。这里按归一化片名把见过的海报记下来，让后续
 * 任意来源、任意来源筛选都能复用，不发任何额外请求。
 *
 * 串图防护：同一片名按年份分组；请求方带年份时优先同年，不带年份（磁力卡
 * 就是这种）取最近一次见到的。不同片名绝不互相借。
 */
import { normTitle } from './aggregate.js';

const MAX_TITLES = 300;
const MAX_PER_TITLE = 3;
const cache = new Map();

function validImage(image) {
  const s = String(image || '').trim();
  return /^https?:\/\//i.test(s) && !/[\s"'<>]/.test(s) ? s : '';
}

/** 记一张海报：title 必填，year 可空；同一片名只留最近 3 个年份/来源 */
export function rememberPoster(title, image, year = '') {
  const key = normTitle(title);
  const url = validImage(image);
  if (!key || !url) return false;
  const y = String(year || '').trim();
  const list = cache.get(key) || [];
  const hit = list.find((x) => x.year === y && x.image === url);
  if (hit) {
    hit.at = Date.now();
    cache.delete(key);
    cache.set(key, list);
    return true;
  }
  list.unshift({ image: url, year: y, at: Date.now() });
  if (list.length > MAX_PER_TITLE) list.length = MAX_PER_TITLE;
  cache.delete(key);
  cache.set(key, list);
  while (cache.size > MAX_TITLES) cache.delete(cache.keys().next().value);
  return true;
}

/** 取一张海报：带年份先精确匹配；不带年份（磁力卡）取最近见过的 */
export function lookupPoster(title, year = '') {
  const key = normTitle(title);
  if (!key) return '';
  const list = cache.get(key);
  if (!list?.length) return '';
  const y = String(year || '').trim();
  if (y) {
    const exact = list.find((x) => x.year === y);
    if (exact) return exact.image;
  }
  return list[0].image;
}

/** 一次搜索里先记住所有有图的，再给没图的回填（含磁力卡） */
export function backfillPosters(items) {
  for (const it of items) if (it?.image) rememberPoster(it.title, it.image, it.year);
  let filled = 0;
  for (const it of items) {
    if (!it || it.image) continue;
    const url = lookupPoster(it.title, it.year);
    if (url) {
      it.image = url;
      filled += 1;
    }
  }
  return filled;
}

/** 仅供测试：清空缓存 */
export function _resetPosters() {
  cache.clear();
}

export function posterCacheSize() {
  return cache.size;
}
