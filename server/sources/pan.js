import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, loadSettings } from '../settings.js';
import { httpRequest, DEFAULT_UA, humanSize, decodeEntities } from '../lib/util.js';

/**
 * 网盘分享链接解析（插件式、不绑定某个片源）：
 *  - 识别链接类型与提取码
 *  - 常见网盘走适配器（接口地址可在 config/pan-sources.json 覆盖）
 *  - 其余站点走通用页面提取，能读多少读多少，读不到就明确告诉用户
 *  - 下载直链在点「下载」那一刻现取（分享令牌只有几分钟有效期）
 */
const VIDEO_EXT = /\.(mkv|mp4|avi|rmvb|rm|mov|wmv|flv|webm|ts|m2ts|m4v|mpg|mpeg|iso|3gp|vob)$/i;
const MAX_FILES = 300;
const PAN_CONFIG = path.join(CONFIG_DIR, 'pan-sources.json');
const DEFAULT_API = {
  quark: process.env.PAN_QUARK_API || 'https://drive-pc.quark.cn',
  uc: process.env.PAN_UC_API || 'https://drive-pc.uc.cn',
};

function quarkReferer(api) {
  return /uc\.cn/i.test(String(api)) ? 'https://pan.uc.cn/' : 'https://pan.quark.cn/';
}

