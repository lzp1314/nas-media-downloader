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

/**
 * 解析详情接口里的种子/磁力（与网盘是两套数据）。
 * 站点常只给 .torrent 下载地址（down）而不给磁力 zlink；这里补全为绝对地址并打上 torrent 标记，
 * 由下载链路把种子还原成磁力。ecca 与 all_seeds 通常是同一批数据，按 id 去重。
 */
export function parseSeedGroups(d, baseUrl = '') {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const absolute = (u) => {
    const s = String(u || '').trim();
    if (!s || /^https?:\/\//i.test(s)) return s;
    return s.startsWith('/') && base ? base + s : s;
  };
  const seen = new Set();
  const groups = [];
  let seq = 0;
  const push = (group, arr) => {
    if (!Array.isArray(arr) || !arr.length) return;
    const items = [];
    for (const it of arr) {
      seq += 1;
      const magnet = String(it.zlink || it.link || '').trim();
      const down = absolute(it.down);
      const name = String(it.zname || it.name || '').trim();
      const key = `a-seed-${it.id ?? `s${seq}`}`;
      // 条目只要有 id 就算数：站点现在常常只给种子 id，磁力要另外调 recordMagnetView 换
      if (seen.has(key) || !name || (!magnet && !down && !it.id)) continue;
      seen.add(key);
      items.push({
        group,
        name,
        size: String(it.zsize || it.size || '').trim(),
        magnet,
        down,
        torrentUrl: magnet ? '' : down,
        seedId: it.id === undefined || it.id === null ? '' : String(it.id),
        needVip: Number(it.need_vip || 0) === 1,
        kind: magnet ? 'magnet' : down ? 'torrent' : 'seed',
        spec: String(it.zqxd || it.definition_group || group || '').trim(),
        quality: String(it.zqxd || '').trim(),
        hash: extractHash(magnet),
        dedupeKey: key,
        time: String(it.ezt || '').trim(),
        tags: [it.text_html, it.audio_html].filter(Boolean).map((x) => String(x).replace(/<[^>]*>/g, '')),
      });
    }
    if (items.length) groups.push({ group, items });
  };
  for (const [name, arr] of Object.entries(d?.ecca || {})) push(name, arr);
  push('种子 / 磁力', d?.all_seeds);
  return groups;
}

/**
 * 在线种子接口返回结构不固定：可能是数组、{list:[]}、{data:[]}，
 * 也可能是和详情一样的 {ecca, all_seeds}。这里统一成 parseSeedGroups 认识的形状。
 */
export function pickSeedBuckets(json) {
  const d = json?.data ?? json;
  if (Array.isArray(d)) return { all_seeds: d };
  if (!d || typeof d !== 'object') return null;
  if (d.ecca && typeof d.ecca === 'object' && !Array.isArray(d.ecca)) return d;
  if (Array.isArray(d.all_seeds)) return d;
  for (const key of ['list', 'data', 'seeds', 'items', 'rows']) {
    if (Array.isArray(d[key])) return { all_seeds: d[key] };
  }
  return null;
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

  /**
   * 站点对「没有有效登录态」的请求只给种子数字（znum）、不给明细。
   * 登录且是会员时仍为空，就再试一次在线种子接口；拿不到也不报错，交给上层提示。
   */
  async seedFallback(id, idcode) {
    if (!this.token()) return [];
    const bodies = [{ movice_id: id }, { id }];
    if (idcode) bodies.push({ vid: String(idcode) });
    for (const body of bodies) {
      try {
        const json = await this.request('onlineseed', { method: 'POST', body });
        const buckets = pickSeedBuckets(json);
        if (!buckets) continue;
        const groups = parseSeedGroups(buckets, this.base);
        if (groups.length) return groups;
      } catch {
        // 接口不存在或未登录：继续试下一种参数，最后交给上层提示
      }
    }
    return [];
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
    let groups = parseSeedGroups(d, this.base);
    const wp = parseWpGroups(d);
    for (const g of wp.groups) groups.push(g);

    const seedCount = Number(d.znum || 0);
    const seedGot = groups.filter((g) => g.items.some((x) => x.kind === 'magnet' || x.kind === 'torrent')).length;
    // 站点声明有种子但一条明细都没给：补一次兜底，仍为空则由前端说明原因
    if (!seedGot && seedCount > 0) {
      const extra = await this.seedFallback(d.id || id, d.idcode);
      if (extra.length) groups = [...extra, ...groups];
    }

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
      seedCount,
      needLogin: Number(d.need_login || 0) === 1 || (groups.length === 0 && seedCount > 0),
      wp: { total: wp.total, locked: wp.locked, needWpVip: wp.needWpVip },
      groups,
    };
  }

  async captcha() {
    const json = await this.request('getCaptcha');
    if (json.code !== 200 || !json.data) throw new Error(json.message || '验证码获取失败');
    return { img: json.data.img, key: json.data.key };
  }

  /**
   * 登录态自检：光看有没有 token 不算数，站点那边可能已经失效。
   * 结果缓存 60 秒，避免每开一次面板就打一次账户接口。
   */
  async status({ fresh = false } = {}) {
    const cached = this._status;
    if (!fresh && cached && Date.now() - cached.at < 60000) return cached.value;
    const hasToken = Boolean(this.token());
    let value = { hasToken, valid: false, vip: false, user: null, reason: hasToken ? 'unknown' : 'none', message: '' };
    if (hasToken) {
      try {
        const me = await this.me();
        value = {
          hasToken: true,
          valid: Boolean(me),
          vip: Boolean(me?.vip),
          user: me,
          reason: me ? 'ok' : 'unknown',
          message: '',
        };
      } catch (err) {
        const msg = String(err?.message || '');
        value = {
          hasToken: true,
          valid: false,
          vip: false,
          user: null,
          reason: /失效|过期|重新登录|10103/.test(msg) ? 'expired' : 'error',
          message: msg.slice(0, 60),
        };
      }
    }
    this._status = { at: Date.now(), value };
    return value;
  }

  /** 站点详情不给 zlink 时，按种子 id 单独换磁力；未登录会回「请登录后查看磁力」 */
  async magnet(seedId) {
    const id = String(seedId || '').trim();
    if (!id) throw new Error('缺少种子 id');
    const json = await this.request('recordMagnetView', { method: 'POST', body: { id } });
    if (json.code !== 200) {
      const err = new Error(json.message || '磁力获取失败');
      err.needLogin = /登录/.test(String(json.message || ''));
      err.needVip = /VIP|会员/i.test(String(json.message || ''));
      throw err;
    }
    const link = String(json.data?.zlink || json.data?.href || '').trim();
    if (!/^magnet:/i.test(link)) throw new Error('站点没有返回磁力链接');
    return link;
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
    this._status = null;
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
    this._status = null;
    this.jar.clear();
  }
}

export const sourceA = new SourceA();
export { DEFAULT_UA };
