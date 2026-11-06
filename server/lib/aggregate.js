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
        const url = it.magnet || it.url || it.down || '';
        if (!url) continue;
        const dedupe = it.hash || url;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const isMagnet = /^magnet:/i.test(url);
        const q = detectQuality(`${it.name || ''} ${g.group || ''}`, '');
        flat.push({
          name: it.name || '未命名资源',
          size: it.size || '',
          url,
          magnet: isMagnet ? url : '',
          kind: isMagnet ? 'magnet' : it.kind || (/^ed2k:/i.test(url) ? 'ed2k' : 'pan'),
          quality: q.label,
          rank: q.rank,
          source: pack.source,
          sourceLabel: pack.label,
          time: it.time || '',
        });
      }
    }
  }
  flat.sort((a, b) => {
    const am = a.magnet ? 1 : 0;
    const bm = b.magnet ? 1 : 0;
    if (am !== bm) return bm - am;
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
  return { total: flat.length, groups };
}
