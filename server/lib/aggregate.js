/**
 * 多来源结果聚合：把不同站点的同名影片合成一条，点开后再统一解析资源。
 */

/** 归一化标题，用于跨站合并同一部片 */
export function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·:：\-—_()（）[\]【】《》.,，。!！?？'"“”‘’/\\|]/g, '')
    .replace(/^(全集|完结|高清|hd|bd|tc|ts|正片|国语|粤语)+/g, '');
}

const QUALITY_RULES = [
  { label: '4K', rank: 60, re: /(2160p|2160|4k|uhd)/i },
  { label: '1080P', rank: 50, re: /(1080p|1080i|fhd|fullhd)/i },
  { label: '720P', rank: 40, re: /(720p)/i },
  { label: '蓝光原盘', rank: 45, re: /(蓝光|bluray|blu-ray|remux|原盘|bdrip)/i },
  { label: '480P', rank: 20, re: /(480p|360p|hdrip|cam|ts版|枪版)/i },
];

export function detectQuality(name, fallback = '') {
  const text = String(name || '');
  for (const q of QUALITY_RULES) {
    if (q.re.test(text)) return { label: q.label, rank: q.rank };
  }
  if (fallback) return { label: String(fallback).toUpperCase(), rank: 30 };
  return { label: '其他', rank: 10 };
}

/**
 * 合并搜索结果
 * @param {{source:string, item:object}[]} raw
 * @param {string} keyword
 */
export function mergeSearchItems(raw, keyword) {
  const map = new Map();
  for (const { source, item } of raw) {
    if (!item || !item.id) continue;
    const key = normTitle(item.title) || String(item.id);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        title: item.title,
        image: '',
        year: '',
        score: '',
        quality: '',
        tags: '',
        type: item.type || '',
        sources: [],
        variants: [],
        mSources: [],
        mCount: 0,
      };
      map.set(key, g);
    }
    if (!g.image && item.image) g.image = item.image;
    if (!g.year && item.year) g.year = item.year;
    if (!g.score && item.score) g.score = item.score;
    if (!g.type && item.type) g.type = item.type;
    if (!g.quality && item.quality) g.quality = item.quality;
    if (!g.tags && item.tags) g.tags = item.tags;
    if (!g.sources.includes(source)) g.sources.push(source);
    // 磁力是聚合过来的一条，但用户想知道具体是哪几个源搜到的
    if (item.mSources?.length) {
      for (const n of item.mSources) if (!g.mSources.includes(n)) g.mSources.push(n);
    }
    if (item.mCount) g.mCount = Math.max(g.mCount || 0, item.mCount);
    if (!g.variants.some((v) => v.source === source && v.id === item.id)) {
      g.variants.push({ source, id: item.id, quality: item.quality || '', type: item.type || '' });
    }
  }

  const kw = normTitle(keyword);
  const out = [...map.values()];
  for (const g of out) {
    const nt = normTitle(g.title);
    let rank;
    if (!kw) rank = 20;
    else if (nt === kw) rank = 100;
    else if (nt.startsWith(kw)) rank = 72;
    else if (nt.includes(kw)) rank = 50;
    else rank = 20 - Math.min(15, Math.abs(nt.length - kw.length));
    rank += Math.min(18, (g.variants.length - 1) * 6);
    if (g.image) rank += 2;
    g.rank = rank;
  }
  out.sort((a, b) => b.rank - a.rank || a.title.length - b.title.length);
  return out;
}

/**
 * 把多个站点的资源列表拍平、去重、按清晰度分档
 * @param {{source:string, label:string, groups:object[]}[]} packs
 */
export function normalizeResources(packs) {
  const seen = new Set();
  const flat = [];
  for (const pack of packs) {
    for (const g of pack.groups || []) {
      for (const it of g.items || []) {
        const url = it.magnet || it.url || it.torrentUrl || it.down || '';
        // 站点把链接锁住、或只给种子 id（磁力要另外换）时，条目仍然要列出来，
        // 只是没有可点的链接，否则用户会以为站点没给
        if (!url && !it.locked && !it.seedId) continue;
        const dedupe = it.dedupeKey || it.hash || url || `${pack.source}:${g.group}:${it.name}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const isMagnet = /^magnet:/i.test(url);
        // 站点只给 .torrent 下载地址时也算种子，不能因为不是 magnet: 开头就漏掉
        const isTorrent = !isMagnet && (it.kind === 'torrent' || Boolean(it.torrentUrl));
        // 只有种子 id、链接还没换的，先按种子归类，点下载时再换磁力
        const isSeed = isMagnet || isTorrent || (it.kind === 'seed' && Boolean(it.seedId));
        // 只收种子 / 磁力：网盘、电驴、普通网页直链一律不进结果
        if (!isSeed) continue;
        const q = detectQuality(`${it.name || ''} ${g.group || ''}`, '');
        const kind = isMagnet ? 'magnet' : isTorrent ? 'torrent' : 'seed';
        flat.push({
          name: it.name || '未命名资源',
          size: it.size || '',
          url,
          magnet: isMagnet ? url : '',
          torrentUrl: isTorrent ? (it.torrentUrl || (/^https?:\/\//i.test(url) ? url : '')) : '',
          seedId: String(it.seedId || ''),
          needVip: Boolean(it.needVip),
          kind,
          spec: String(it.spec || it.quality || g.group || '').trim(),
          locked: Boolean(it.locked),
          code: String(it.code || '').trim(),
          by: String(it.by || '').trim(),
          quality: q.label,
          rank: q.rank,
          source: pack.source,
          // 磁力条目自带来源名（用户给每个源起的名字），优先用它，别一律写成「磁力搜索」
          sourceLabel: String(it.sourceLabel || '').trim() || pack.label,
          time: it.time || '',
        });
      }
    }
  }
  flat.sort((a, b) => {
    if (a.locked !== b.locked) return a.locked ? 1 : -1;
    return b.rank - a.rank;
  });

  const order = ['4K', '蓝光原盘', '1080P', '720P', '480P', '其他'];
  const buckets = new Map();
  for (const it of flat) {
    if (!buckets.has(it.quality)) buckets.set(it.quality, []);
    buckets.get(it.quality).push(it);
  }
  const groups = [...buckets.entries()]
    .sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || b[1].length - a[1].length;
    })
    .map(([label, items]) => ({ label: label === '其他' ? '其他资源' : label, items }));
  const tally = (rows, pick) => {
    const m = new Map();
    for (const r of rows) {
      const label = String(pick(r) || '').trim() || '其他';
      m.set(label, (m.get(label) || 0) + 1);
    }
    return [...m.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh'));
  };
  const seedSpecs = tally(flat, (x) => x.spec || x.quality);
  const specs = seedSpecs.map((x) => ({ ...x, kind: 'seed' }));
  const facets = { total: flat.length, seed: flat.length, seedSpecs, specs };
  return { total: flat.length, groups, facets };
}
