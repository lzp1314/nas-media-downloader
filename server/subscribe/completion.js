/**
 * 订阅「自动完成」的判定规则（纯函数，不碰文件/网络，方便离线测试）。
 *
 * 用户定的两条规则：
 *   1) 填了补集范围（如 24–40）：只认这个区间，区间内本地文件齐了就算完成，
 *      不看 TMDB 状态、不管全剧还有多少集。
 *   2) 没填补集范围：按 TMDB 走，全剧（或多季剧里实际订阅的那一季）全部集齐才算完成；
 *      TMDB 状态不是「已完结」一律不自动完成（连载剧后面还会更新）。
 *
 * 多季剧：集号每季都从 1 重数，不能拿全剧 number_of_episodes 当上界。
 * 这里从本地文件名里的 SxxExx 认出「实际订阅的是第几季」，再用 TMDB 该季的
 * episode_count 当目标；目录里混了多个季、或文件名不带季号时，宁可不自动完成，
 * 也不猜——猜错会把还没下完的订阅静默归档。
 */
const ENDED = 'Ended';

function coverage(set, from, to) {
  const missing = [];
  for (let i = from; i <= to; i += 1) if (!set.has(i)) missing.push(i);
  return { complete: missing.length === 0, missing };
}

/**
 * @param {{sub:object, have:object, tm:object|null}} arg
 *   sub  = 订阅（startEpisode / endEpisode / state …）
 *   have = scanEpisodes 结果（episodes / seasons）
 *   tm   = tmdbMeta（status / totalEpisodes / totalSeasons / seasons）
 * @returns {{eligible:boolean, complete:boolean, reason:string, scope:string,
 *            from:number, to:number, season:number, label:string, missing:number[], sig:string}}
 *   eligible=false 表示「这条订阅不参与自动完成」，调用方保持原行为继续轮询。
 */
export function completionPlan({ sub, have, tm } = {}) {
  const s = sub || {};
  const h = have || {};
  const meta = tm || null;
  const from = Math.max(1, Math.floor(Number(s.startEpisode) || 1));
  const all = new Set((h.episodes || []).map(Number));
  const none = (reason) => ({
    eligible: false, complete: false, reason, scope: '', from, to: 0, season: 0,
    label: '', missing: [], sig: '',
  });

  // ---- 规则一：手填了「补到第几集」 ----
  const end = Math.floor(Number(s.endEpisode) || 0);
  if (end > 0) {
    if (end < from) return none(`补集范围不合法：第 ${from} 集起却补到第 ${end} 集`);
    const { complete, missing } = coverage(all, from, end);
    return {
      eligible: true, complete, reason: '', scope: 'range', from, to: end, season: 0,
      label: `目标 ${from}–${end} 集（共 ${end - from + 1} 集）`,
      missing,
      sig: `range:${from}-${end}`,
    };
  }

  // ---- 规则二：没填范围 → 必须 TMDB 已完结 ----
  if (!meta) return none('未绑 TMDB，暂不自动完成');
  if (meta.status !== ENDED) return none(`${meta.statusCn || meta.status || '未知'}，暂不自动完成`);
  const total = Math.floor(Number(meta.totalEpisodes) || 0);
  if (total <= 0) return none('TMDB 无总集数，暂不自动完成');

  const seasonRows = Array.isArray(meta.seasons) ? meta.seasons : [];
  const multiSeason = Number(meta.totalSeasons) > 1 || seasonRows.length > 1;

  // ---- 规则二 · 多季剧：按实际订阅的那一季判定 ----
  if (multiSeason) {
    const local = Array.isArray(h.seasons) ? h.seasons : [];
    if (local.length !== 1) {
      return none(local.length > 1
        ? '目录混了多个季，填补集范围后可自动完成'
        : '多季剧无季号，填补集范围后可自动完成');
    }
    const season = Math.floor(Number(local[0].season) || 0);
    const row = seasonRows.find((x) => Number(x.number) === season);
    const to = Math.floor(Number(row?.episodeCount) || 0);
    if (season <= 0 || to <= 0) return none(`缺第 ${season} 季集数，暂不自动完成`);
    const set = new Set((local[0].episodes || []).map(Number));
    const { complete, missing } = coverage(set, from, to);
    return {
      eligible: true, complete, reason: '', scope: 'season', from, to, season,
      label: `第 ${season} 季 ${from}–${to} 集`,
      missing,
      sig: `season:${season}:${from}-${to}`,
    };
  }

  // ---- 规则二 · 单季剧：全剧 1..total ----
  const { complete, missing } = coverage(all, from, total);
  return {
    eligible: true, complete, reason: '', scope: 'series', from, to: total, season: 0,
    label: `全剧 ${from}–${total} 集`,
    missing,
    sig: `series:${from}-${total}`,
  };
}

/** 连续两次齐全才归档用的签名比较；签名变了（区间/季改过）就重新计数 */
export function nextStreak(sub, sig) {
  if (!sig) return 0;
  if (String(sub?.doneSig || '') !== sig) return 1;
  return Math.max(1, Math.floor(Number(sub?.doneStreak) || 0) + 1);
}

export const DONE_STREAK = 2;
