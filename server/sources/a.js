import { CookieJar, httpRequest, DEFAULT_UA, extractHash } from '../lib/util.js';
import { loadSettings, saveSettings } from '../settings.js';
import { requireA } from './config.js';

/**
 * 资源库 A 客户端（需要账号的索引站）
 * - 站点前置了 JS Cookie 校验（ge_js_validator_*），这里做自动化握手
 * - 搜索走 getVideoList，详情走 getVideoDetail
 * - 磁力列表需登录（部分资源需会员），token 保存在设置里
 * - 站点地址全部来自 sites.json，代码里不写死
 */
/**
 * 解析详情接口里的网盘资源（与种子是两套数据）。
 * 站点把网盘按类型分组放在 movies_online_seed，中文名在 movies_online_seed_type；
 * 未登录/非会员时大部分条目的 link 为空，这些条目仍然列出并标记「需会员取链接」。
 */
export function parseWpGroups(d) {
  const labels = {};
  for (const t of Array.isArray(d?.movies_online_seed_type) ? d.movies_online_seed_type : []) {
    if (t && t.value) labels[String(t.value)] = String(t.label || t.value);
  }
  const groups = [];
  let total = 0;
  let locked = 0;
  let seq = 0;
  for (const [key, arr] of Object.entries(d?.movies_online_seed || {})) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const label = labels[key] || key;
    const items = arr
      .map((raw) => {
        seq += 1;
        const url = String(raw.link || raw.url || '').trim();
        const isLocked = !url;
        total += 1;
        if (isLocked) locked += 1;
        return {
          group: label,
          name: String(raw.seed_name || raw.name || '').trim(),
          size: '',
          magnet: '',
          url,
          panKey: key,
          panName: label,
          typeName: label,
          kind: 'pan',
          locked: isLocked,
          code: String(raw.code || '').trim(),
          by: String(raw.nickname || '').trim(),
          time: String(raw.created_at || '').trim(),
          dedupeKey: `a-wp-${raw.id ?? seq}`,
        };
      })
      .filter((it) => it.name || it.url);
    if (items.length) groups.push({ group: label, items });
  }
  return { groups, total, locked, needWpVip: Number(d?.need_wp_vip || 0) === 1 };
}

export class SourceA {
  constructor() {
    this.jar = new CookieJar();
  }

  cfg() {
    return loadSettings().a;
  }

  get base() {
    return requireA().baseUrl;
  }

  token() {
    return this.cfg().token || '';
  }

  /** 逐个候选域名尝试，首个成功即锁定 */
  candidates() {
    const a = requireA();
    return [...new Set([a.baseUrl, ...(a.mirrors || [])].filter(Boolean).map((u) => u.replace(/\/+$/, '')))];
  }

  async #raw(base, path, { method = 'GET', params, body } = {}) {
    const conf = requireA();
    const url = new URL(`${base}/prod/api/v1/${path}`);
    url.searchParams.set('app_id', conf.appId);
    url.searchParams.set('identity', conf.identity);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    const headers = {
      Accept: 'application/json, text/plain, */*',
      Referer: `${base}/`,
      Origin: base,
    };
    const t = this.token();
    if (t) {
      url.searchParams.set('access_token', t);
      headers.Authorization = `Bearer ${t}`;
    }
    if (body) headers['Content-Type'] = 'application/json;charset=UTF-8';