function apiBase(provider) {
  try {
    const custom = JSON.parse(fs.readFileSync(PAN_CONFIG, 'utf8'));
    const v = custom?.[provider]?.api;
    if (/^https?:\/\//i.test(String(v || ''))) return String(v).replace(/\/+$/, '');
  } catch { /* 没配就用默认 */ }
  return DEFAULT_API[provider] || '';
}

function panCookie() {
  return String(loadSettings().pan?.cookie || '').trim();
}

/** 从一整段复制文本里挑出链接和提取码（用户经常连「提取码: abcd」一起复制） */
export function classifyLink(text) {
  const s = String(text || '').trim();
  const magnet = s.match(/magnet:\?xt=urn:btih:[0-9a-z]{32,40}[^\s<>"'）)]*/i);
  if (magnet) return { kind: 'magnet', url: magnet[0] };

  const url = s.match(/https?:\/\/[^\s<>"'）)]+/i);
  if (!url) return { kind: 'unknown', url: '' };
  const clean = url[0].replace(/[.,;，。；、]+$/, '');
  let passcode = '';
  const m = s.match(/(?:提取码|访问码|密码|提取|pwd|passcode|code)\s*[:：]?\s*([0-9a-zA-Z]{4,8})(?![\w])/i);
  if (m) passcode = m[1];
  if (!passcode) {
    try {
      const u = new URL(clean);
      passcode = u.searchParams.get('pwd') || u.searchParams.get('passcode') || '';
    } catch { /* 忽略非法链接 */ }
  }
  return { kind: 'url', url: clean, passcode };
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

function makeFile(raw) {
  const name = decodeEntities(String(raw.name || '').trim()).replace(/[\\/]/g, '_');
  if (!name) return null;
  const size = Number(raw.size) || 0;
  return {
    id: String(raw.id ?? name),
    name,
    path: String(raw.path || name),
    size,
    sizeText: size ? humanSize(size) : '',
    url: String(raw.url || ''),
    episode: detectEpisode(`${raw.path || ''} ${name}`),
    video: isVideo(name),
  };
}

function sortFiles(files) {
  return files.sort((a, b) => {
    if (a.video !== b.video) return a.video ? -1 : 1;
    if (a.episode !== null && b.episode !== null && a.episode !== b.episode) return a.episode - b.episode;
    if (a.episode !== null && b.episode === null) return -1;
    if (a.episode === null && b.episode !== null) return 1;
    return a.name.localeCompare(b.name, 'zh');
  });
}

function detectProvider(rawUrl) {
  let host = '';
  let pathname = '';
  try {
    const u = new URL(rawUrl);
    host = u.hostname.toLowerCase();
    pathname = u.pathname;
  } catch {
    return { provider: 'generic', api: '' };
  }
  if (/(^|\.)(quark\.cn|quark\.com)$/.test(host)) return { provider: 'quark', api: apiBase('quark') };
  if (/(^|\.)uc\.cn$/.test(host) || /drive-pc/.test(host)) return { provider: 'uc', api: apiBase('uc') };
  if (/123(pan|684|865|912)\./.test(host)) return { provider: '123', api: '' };
  if (/lanzou|lanzoux|lanzoui/.test(host)) return { provider: 'lanzou', api: '' };
  if (/pan\.baidu|yun\.baidu/.test(host)) return { provider: 'baidu', api: '' };
  if (/alipan|aliyundrive/.test(host)) return { provider: 'ali', api: '' };
  if (/pan\.xunlei|xunlei\.com/.test(host)) return { provider: 'xunlei', api: '' };
  if (/115\.com|139\.com|189\.cn/.test(host)) return { provider: 'other', api: '' };
  // 直链：链接本身就是一个视频文件
  if (VIDEO_EXT.test(pathname)) return { provider: 'direct', api: '' };
  return { provider: 'generic', api: '' };
}

function shareId(rawUrl) {
  const m = String(rawUrl).match(/\/s\/([0-9a-zA-Z_-]+)/);
  if (m) return m[1];
  try {
    const u = new URL(rawUrl);
    return u.searchParams.get('sid') || u.searchParams.get('id') || '';
  } catch {
    return '';
  }
}

function quarkHeaders(api, withJson = false) {
  const cookie = panCookie();
  return {
    'User-Agent': DEFAULT_UA,
    Referer: quarkReferer(api),
    Origin: quarkReferer(api).replace(/\/$/, ''),
    ...(withJson ? { 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

async function quarkToken(api, pwdId, passcode) {
  const url = `${api}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=&__dt=1&__t=${Date.now()}`;
  const res = await httpRequest(url, {
    method: 'POST',
    headers: quarkHeaders(api, true),
    body: JSON.stringify({ pwd_id: pwdId, passcode: passcode || '' }),
    timeout: 12000,
  });
  let j;
  try { j = JSON.parse(res.text); } catch { throw new Error('分享验证接口没返回 JSON'); }
  if (String(j.status) !== '200' || !j.data?.stoken) {
    throw new Error(String(j.message || '分享验证失败，提取码可能不对或分享已失效').slice(0, 80));
  }
  return j.data.stoken;
}

async function quarkDetail(api, pwdId, stoken, pdir, depth = 0) {
  if (depth > 3) return [];
  const q = new URLSearchParams({
    pr: 'ucpro', fr: 'pc', pwd_id: pwdId, stoken,
    pdir_fid: pdir || '0', force: '0', _page: '1', _size: '100',
    _fetch_banner: '1', _fetch_share: '1', _fetch_total: '1',
    _sort: 'file_type:asc,file_name:asc',
  });
  const res = await httpRequest(`${api}/1/clouddrive/share/sharepage/detail?${q}`, {
    headers: quarkHeaders(api),
    timeout: 12000,
  });
  let j;
  try { j = JSON.parse(res.text); } catch { throw new Error('文件列表接口没返回 JSON'); }
  if (String(j.status) !== '200') throw new Error(String(j.message || '读取分享文件列表失败').slice(0, 80));
  const list = Array.isArray(j.data?.list) ? j.data.list : [];
  const out = [];
  for (const it of list) {
    const name = String(it.file_name || it.name || '');
    if (it.dir || it.file_type === 0 || !name) {
      const fid = String(it.fid || '');
      if (fid) out.push(...await quarkDetail(api, pwdId, stoken, fid, depth + 1));
      continue;
    }
    const f = makeFile({
      id: String(it.fid || name),
      name,
      path: `${pdir === '0' ? '' : pdir}/${name}`,
      size: it.size,
    });
    if (f) { f.fid = String(it.fid || ''); f.fidToken = String(it.share_fid_token || ''); out.push(f); }
  }
  return out;
}

/** 通用页面提取：SPA 站点拿不到就返回空，由调用方给出明确提示 */
async function genericList(rawUrl) {
  const cookie = panCookie();
  const res = await httpRequest(rawUrl, {
    headers: { 'User-Agent': DEFAULT_UA, ...(cookie ? { Cookie: cookie } : {}) },
    timeout: 12000,
  });
  const html = String(res.text || '');
  const found = new Map();

  const push = (name, link = '', size = 0) => {
    const clean = decodeEntities(String(name || '').trim());
    if (!clean || clean.length > 180 || !/\.[0-9a-z]{2,5}$/i.test(clean)) return;
    if (found.has(clean)) return;
    let url = '';
    if (/^https?:\/\//i.test(link)) url = link;
    else if (link && !/^(#|javascript:)/i.test(link)) {
      try { url = new URL(link, rawUrl).toString(); } catch { /* 忽略 */ }
    }
    const f = makeFile({ id: clean, name: clean, path: clean, size, url });
    if (f) found.set(clean, f);
  };

  // 1) 页面里的 <a href="...">文件名.mkv</a>
  const aRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi;
  for (let m; (m = aRe.exec(html)); ) {
    const label = String(m[2]).replace(/<[^>]*>/g, '').trim();
    push(label, m[1]);
  }
  // 2) 内嵌 JSON 里的 file_name / filename / name + size
  const jsonRe = /"(?:file_name|filename|fileName|file|name)"\s*:\s*"([^"\\]{2,180}\.[0-9a-z]{2,5})"/gi;
  for (let m; (m = jsonRe.exec(html)); ) {
    const tail = html.slice(m.index, m.index + 400);
    const size = Number((tail.match(/"(?:size|file_size|filesize|length)"\s*:\s*(\d+)/i) || [])[1]) || 0;
    push(m[1], '', size);
  }
  // 3) 纯文本行「第01集 xxx.mkv」
  for (const line of html.replace(/<[^>]*>/g, '\n').split(/\n+/)) {
    const t = line.trim();
    if (t.length < 200 && /\.[0-9a-z]{2,5}(?:\s|$)/i.test(t)) push(t);
  }
  return [...found.values()].slice(0, MAX_FILES);
}

/**
 * 解析一个分享链接，返回可展示的文件列表。
 * share 对象只留在服务端缓存里（含临时令牌），不下发到浏览器。
 */
export async function resolveShare(rawUrl, passcode = '') {
  const { provider, api } = detectProvider(rawUrl);
  const cookie = panCookie();
  const notes = [];
  let files = [];
  let title = '';
  let share = { provider, url: rawUrl, passcode, files: [] };

  if (provider === 'direct') {
    const name = decodeURIComponent(path.basename(new URL(rawUrl).pathname)) || '下载文件';
    files = [makeFile({ id: 'direct', name, path: name, url: rawUrl })].filter(Boolean);
    share = { ...share, files };
    return { provider, title: name, files: sortFiles(files), needCookie: false, notes, share };
  }

  if (provider === 'quark' || provider === 'uc') {
    const pwdId = shareId(rawUrl);
    if (!pwdId) throw new Error('分享链接里没识别到分享 ID');
    const stoken = await quarkToken(api, pwdId, passcode);
    const listed = await quarkDetail(api, pwdId, stoken, '0');
    files = listed.slice(0, MAX_FILES);
    share = { provider, api, pwdId, stoken, passcode, cookieSet: Boolean(cookie), tokens: {}, files };
    for (const f of files) share.tokens[f.id] = f.fidToken || '';
    title = `网盘分享 · ${files.length} 个文件`;
    if (!cookie) notes.push('看列表不需要登录；要直接下载到 NAS，请到「设置 → 片源与网盘 → 网盘解析」填一次浏览器 Cookie。');
    if (!files.length) notes.push('这个分享里没读到文件，可能已失效或需要提取码。');
    return { provider, title, files: sortFiles(files), needCookie: !cookie, notes, share };
  }

  // 其余站点：先试通用页面提取，拿不到就明确说明原因，不假装有结果
  try {
    files = await genericList(rawUrl);
  } catch (err) {
    notes.push(`读取分享页失败：${String(err.message || err).slice(0, 80)}`);
  }
  const known = {
    baidu: '这个网盘要登录态与客户端签名，程序拿不到直链',
    ali: '这个网盘要登录态与签名，程序拿不到直链',
    xunlei: '这个网盘要账号授权，程序拿不到直链',
    other: '这个网盘需要登录或专用客户端，程序拿不到直链',
    123: '这个网盘下载要登录态，程序拿不到直链',
  };
  if (known[provider]) notes.unshift(`${known[provider]}；下面能看到的只是页面里读出的文件名。`);
  if (!files.length) {
    notes.push('分享页是动态渲染的，程序没能读出文件列表。可以复制原链接到浏览器里打开，或用网盘客户端转存。');
  } else {
    notes.push('能直接下载的条目会带「直链」标记；没有直链的只能复制文件名去网盘里找。');
  }
  share = { ...share, files };
  title = `分享链接 · ${files.length} 个文件`;
  return { provider, title, files: sortFiles(files), needCookie: false, notes, share };
}

/** 点「下载」时现取直链：stoken 有时效，失败后自动刷新一次令牌再试 */
export async function resolveDownloadUrls(share, ids) {
  const picked = (ids || []).map(String);
  if (!picked.length) throw new Error('没有选中任何文件');
  const byId = new Map((share.files || []).map((f) => [String(f.id), f]));
  const targets = picked.map((id) => byId.get(id)).filter(Boolean);

  if (share.provider === 'quark' || share.provider === 'uc') {
    const cookie = panCookie();
    if (!cookie) throw new Error('这类网盘下载需要登录态，请到「设置 → 片源与网盘 → 网盘解析」填一次浏览器 Cookie');
    const api = share.api || apiBase(share.provider);
    const fids = targets.map((f) => f.fid || f.id);
    // 文件令牌优先用条目自带的（解析那一刻就跟着文件走），再看按 id 建的索引表
    const tokensOf = () => targets.map((f) => String(share.tokens?.[String(f.id)] || f.fidToken || ''));
    /**
     * 分享直链接口。
     * 坑一：字段名是 share_fid_tokens，写成 fids_token 站点会当作没传令牌，
     *       直接回「转存文件token校验异常」——这个提示跟真正的过期长得一样，很容易误判。
     * 坑二：路径在 share/sharepage/download，不是 file/share/download。
     */
    const call = async (stoken) => {
      const url = `${api}/1/clouddrive/share/sharepage/download?pr=ucpro&fr=pc&uc_param_str=`;
      const tokens = tokensOf();
      return httpRequest(url, {
        method: 'POST',
        headers: quarkHeaders(api, true),
        body: JSON.stringify({
          fids,
          pwd_id: share.pwdId,
          stoken,
          share_fid_tokens: tokens,
          fids_token: tokens, // 兼容部分镜像站的旧字段名
        }),
        timeout: 15000,
      });
    };
    const parse = (res) => {
      let j;
      try { j = JSON.parse(res.text); } catch { throw new Error('直链接口没返回 JSON'); }
      if (String(j.status) !== '200') {
        const msg = String(j.message || '取直链失败');
        if (/token|令牌/i.test(msg)) {
          throw new Error(`${msg.slice(0, 60)}（分享令牌与文件令牌不是同一次取到的）`);
        }
        throw new Error(msg.slice(0, 80));
      }
      // 返回形状有两种：data 是数组（每个带 download_url），或 data 直接带一个 download_url
      const list = Array.isArray(j.data) ? j.data : j.data ? [j.data] : [];
      return list.map((d) => String(d.download_url || d.url || '')).filter((u) => /^https?:\/\//i.test(u));
    };
    /** stoken 换新后必须重拉一次文件列表：文件令牌是跟 stoken 绑定的，只换 stoken 会继续报校验异常 */
    const refresh = async () => {
      const fresh = await quarkToken(api, share.pwdId, share.passcode).catch(() => '');
      if (!fresh) throw new Error('分享令牌已过期，请重新解析一次链接');
      share.stoken = fresh;
      const listed = await quarkDetail(api, share.pwdId, fresh, '0').catch(() => []);
      const map = new Map();
      for (const f of listed) map.set(String(f.fid || f.id), String(f.fidToken || ''));
      share.tokens = share.tokens || {};
      for (const f of share.files || []) {
        const t = map.get(String(f.fid || f.id)) || map.get(String(f.id));
        if (t) share.tokens[f.id] = t;
      }
    };
    let urls = [];
    try {
      urls = parse(await call(share.stoken));
    } catch (first) {
      await refresh();
      urls = parse(await call(share.stoken));
    }
    if (!urls.length) throw new Error('这次没拿到下载直链，可能登录态已失效，或该网盘限制了非客户端下载');
    const headers = [
      `Cookie: ${cookie}`,
      `Referer: ${quarkReferer(api)}`,
      `User-Agent: ${DEFAULT_UA}`,
    ];
    return urls.map((url, n) => ({
      url,
      out: targets[n]?.name || targets[Math.min(n, targets.length - 1)]?.name || '',
      headers,
    }));
  }

  // 通用解析：只下发了明确的 http 直链
  const urls = targets
    .filter((f) => /^https?:\/\//i.test(f.url))
    .map((f) => ({ url: f.url, out: f.name, headers: [] }));
  if (!urls.length) {
    throw new Error('这个网盘没给出可用的下载直链，只能复制链接到浏览器或网盘客户端下载');
  }
  return urls;
}
