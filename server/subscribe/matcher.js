import { sourceA } from '../sources/a.js';
import { bSearch, bDetail } from '../sources/b.js';
import { searchMagnet } from '../sources/magnet.js';
import { parseEpisodes, qualityRank } from './episodes.js';
import { loadSettings } from '../settings.js';

/**
 * 把「订阅」变成「某一集具体该下哪个磁力」。
 *
 * 站点没有「剧集」这种结构化概念，一条资源就是一个影片/种子，集数只能从名字里读。
 * 所以流程是先把搜索结果按集号建索引，再对缺的那几集逐个反查详情拿磁力——
 * 只查缺的，不整站遍历，这是把请求量压下来的关键（源站有请求配额，也会限流）。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 标题归一：去掉标点空格，便于「剧名 A 版」和「剧名.A.版」互相匹配 */
export function normTitle(s) {
  return String(s || '')
    .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）/g, ' ')
    .replace(/[\s\-_·:：!！?？,，.。、\\/|"'“”‘’*]+/g, '')
    .toLowerCase();
}

function titleMatches(title, keywords) {
  const t = normTitle(title);
  if (!t) return false;
  return keywords.some((k) => {
    const n = normTitle(k);
    if (!n || n.length < 2) return false;
    return t.includes(n) || n.includes(t);
  });
}

function hashOf(magnet) {
  const m = String(magnet || '').match(/urn:btih:([0-9a-z]{32,40})/i);
  return m ? m[1].toLowerCase() : '';
}

/** 站点声明的总集数（源 A 的 episodes 字段是「40 集」这种字符串） */
function totalFromItem(item) {
  const m = String(item?.episodes || '').match(/(\d{2,4})/);
  return m ? Number(m[1]) : 0;
}

function makeCandidate({ source, id, title, magnet = '', url = '', total = 0 }) {
  const ep = parseEpisodes(title);
  return {
    key: `${source}:${id}`,
    source,
    id,
    title,
    magnet,
    url,
    quality: ep.quality || qualityRank(title),
    pack: ep.pack,
    upTo: ep.upTo,
    episodes: ep.episodes,
    total,
  };
}

/**
 * 搜一轮，按集号建索引。
 * @returns {{index:Map<number,object[]>, packs:object[], maxEp:number, siteTotal:number, notes:string[], scanned:number}}
 */
export async function buildEpisodeIndex(sub, { pages = 2 } = {}) {
  const keywords = [sub.keyword || sub.title, ...(sub.aliases || [])].filter(Boolean);
  const index = new Map();
  const packs = [];
  const notes = [];
  let maxEp = 0;
  let siteTotal = 0;
  let scanned = 0;

  const put = (cand) => {
    scanned += 1;
    if (cand.total > siteTotal) siteTotal = cand.total;
    if (cand.episodes.length) {
      for (const n of cand.episodes) {
        if (n > maxEp) maxEp = n;
        const arr = index.get(n) || [];
        arr.push(cand);
        index.set(n, arr);
      }
      return;
    }
    // 名字里读不出集号的一律归到「整包池」。第一版不下整包：
    // 一个包覆盖几十集，直接添加会重复下载已有集，等选集链路验证过再放开。
    packs.push(cand);
  };

  // 1) 资源库 A：连载剧通常「一集一个条目」（标题带 [第199集]），所以搜索层就能定集
  try {
    for (let p = 1; p <= pages; p += 1) {
      const r = await sourceA.search({ keyword: sub.keyword || sub.title, scope: 'all', page: p, limit: 24 });
      if (!r.items.length) break;
      for (const it of r.items) {
        if (!titleMatches(it.title, keywords)) continue;
        put(makeCandidate({ source: 'a', id: it.id, title: it.title, total: totalFromItem(it) }));
      }
      // 站点分页到底了就别再要第 3 页
      if (r.items.length < 24) break;
    }
  } catch (err) {
    notes.push(`资源库 A：${String(err.message || err).slice(0, 80)}`);
  }

  // 2) 磁力搜索源：成品磁力，不用再进详情，命中率最高
  try {
    const r = await searchMagnet(sub.keyword || sub.title);
    for (const it of r.items || []) {
      if (!titleMatches(it.title, keywords)) continue;
      const cand = makeCandidate({ source: 'm', id: it.hash, title: it.title, magnet: it.magnet });
      put(cand);
    }
    for (const n of r.notes || []) notes.push(`磁力源：${String(n).slice(0, 60)}`);
  } catch (err) {
    notes.push(`磁力源：${String(err.message || err).slice(0, 80)}`);
  }

  // 3) 资源库 B：站点抖动是常态，失败只记一句，不影响整体
  try {
    const r = await bSearch(sub.keyword || sub.title);
    for (const it of r.items || []) {
      if (!titleMatches(it.title, keywords)) continue;
      const cand = makeCandidate({ source: 'b', id: it.link, title: it.title, url: it.link });
      put(cand);
    }
  } catch (err) {
    notes.push(`资源库 B：${String(err.message || err).slice(0, 80)}`);
  }

  return { index, packs, maxEp, siteTotal, notes, scanned };
}

/** 按订阅的清晰度偏好排序：优先正好等于偏好，其次更高，最后更低 */
function byQuality(a, b, preferred) {
  const score = (q) => (q === preferred ? 0 : q > preferred ? 1 : 2);
  const d = score(a.quality) - score(b.quality);
  if (d !== 0) return d;
  return (b.quality || 0) - (a.quality || 0);
}

/**
 * 详情页缓存：同一个条目在一次补集里会被反复问到（38、39、40…），
 * 每次都重新请求详情既慢又容易触发站点限流，这里按条目 id 记一小段时间。
 */
const detailCache = new Map();
const DETAIL_TTL = 5 * 60 * 1000;

function cachedDetail(cand) {
  const key = `${cand.source}:${cand.id}`;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return Promise.resolve(hit.value);
  const p = (cand.source === 'b' ? bDetail(cand.url) : sourceA.detail(cand.id))
    .then((v) => {
      detailCache.set(key, { at: Date.now(), value: v });
      if (detailCache.size > 60) detailCache.delete(detailCache.keys().next().value);
      return v;
    })
    .catch((err) => {
      detailCache.delete(key);
      throw err;
    });
  return p;
}

/** 从源 A 的详情里挑出「明确包含这一集」的磁力/种子条目 */
async function magnetFromDetail(cand, episode, notes, preferred = 0) {
  const detail = await cachedDetail(cand);
  const groups = Array.isArray(detail?.groups) ? detail.groups : [];
  const hits = [];
  for (const g of groups) {
    for (const it of g.items || []) {
      if (it.kind !== 'magnet' && it.kind !== 'torrent' && it.kind !== 'seed') continue;
      const ep = parseEpisodes(it.name);
      // 必须有明确的集号，且包含要的这一集。读不出集号的一律不要——
      // 那多半是整季包，拿来单集用会把已有的集重复下一遍。
      if (!ep.episodes.includes(episode)) continue;
      hits.push({
        magnet: it.magnet || '',
        torrentUrl: it.torrentUrl || it.down || '',
        name: it.name || '',
        hash: it.hash || hashOf(it.magnet),
        quality: ep.quality || qualityRank(it.name),
        seedId: it.seedId || '',
        needVip: Boolean(it.needVip),
      });
    }
  }
  if (!hits.length) {
    if (detail?.needLogin) notes.push('详情里有种子但站点不给明细：需要登录资源库 A 账号');
    return null;
  }
  // 要 VIP 的排后面，但别直接丢——用户可能正好是会员
  hits.sort((a, b) => Number(a.needVip) - Number(b.needVip) || byQuality(a, b, preferred || 0));
  return hits[0];
}

/**
 * 把「搜索层读不出集号的整包条目」展开成逐集候选。
 *
 * 这是补 1080P 的关键：连载剧在站点上常常只有一条「剧名」条目，
 * 1080P 的种子全在它的详情页里；如果只信搜索层，这一档永远进不了候选，
 * 最后只能吃磁力源里那种 4K 打包。
 */
async function fromPacks(packs, episode, notes, preferred) {
  let best = null;
  for (const cand of packs) {
    if (!cand.id || !cand.source) continue;
    if (cand.source !== 'a' && cand.source !== 'b') continue;
    try {
      const hit = await magnetFromDetail(cand, episode, notes, preferred);
      if (!hit) continue;
      const better = !best
        || Number(hit.needVip) < Number(best.hit.needVip)
        || (Number(hit.needVip) === Number(best.hit.needVip) && byQuality(hit, best.hit, preferred) < 0);
      if (better) best = { hit, source: cand.source };
    } catch (err) {
      notes.push(`展开「${String(cand.title).slice(0, 20)}」的详情失败：${String(err.message || err).slice(0, 50)}`);
    }
  }
  return best;
}

/**
 * 为某一集找到可下载的磁力。
 *
 * 挑法（按顺序）：
 *   1. 索引里正好是偏好清晰度的候选（最快，不用再请求）
 *   2. 展开整包条目的详情页，从里面按集号 + 偏好挑（1080P 通常只在这里）
 *   3. 退而求其次：索引里按偏好排序后的其它候选（更高或更低清晰度）
 * @returns {{magnet?:string, torrentUrl?:string, name:string, hash:string, quality:number, source:string}|null}
 */
export async function findSourceForEpisode(sub, index, episode, { notes = [], packs = [] } = {}) {
  const preferred = Number(sub.quality) || 1080;
  // 严格模式：只接受「≥ 偏好清晰度」的资源；未达标一律不当候选（宁缺毋滥）
  const strict = Boolean(sub.strictQuality);
  const meets = (q) => !strict || (Number(q) || 0) >= preferred;

  const use = (hit, source) => (hit.magnet
    ? { magnet: hit.magnet, name: hit.name, hash: hit.hash || hashOf(hit.magnet), quality: hit.quality, source }
    : { torrentUrl: hit.torrentUrl, name: hit.name, quality: hit.quality, source });

  const cands = [...(index.get(episode) || [])].sort((a, b) => byQuality(a, b, preferred));

  // 1) 索引里正好符合偏好（严格模式下允许更高清晰度，但排除更低清晰度）
  for (const cand of cands) {
    if (!cand.magnet && (!cand.id || !cand.source)) continue;
    if (!meets(cand.quality)) continue;
    if (cand.magnet) {
      return { magnet: cand.magnet, name: cand.title, hash: hashOf(cand.magnet), quality: cand.quality, source: cand.source };
    }
    try {
      const hit = await magnetFromDetail(cand, episode, notes, preferred);
      await sleep(300 + Math.round(Math.random() * 500));
      if (hit && (hit.magnet || hit.torrentUrl)) return use(hit, cand.source);
    } catch (err) {
      notes.push(`取「${String(cand.title).slice(0, 24)}」的种子失败：${String(err.message || err).slice(0, 60)}`);
    }
  }

  // 2) 展开整包条目：偏好清晰度的单集/连播通常只在详情页里
  if (packs.length) {
    const found = await fromPacks(packs, episode, notes, preferred);
    await sleep(300 + Math.round(Math.random() * 500));
    if (found && (found.hit.magnet || found.hit.torrentUrl) && meets(found.hit.quality)) {
      return use(found.hit, found.source);
    }
  }

  // 3) 兜底：索引里其它清晰度的候选（严格模式下跳过——宁缺毋滥，等更高清晰度）
  if (!strict) {
    for (const cand of cands) {
      if (!cand.magnet && (!cand.id || !cand.source)) continue;
      if (cand.magnet) {
        return { magnet: cand.magnet, name: cand.title, hash: hashOf(cand.magnet), quality: cand.quality, source: cand.source };
      }
      try {
        const hit = await magnetFromDetail(cand, episode, notes, preferred);
        await sleep(300 + Math.round(Math.random() * 500));
        if (hit && (hit.magnet || hit.torrentUrl)) return use(hit, cand.source);
      } catch (err) {
        notes.push(`取「${String(cand.title).slice(0, 24)}」的种子失败：${String(err.message || err).slice(0, 60)}`);
      }
    }
  } else {
    notes.push(`第 ${episode} 集：未找到 ≥${preferred}p 的资源，已按「严格清晰度」设置跳过，等待更高清晰度`);
  }
  return null;
}

/**
 * 订阅生效的目标范围上界。
 *
 * 优先级：补集范围上限 > 用户手填的总集数 > TMDB 声明 > 站点声明 > 本地已见最大集。
 * 把「用户手填」放在 TMDB 和站点前面：它们偶尔会把特别篇、合集包、
 * 别的剧的「更新至 N 集」算进来，一旦比实际集数大，订阅就会一直追着不存在的集号跑。
 * TMDB 放在站点前面，是因为站点那条「40 集」经常是营销文案，TMDB 是逐集登记过的。
 */
export function targetUpperBound(sub, { tmdbTotal = 0, siteTotal = 0, maxEp = 0, have = [] } = {}) {
  if (sub.endEpisode > 0) return sub.endEpisode;
  if (sub.totalEpisodes > 0) return sub.totalEpisodes;
  if (tmdbTotal > 0) return tmdbTotal;
  const seenMax = Math.max(maxEp, ...(have.length ? have : [0]));
  return Math.max(siteTotal || 0, seenMax) || 0;
}

export function subscribeSettings() {
  return loadSettings().subscribe || {};
}

/**
 * 为「电影订阅」挑一个可下载资源。
 *
 * 电影没有集号，整部就是一个文件，所以和电视剧按集反查不同：
 * 直接把搜索池（索引里所有候选 + 整包条目）按清晰度偏好排序，挑最优的一个。
 * 优先用搜索层就带磁力的成品；没有就展开详情页拿磁力/种子（不按集过滤，整部即命中）。
 * @returns {{magnet?:string, torrentUrl?:string, name:string, hash:string, quality:number, source:string}|null}
 */
export async function findMovieSource(sub, built, { notes = [] } = {}) {
  const preferred = Number(sub.quality) || 1080;
  // 严格模式：只接受「≥ 偏好清晰度」的资源；未达标一律不下，等待更高清晰度
  const strict = Boolean(sub.strictQuality);
  const meets = (q) => !strict || (Number(q) || 0) >= preferred;
  const all = [];
  for (const arr of built.index.values()) all.push(...arr);
  all.push(...(built.packs || []));
  if (!all.length) return null;

  // 1) 搜索层直接带磁力的成品：最快，不用再请求详情
  const withMag = all.filter((c) => c.magnet).sort((a, b) => byQuality(a, b, preferred));
  if (withMag.length) {
    const c = withMag[0];
    // 严格模式下未达标别急着下，继续看详情页有没有更高清晰度；都不行再返回 null
    if (meets(c.quality)) {
      return { magnet: c.magnet, name: c.title, hash: hashOf(c.magnet), quality: c.quality, source: c.source };
    }
  }

  // 2) 展开带 id 的条目详情页，取第一个磁力/种子（电影整部即可，不按集过滤）
  for (const cand of all.slice().sort((a, b) => byQuality(a, b, preferred))) {
    if (!cand.id || !cand.source) continue;
    if (cand.source !== 'a' && cand.source !== 'b') continue;
    try {
      const detail = await cachedDetail(cand);
      const groups = Array.isArray(detail?.groups) ? detail.groups : [];
      const hits = [];
      for (const g of groups) {
        for (const it of g.items || []) {
          if (it.kind !== 'magnet' && it.kind !== 'torrent' && it.kind !== 'seed') continue;
          hits.push({
            magnet: it.magnet || '',
            torrentUrl: it.torrentUrl || it.down || '',
            name: it.name || '',
            hash: it.hash || hashOf(it.magnet),
            quality: parseEpisodes(it.name).quality || qualityRank(it.name),
            needVip: Boolean(it.needVip),
          });
        }
      }
      if (hits.length) {
        hits.sort((a, b) => Number(a.needVip) - Number(b.needVip) || byQuality(a, b, preferred));
        const h = hits[0];
        if (meets(h.quality)) {
          await sleep(300 + Math.round(Math.random() * 400));
          return h.magnet
            ? { magnet: h.magnet, name: h.name, hash: h.hash || hashOf(h.magnet), quality: h.quality, source: cand.source }
            : { torrentUrl: h.torrentUrl, name: h.name, quality: h.quality, source: cand.source };
        }
      }
    } catch (err) {
      notes.push(`取「${String(cand.title).slice(0, 24)}」的详情失败：${String(err.message || err).slice(0, 50)}`);
    }
  }

  // 严格模式：扫遍所有候选都没达标的清晰度，宁缺毋滥——不下，等更高清晰度上线
  if (strict) notes.push(`未找到 ≥${preferred}p 的资源，已按「严格清晰度」设置等待更高清晰度（当前站点最高为更低清晰度）`);
  return null;
}
