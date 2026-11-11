import { httpRequest, DEFAULT_UA } from './util.js';

/**
 * 取回 .torrent 原始字节：带登录 jar，并处理站点前置 JS Cookie 校验页
 * （HTML 里嵌 `document.cookie="k=v;"`，按脚本写入 Cookie 后再取一次）。
 *
 * 返回 Buffer；调用方自行校验是否为合法种子（buf[0] === 0x64，即 bencode 的 'd'）。
 * 这是「手动下载」(index.js loadSeed) 与「订阅自动下载」(runner.js magnetFromTorrentUrl)
 * 共用的唯一取种实现，保证两条路径登录态与校验页处理完全一致。
 *
 * @param {string} url  .torrent 下载地址
 * @param {{jar?:any, timeout?:number, fetch?:Function}} [opts]
 *        jar    登录 CookieJar（源A用 sourceA.jar，源B用 sourceBJar）
 *        fetch  仅测试注入用，默认走真实 httpRequest
 * @returns {Promise<Buffer>}
 */
export async function fetchTorrentBytes(url, { jar, timeout = 25000, fetch = httpRequest } = {}) {
  const u = new URL(String(url || ''));
  if (!/^https?:$/.test(u.protocol)) throw new Error('种子地址协议不支持');

  let buf = Buffer.alloc(0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(u.toString(), {
      binary: true,
      headers: { Referer: `${u.origin}/`, 'User-Agent': DEFAULT_UA },
      jar,
      timeout,
    });
    buf = res.buffer || Buffer.alloc(0);
    if (res.status === 200 && buf.length >= 20 && buf[0] === 0x64) break;
    // 站点前置 JS Cookie 校验页：按页面脚本写入 Cookie 再取一次
    const m = buf.subarray(0, 4096).toString('utf8')
      .match(/document\.cookie\s*=\s*"([^=]+)=([^;]+);/);
    if (!m || attempt === 1) break;
    if (jar) jar.set(u.toString(), m[1].trim(), m[2].trim());
  }
  return buf;
}