    let text = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await httpRequest(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        jar: this.jar,
        timeout: 30000,
      });
      text = res.text;
      // 命中 JS 校验页：写入 Cookie 后重试
      const m = text.match(/document\.cookie\s*=\s*"([^=]+)=([^;]+);/);
      if (m) {
        this.jar.set(url.toString(), m[1].trim(), m[2].trim());
        continue;
      }
      break;
    }
    return text;
  }

  async request(path, opts) {
    let lastErr = null;
    for (const base of this.candidates()) {
      try {
        const text = await this.#raw(base, path, opts);
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          lastErr = new Error(`${base} 返回非 JSON：${text.slice(0, 120)}`);
          continue;
        }
        if (json.code === 10103) {
          lastErr = new Error('登录已失效，请重新登录');
          lastErr.code = 10103;
          continue;
        }
        return json;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('片源不可达');
  }

  async search({ keyword, scope = 'all', page = 1, limit = 24 }) {
    const json = await this.request('getVideoList', {
      params: { sb: keyword, sk: scope, page, limit },
    });
    if (!json.success) {
      const err = new Error(json.message || '搜索失败');
      err.needVip = /VIP/i.test(json.message || '');
      throw err;
    }
    const payload = json.data || {};
    const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.list) ? payload.list : [];
    const base = this.base;
    return {
      total: Number(payload.total || payload.count || list.length) || list.length,
      page: Number(payload.page || page) || page,
      items: list.map((it) => ({
        source: 'a',
        id: String(it.id),
        title: it.title || '',
        image: it.image || '',
        year: it.years || '',
        score: it.doub_score || it.IMDB_score || '',
        quality: it.quality || '',
        tags: [it.class, it.production_area].filter(Boolean).join(' · '),
        desc: it.otitle || it.alias || '',
        episodes: it.episodes && it.episodes !== '0' ? `${it.episodes} 集` : '',
        type: Number(it.type) === 1 ? 'movie' : 'tv',
        link: it.idcode ? `${base}/mv/${it.id}` : '',
      })),
    };
  }

  /** 详情：返回资源列表（磁力/网盘），未登录时列表为空但会给出提示 */
  async detail(id) {
    const json = await this.request('getVideoDetail', { params: { id } });
    if (!json.success) {
      const err = new Error(json.message || '获取详情失败');
      err.needVip = /VIP/i.test(json.message || '');
      throw err;
    }
    const d = json.data || {};
    const groups = [];
    const push = (group, arr) => {
      if (!Array.isArray(arr) || arr.length === 0) return;
      const items = arr
        .map((it) => ({
          group,
          name: it.zname || it.name || '',
          size: it.zsize || it.size || '',
          magnet: it.zlink || it.link || '',
          down: it.down || '',
          time: it.ezt || '',
          quality: it.zqxd || '',
          hash: extractHash(it.zlink || it.link || ''),
          tags: [it.text_html, it.audio_html].filter(Boolean).map((x) => String(x).replace(/<[^>]*>/g, '')),
        }))
        .filter((it) => it.magnet || it.down);
      if (items.length) groups.push({ group, items });
    };

    const ecca = d.ecca || {};
    for (const [name, arr] of Object.entries(ecca)) push(name, arr);
    push('种子 / 磁力', d.all_seeds);
    const wp = parseWpGroups(d);
    for (const g of wp.groups) groups.push(g);

    return {
      source: 'a',
      id: String(d.id || id),
      title: d.title || '',
      image: d.image || '',
      year: d.years || '',
      score: d.doub_score || '',
      meta: {
        导演: d.director || '',
        主演: d.performer || '',
        类型: d.class || '',
        地区: d.production_area || '',
        片长: d.long_time || '',
        上映: d.release || '',
        简介: d.abstract || '',
      },
      seedCount: Number(d.znum || 0),
      needLogin: groups.length === 0 && Number(d.znum || 0) > 0,
      wp: { total: wp.total, locked: wp.locked, needWpVip: wp.needWpVip },
      groups,
    };
  }

  async captcha() {
    const json = await this.request('getCaptcha');
    if (json.code !== 200 || !json.data) throw new Error(json.message || '验证码获取失败');
    return { img: json.data.img, key: json.data.key };
  }

  async login({ username, password, code, key }) {
    const json = await this.request('login', {
      method: 'POST',
      body: { username, password, code, key },
    });
    if (json.code !== 200 || !json.data?.access_token) {
      throw new Error(json.message || '用户名或密码错误');
    }
    const token = json.data.access_token;
    saveSettings({ a: { token, tokenAt: Date.now(), username } });
    const me = await this.me().catch(() => null);
    return { token, user: me };
  }

  async me() {
    if (!this.token()) return null;
    const json = await this.request('getInfo');
    if (!json.success) throw new Error(json.message || '获取账户信息失败');
    const u = json.data || {};
    const brief = {
      username: u.username || u.nickname || '',
      nickname: u.nickname || u.username || '',
      vip: u.vip === 1 || Number(u.is_vip) === 1 || Boolean(u.vip_end && new Date(u.vip_end).getTime() > Date.now()),
      vipEnd: u.vip_end || u.vip_time || '',
    };
    saveSettings({ a: { user: brief } });
    return brief;
  }

  logout() {
    saveSettings({ a: { token: '', tokenAt: 0, user: null, username: '' } });
    this.jar.clear();
  }
}

export const sourceA = new SourceA();
export { DEFAULT_UA };
