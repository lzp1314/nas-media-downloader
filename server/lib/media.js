/**
 * 链接识别与媒体文件判定的纯函数。
 *
 * 只认磁力与 .torrent 种子，不解析任何网盘分享链接。
 * 这几个函数原先放在 sources/pan.js 里，但磁力「选集」列集号、订阅按集裁剪
 * 都要用它们，跟网盘解析并没有耦合，所以单独抽出来，网盘整块删掉也不影响。
 */
const VIDEO_EXT = /\.(mkv|mp4|avi|rmvb|rm|mov|wmv|flv|webm|ts|m2ts|m4v|mpg|mpeg|iso|3gp|vob)$/i;

/** 从一整段复制文本里挑出磁力或 .torrent 地址；其它链接一律不认 */
export function classifyLink(text) {
  const s = String(text || '').trim();
  const magnet = s.match(/magnet:\?xt=urn:btih:[0-9a-z]{32,40}[^\s<>"'）)]*/i);
  if (magnet) return { kind: 'magnet', url: magnet[0] };

  const url = s.match(/https?:\/\/[^\s<>"'）)]+/i);
  if (url) {
    const clean = url[0].replace(/[.,;，。；、]+$/, '');
    try {
      if (/\.torrent$/i.test(new URL(clean).pathname)) return { kind: 'torrent', url: clean };
    } catch { /* 非法链接，按无法识别处理 */ }
  }
  return { kind: 'unknown', url: '' };
}

/** 识别「第28集 / EP28 / S01E05 / [12] / 01.mkv」里的集数，用于排序与筛选 */
export function detectEpisode(name) {
  const s = String(name || '');
  const rules = [
    /第\s*(\d{1,4})\s*[集话話期回]/,
    /\bEP?\.?\s*(\d{1,4})\b/i,
    /\bS\d{1,2}E(\d{1,3})\b/i,
    /\[(\d{1,4})\]/,
    /(?:^|[^\d])(\d{1,4})\s*[.、\-_]\s*(?:mkv|mp4|avi|rmvb|ts|mov|flv|wmv)/i,
  ];
  for (const re of rules) {
    const m = s.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

export function isVideo(name) {
  return VIDEO_EXT.test(String(name || ''));
}
