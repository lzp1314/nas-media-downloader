import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 订阅用的集数/清晰度解析。
 *
 * 和 lib/media.js 的 detectEpisode 分工不同：那边只回答「这一条是第几集」用于列表排序，
 * 这里还要回答三个订阅必需的问题：
 *   1. 一条资源覆盖了哪几集（单集 / 21-22 这种连播 / 整季包）
 *   2. 这条资源是什么清晰度（用于按偏好挑候选）
 *   3. 本地目录里已经有哪几集（缺失集的判定基准）
 */

const VIDEO_EXT = /\.(mkv|mp4|avi|rmvb|rm|mov|wmv|flv|webm|ts|m2ts|m4v|mpg|mpeg|iso|3gp|vob)$/i;

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 只处理 1~99 的中文数字，够覆盖「第十二集」这种写法 */
function cnNumber(raw) {
  const s = String(raw || '');
  if (!s) return null;
  if (!/[一二三四五六七八九十零]/.test(s)) return null;
  const idx = s.indexOf('十');
  if (idx === -1) {
    return s.length === 1 && s in CN_DIGIT ? CN_DIGIT[s] : null;
  }
  const head = s.slice(0, idx);
  const tail = s.slice(idx + 1);
  const tens = head ? CN_DIGIT[head] : 1;
  const ones = tail ? CN_DIGIT[tail] : 0;
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

/**
 * 清晰度归一：2160 / 1080 / 720 / 480 / 0（未知）。
 * 数字越大越好，订阅按偏好从高到低挑。
 */
export function qualityRank(name) {
  const s = String(name || '');
  if (/(?:^|[^0-9])(?:2160|4k|uhd)(?:[^0-9]|$)/i.test(s)) return 2160;
  if (/(?:^|[^0-9])1080(?:[pi]|[^0-9]|$)/i.test(s)) return 1080;
  if (/(?:^|[^0-9])720(?:[pi]|[^0-9]|$)/i.test(s)) return 720;
  if (/(?:^|[^0-9])(?:480|576)(?:[pi]|[^0-9]|$)/i.test(s)) return 480;
  return 0;
}

/** 名字里带这些词，说明这一条不是一个单集 */
const PACK_HINTS = /全集|全\s*\d+\s*集|合集|合集包|季[一-龥\d]|S\d{1,2}\s*(?:Complete|全)|Complete|更新至|打包|整季|第[一二三四五六七八九十\d]+季/i;

/**
 * 名字里的技术标记：编码器、分辨率、发行格式、音轨、年份。
 *
 * 片库里的电影文件名典型长这样：功夫女足.2026.2160p.WEB-DL.H265.DV.mkv
 * 不先抹掉这些东西，「H265」会被文件名兜底读成第 265 集、「H264」读成第 264 集、
 * 「1982」读成第 1982 集。目录一旦选在片库根，全库文件混在一起算，
 * 目标集数就会凭空变成几百集——这正是「本地 32 集却显示目标 265 集」的来源。
 */
const NOISE_PATTERNS = [
  /[xh]\.?\s?26[45]/gi, // x264 / H.265
  /\b(?:hevc|avc|xvid|divx|av1|vp9)\b/gi,
  /\b(?:2160|1080|720|576|480)\s?[pi]\b/gi, // 1080p / 720i
  /\b(?:4k|uhd|fullhd)\b/gi,
  /\b(?:web-?dl|web-?rip|blu-?ray|bdrip|hdtv|dvdrip|remux|hdcam|hdrip)\b/gi,
  /\b(?:aac|ac3|eac3|dts(?:-hd)?|truehd|atmos|flac|opus|ddp?\s?\d(?:\.\d)?)\b/gi,
  /\b(?:10|8)\s?bits?\b/gi,
  /\b(?:hdr10|hdr|sdr|dolby\s?vision|dv)\b/gi,
  // 年份：只抹四位数，且要求是独立的一段（前后不是数字），避免碰到「第2021集」
  /(?:^|[^0-9])(?:19|20)\d{2}(?![0-9])/g,
];

function stripNoise(raw) {
  let s = String(raw || '');
  for (const re of NOISE_PATTERNS) s = s.replace(re, ' ');
  return s;
}

/** 这些数字天生不像集号（编码器/分辨率），只在「文件名兜底」这种没上下文的分支里拦截 */
const NOT_EPISODE = new Set([264, 265, 480, 576, 720, 1080, 2160, 4096]);

/**
 * 解析一条资源名覆盖的集数。
 * @returns {{episodes:number[], pack:boolean, upTo:number, quality:number}}
 *   episodes 明确指向的集号；pack=true 表示这是多集整包，具体集数要靠种子文件清单确认；
 *   upTo 是「更新至 N 集」给出的上界，0 表示没有这个信息。
 */
export function parseEpisodes(name) {
  const raw = String(name || '');
  // 清晰度从原名取（去噪会把 1080p 抹掉），集号从去噪后的字符串取
  const quality = qualityRank(raw);
  const s = stripNoise(raw);
  const episodes = new Set();
  let pack = PACK_HINTS.test(s);
  let upTo = 0;

  const add = (n) => {
    const v = Number(n);
    if (Number.isInteger(v) && v > 0 && v <= 2000) episodes.add(v);
  };

  // 1) 「第 21-22 集」「第21、22集」「第二十一集」
  const cn = s.match(/第\s*([一二三四五六七八九十]{1,3})\s*[集话話期回]/);
  if (cn) {
    const n = cnNumber(cn[1]);
    if (n) add(n);
  }
  const range = s.match(/第\s*(\d{1,4})\s*[-~至到]\s*(\d{1,4})\s*[集话話期回]/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (b >= a && b - a <= 100) {
      for (let i = a; i <= b; i += 1) add(i);
      pack = true;
    }
  }
  const list = s.match(/第\s*(\d{1,4}(?:\s*[、,，]\s*\d{1,4})+)\s*[集话話期回]/);
  if (list) for (const x of list[1].split(/[、,，]/)) add(x.trim());

  // 2) 单集：「第21集」「[第21集]」
  if (!episodes.size) {
    const single = s.match(/第\s*(\d{1,4})\s*[集话話期回]/);
    if (single) add(single[1]);
  }

  // 3) 欧美命名：S01E05 / S01E05E06 / EP05 / E05
  const se = s.match(/S\d{1,2}\s*E(\d{1,3})(?:\s*[-~]?\s*E(\d{1,3}))?/i);
  if (se) {
    add(se[1]);
    if (se[2]) add(se[2]);
  }
  if (!episodes.size) {
    const ep = s.match(/(?:^|[^A-Za-z])EP?\.?\s*(\d{1,4})(?![0-9])/i);
    if (ep) add(ep[1]);
  }

  // 4) 「更新至 20 集」：包内上界，本身不是单集
  const upto = s.match(/更新至\s*第?\s*(\d{1,4})\s*[集话話]/);
  if (upto) {
    upTo = Number(upto[1]);
    pack = true;
  }
  const total = s.match(/[全共]\s*(\d{1,4})\s*集/);
  if (total) {
    upTo = Number(total[1]);
    pack = true;
  }

  // 5) 方括号集号：[199]。必须排除 [1080p]、[4K]、[2026] 这类
  if (!episodes.size) {
    const bracket = s.match(/\[\s*(\d{1,3})\s*\]/);
    if (bracket) {
      const after = s.charAt(s.indexOf(bracket[0]) + bracket[0].length);
      if (!/[pPiI]/.test(after)) add(bracket[1]);
    }
  }

  // 6) 文件名兜底：01.mkv / 第01话.mp4 / 21 - xxx.mkv
  if (!episodes.size) {
    const file = s.match(/(?:^|[^0-9])(\d{1,4})\s*(?:[.、\-_]\s*[^.、\-_\s]{0,40})?\.(?:mkv|mp4|avi|rmvb|ts|mov|flv|wmv)$/i);
    // 兜底没有「第…集」这种上下文，1080/264 这类数字多半是规格而不是集号
    if (file && !NOT_EPISODE.has(Number(file[1]))) add(file[1]);
  }

  return { episodes: [...episodes].sort((a, b) => a - b), pack, upTo, quality };
}

/** 一条资源是否明显是视频（用于过滤站点上的预告/花絮压缩包） */
export function looksLikeVideo(name) {
  return VIDEO_EXT.test(String(name || ''));
}

/** 小于这个体积的「视频」多半是样片或花絮，补集时不要 */
const MIN_EPISODE_BYTES = 30 * 1024 * 1024;

/**
 * 从种子文件清单里挑出「这次真要下的那几个文件」。
 *
 * 站点上一个种子常常一次带好几集（[38-43集]），整包下会白占几 GB，
 * 还可能把用户还没到的集提前下下来。这里按文件名读集号，只留需要的。
 *
 * @param {Array<{index:number, path:string}>} files 种子里的文件清单
 * @param {number[]} want 这次要补的集
 * @returns {string} 逗号分隔的序号（1 基，与引擎的 select-file 对齐）；空串表示不用裁剪
 */
export function pickFileIndexes(files, want) {
  const list = Array.isArray(files) ? files : [];
  const wantSet = new Set((want || []).map(Number));
  if (!list.length || !wantSet.size) return '';
  const covered = new Set();
  const hit = [];
  for (const f of list) {
    const p = String(f?.path || '');
    const eps = parseEpisodes(`${p} ${path.basename(p)}`).episodes;
    for (const n of eps) covered.add(n);
    if (eps.some((n) => wantSet.has(n))) hit.push(Number(f.index));
  }
  // 种子里本来就只有要的这几集，那就整包下，不用切
  if (covered.size && [...covered].every((n) => wantSet.has(n))) return '';
  // 一个文件都认不出来，或者认出来就是全部，都不折腾
  if (!hit.length || hit.length >= list.length) return '';
  return hit.filter((n) => Number.isInteger(n) && n > 0).join(',');
}

/**
 * 扫本地目录已有哪些集。
 * 判定基准放在文件系统上而不是数据库里：用户手动下的、别的工具下的都能算进来，
 * 也不怕配置丢失（Sonarr 也是扫媒体库而不是只信自己的记录）。
 */
export async function scanEpisodes(dir, { maxDepth = 3 } = {}) {
  const found = new Set();
  let files = 0; // 合格的视频文件数（认不认得出集号都算）
  let matched = 0; // 其中有集号的
  let bytes = 0;

  const walk = async (current, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return; // 目录不存在 / 没权限：当作空
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(current, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile() || !VIDEO_EXT.test(e.name)) continue;
      let size = 0;
      try {
        size = (await fsp.stat(abs)).size;
      } catch {
        continue;
      }
      if (size < MIN_EPISODE_BYTES) continue;
      // 先记数再解析：认不出集号的视频也要统计，否则「目录选到片库根」时
      // 卡片上只会显示一个莫名其妙的集数，看不出真正的问题
      files += 1;
      bytes += size;
      const { episodes } = parseEpisodes(e.name);
      if (!episodes.length) continue;
      matched += 1;
      for (const n of episodes) found.add(n);
    }
  };

  await walk(dir, 0);
  return { episodes: [...found].sort((a, b) => a - b), files, matched, bytes };
}

/**
 * 计算还缺哪几集。
 * @param {{have:number[], sent:object, from:number, to:number}} arg
 */
export function missingEpisodes({ have, sent, from = 1, to = 0 }) {
  const has = new Set(have || []);
  const done = new Set(
    Object.entries(sent || {})
      .filter(([, v]) => v && v.state !== 'failed')
      .map(([k]) => Number(k)),
  );
  const out = [];
  for (let i = Math.max(1, from); i <= to; i += 1) {
    if (!has.has(i) && !done.has(i)) out.push(i);
  }
  return out;
}
