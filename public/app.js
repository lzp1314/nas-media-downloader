'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  view: 'search',
  keyword: '',
  scope: 'all',
  source: 'all',
  items: [],
  notes: [],
  meta: null,
  sources: null,
  dirs: null,
  flatDirs: [],
  selectedDir: '',
  dirMode: 'download', // download | sub：同一个目录浏览器，确认按钮的作用不同
  pending: null,
  searchTimer: null,
  searchSeq: 0,
  detailSeq: 0,
  indexTimer: null,
  lastType: '',
  link: null,
  sheetItem: null,
  tmdbTitle: '', // 选中的 TMDB 条目对应的剧名，用来发现「用户改了剧名但没重选条目」
  tmdbType: 'tv', // 选中的 TMDB 条目类型：'tv' 剧集 / 'movie' 电影
  tmdbConfigured: false,
};

/* ---------------- 基础工具 ---------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function friendly(msg) {
  return String(msg || '')
    .replace(/fetch failed|Failed to fetch/i, '下载引擎未就绪，请重启容器并查看日志')
    .replace(/ECONNREFUSED|UND_ERR_CONNECT_REFUSED/i, '下载引擎未启动')
    .replace(/Load failed|NetworkError|network error/i, '无法连接服务，请确认容器正在运行')
    .replace(/请求失败 504|Gateway Timeout/i, '等待超时，请重新点「解析」再试一次');
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch {
    throw new Error('无法连接服务，请确认容器正在运行');
  }
  if (res.status === 401) {
    const d = await res.json().catch(() => ({}));
    if (d.needLogin) {
      location.href = '/login';
      throw new Error('未登录');
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendly(data.error || `请求失败 ${res.status}`));
  return data;
}

function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = isErr ? friendly(msg) : msg;
  el.className = `toast on${isErr ? ' err' : ''}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = 'toast'), 2800);
}

/**
 * 复制到剪贴板。
 *
 * 浏览器只允许安全上下文（https / localhost）用 navigator.clipboard；
 * 本程序多数是 http://内网IP:9696 打开，那里 clipboard 直接是 undefined，
 * 所以必须留一条 execCommand 的老路，否则一点就只弹「复制失败」。
 */
async function copyText(text) {
  const s = String(text || '');
  if (!s) return false;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch {
      /* 权限被拒或 iframe 限制，落到下面 */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = s;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, s.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/** 自动复制被拦住时，把链接摊在屏幕下方让用户手动选中 */
function showCopyBox(text) {
  const old = document.querySelector('.copybox');
  if (old) old.remove();
  const box = document.createElement('div');
  box.className = 'copybox';
  box.innerHTML = `<input class="copybox-input" readonly value="${esc(text)}" />
    <button class="btn ghost sm" type="button">关闭</button>`;
  document.body.appendChild(box);
  const input = box.querySelector('input');
  input.focus();
  input.select();
  box.querySelector('button').addEventListener('click', () => box.remove());
  setTimeout(() => box.remove(), 20000);
}

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(v) / Math.log(1024)), u.length - 1);
  return `${(v / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
const fmtSpeed = (n) => `${fmtSize(n)}/s`;
function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分 ${Math.floor(sec % 60)} 秒`;
}

/* ---------------- 视图切换 ---------------- */
function switchView(v) {
  state.view = v;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('on', el.id === `view-${v}`));
  // 设置页不显示全局搜索框；其它页保留
  $('searchWrap').hidden = v === 'settings';
  document.querySelector('.tabs').style.marginLeft = v === 'settings' ? 'auto' : '';
  if (v === 'tasks') loadTasks();
  if (v === 'sub') loadSubs();
  if (v === 'settings') loadSettingsView();
  if (location.hash !== `#${v}`) history.replaceState(null, '', `#${v}`);
  if (v === 'search') $('kw').focus();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

/* ---------------- 搜索 ---------------- */
const kwEl = $('kw');

// 在任务页点搜索框时自动回到搜索页，避免看起来「点了没反应」
const backToSearch = () => {
  if (state.view !== 'search' && !$('searchWrap').hidden) switchView('search');
};
kwEl.addEventListener('focus', backToSearch);
kwEl.addEventListener('pointerdown', backToSearch);
$('searchWrap').addEventListener('click', () => {
  if (state.view !== 'search') switchView('search');
  else kwEl.focus();
});

kwEl.addEventListener('input', () => {
  const v = kwEl.value.trim();
  $('btnClear').hidden = !v;
  clearTimeout(state.searchTimer);
  if (!v) {
    state.searchSeq += 1;
    showHero(true);
    $('results').innerHTML = '';
    $('resultbar').hidden = true;
    $('notebar').hidden = true;
    showState(false);
    return;
  }
  state.searchTimer = setTimeout(doSearch, 520);
});

kwEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(state.searchTimer);
    doSearch();
  }
  if (e.key === 'Escape') {
    kwEl.value = '';
    kwEl.dispatchEvent(new Event('input'));
  }
});

$('btnClear').addEventListener('click', () => {
  kwEl.value = '';
  kwEl.dispatchEvent(new Event('input'));
  kwEl.focus();
});
$('btnSearch').addEventListener('click', () => {
  clearTimeout(state.searchTimer);
  doSearch();
});

/* ---------------- 首页热播推荐 ---------------- */
function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return '刚刚更新';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function renderHot(data) {
  const wrap = $('hotWrap');
  const groups = (data?.groups || []).filter((g) => g.items && g.items.length);
  if (!groups.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  $('hotTime').textContent = data.fallback
    ? '暂时用收藏片单'
    : `${fmtAgo(data.updatedAt)}${data.stale ? ' · 暂用上次' : ''}`;
  $('hotGroups').innerHTML = groups
    .map(
      (g) => `<div class="hot-group" data-key="${esc(g.key)}">
        <span class="hot-group-label">${esc(g.label)}</span>
        <div class="hot-chips">${g.items
          .map((q) => `<button type="button" data-q="${esc(q)}" title="搜索「${esc(q)}」">${esc(q)}</button>`)
          .join('')}</div>
      </div>`,
    )
    .join('');
}

async function loadHot(refresh = false) {
  const btn = $('btnHotRefresh');
  if (refresh) {
    btn.disabled = true;
    btn.textContent = '更新中…';
  }
  try {
    const r = await api(`/api/hot${refresh ? '?refresh=1' : ''}`);
    renderHot(r);
    if (refresh) toast(r.stale ? '暂时没取到新数据，已保留上次的' : '已更新');
  } catch {
    $('hotWrap').hidden = true; // 推荐区是锦上添花，取不到就不显示，不影响搜索
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新';
  }
}

$('hotGroups').addEventListener('click', (e) => {
  const b = e.target.closest('[data-q]');
  if (!b) return;
  kwEl.value = b.dataset.q;
  $('btnClear').hidden = false;
  doSearch();
});
$('btnHotRefresh').addEventListener('click', () => loadHot(true));

document.querySelectorAll('#scopeChips .chip').forEach((c) =>
  c.addEventListener('click', () => {
    document.querySelectorAll('#scopeChips .chip').forEach((x) => x.classList.toggle('on', x === c));
    state.scope = c.dataset.scope;
    if (state.keyword) doSearch();
  }),
);

document.querySelectorAll('#sourceChips .chip').forEach((c) =>
  c.addEventListener('click', () => {
    document.querySelectorAll('#sourceChips .chip').forEach((x) => x.classList.toggle('on', x === c));
    state.source = c.dataset.source;
    if (state.keyword) doSearch();
  }),
);

/** 来源按钮上的小圆点：未接入的来源置灰并给出说明，方便直观挑选 */
function renderSourceState() {
  const s = state.sources;
  if (!s) return;
  document.querySelectorAll('#sourceChips .chip').forEach((c) => {
    const k = c.dataset.source;
    if (k === 'all') return;
    c.classList.toggle('off', !s[k]);
    c.title = s[k] ? '已接入' : '尚未接入，可到设置里配置';
  });
}

function showHero(show) {
  $('hero').hidden = !show;
}

function showState(show, msg = '', spinning = true) {
  const box = $('stateBox');
  box.hidden = !show;
  if (!show) return;
  $('stateSpin').hidden = !spinning;
  $('stateMsg').innerHTML = msg;
}

async function doSearch() {
  const kw = kwEl.value.trim();
  if (!kw) return;
  state.keyword = kw;
  showHero(false);
  $('resultbar').hidden = false;
  $('notebar').hidden = true;
  $('results').innerHTML = '';
  $('counter').textContent = '';
  showState(true, `正在搜索「${esc(kw)}」…`, true);

  const seq = ++state.searchSeq;
  try {
    const data = await api('/api/search', {
      method: 'POST',
      body: JSON.stringify({ keyword: kw, scope: state.scope, source: state.source }),
    });
    if (seq !== state.searchSeq) return;
    state.items = data.items || [];
    state.notes = data.notes || [];
    renderResults();
  } catch (err) {
    if (seq !== state.searchSeq) return;
    showState(true, `搜索失败：${esc(friendly(err.message))}`, false);
  }
}

function posterHtml(item, big = false) {
  const ch = esc(String(item.title || '?').trim().slice(0, 1));
  if (item.image) {
    return `<img src="${esc(item.image)}" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph',textContent:'${ch}'}))" />`;
  }
  return `<span class="ph">${ch}</span>`;
}

/** 把 "1080P蓝光/其他" 这类粘连串拆成干净标签 */
function qualityTags(q, max = 3) {
  const parts = String(q || '')
    .replace(/([0-9a-z])([\u4e00-\u9fff])/gi, '$1 $2')
    .split(/[,，/|·、\s]+/)
    .map((x) => x.trim())
    .filter((x) => x && !/^(其他|未知|无|集|话)$/.test(x) && !/^\d+$/.test(x));
  const out = [];
  for (const p of parts) if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  // "WEB-1080P" 已经包含 "1080P" 时，去掉重复的短标签
  const trimmed = out.filter(
    (t) => !out.some((o) => o !== t && o.toLowerCase().length > t.toLowerCase().length && o.toLowerCase().includes(t.toLowerCase())),
  );
  return (trimmed.length ? trimmed : out).slice(0, max);
}

function renderResults() {
  const items = state.items;
  $('counter').textContent = items.length
    ? `共 ${items.length} 部影片${state.notes.length ? '，部分来源未响应' : ''}`
    : '';

  if (state.notes.length) {
    $('notebar').hidden = false;
    $('notebar').innerHTML = state.notes.map((n) => esc(n)).join('<br />');
  } else {
    $('notebar').hidden = true;
  }

  if (!items.length) {
    const unconfigured = state.notes.some((n) => n.includes('未接入'));
    showState(
      true,
      unconfigured
        ? `片源还没有接入<br /><small>按上方提示填好 <code>config/sites.json</code>，重启容器后再搜</small>`
        : `没搜到「${esc(state.keyword)}」<br /><small>换个片名试试，或到设置里同步一下资源库 B</small>`,
      false,
    );
    $('results').innerHTML = '';
    return;
  }
  showState(false);

  $('results').innerHTML = items
    .map((it, i) => {
      const srcBadges = (it.sources || [])
        .map((s) => {
          if (s === 'm') {
            // 磁力是多个源汇总的，直接写出是哪几个源搜到的（用户自己起的名字）
            const names = (it.mSources || []).filter(Boolean);
            const shown = names.length > 2 ? `${names.slice(0, 2).join(' / ')} 等 ${names.length} 个` : names.join(' / ');
            const label = names.length ? `磁力 · ${shown}` : '磁力搜索';
            return `<span class="src src-m" title="${esc(names.join(' / '))}">${esc(label)}</span>`;
          }
          return `<span class="src src-${esc(s)}">${({ a: '源 A', b: '源 B' })[s] || esc(s)}</span>`;
        })
        .join('');
      const qTags = qualityTags(it.quality)
        .map((x) => `<span class="tag hot">${esc(x)}</span>`)
        .join('');
      const year = it.year ? `<span class="yr">${esc(it.year)}</span>` : '';
      const sub = [it.tags, it.score ? `评分 ${it.score}` : ''].filter(Boolean).join(' · ');
      return `<article class="item" data-i="${i}">
        <div class="poster">${posterHtml(it)}</div>
        <div class="body">
          <h3>${esc(it.title)}${year}</h3>
          <div class="line">${srcBadges}${qTags}${it.type === 'tv' ? '<span class="tag">剧集</span>' : ''}</div>
          ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
        </div>
        <div class="right"><span class="arrow">›</span></div>
      </article>`;
    })
    .join('');

  $('results')
    .querySelectorAll('.item')
    .forEach((el) => el.addEventListener('click', () => openSheet(state.items[Number(el.dataset.i)])));
}

/* ---------------- 资源面板 ---------------- */
$('sClose').addEventListener('click', closeSheet);
$('sheetMask').addEventListener('click', closeSheet);

function closeSheet() {
  $('sheet').classList.remove('on');
  $('sheetMask').classList.remove('on');
}

async function openSheet(item) {
  if (!item) return;
  state.sheetItem = item;
  const seq = ++state.detailSeq;
  state.lastType = item.type || '';
  $('sTitle').textContent = item.title;
  $('sMeta').innerHTML = [
    item.year ? `<span class="tag">${esc(item.year)}</span>` : '',
    qualityTags(item.quality, 1)[0] ? `<span class="tag hot">${esc(qualityTags(item.quality, 1)[0])}</span>` : '',
    item.tags ? esc(item.tags) : '',
  ]
    .filter(Boolean)
    .join(' ');
  $('sPoster').innerHTML = posterHtml(item, true);
  $('sBody').innerHTML = `<div class="state"><div class="state-inner"><div class="spinner"></div>正在解析磁力与种子资源…</div></div>`;
  $('sheet').classList.add('on');
  $('sheetMask').classList.add('on');

  try {
    const data = await api('/api/resolve', {
      method: 'POST',
      body: JSON.stringify({ variants: item.variants, title: item.title }),
    });
    if (seq !== state.detailSeq) return;
    renderResources(data, item);
  } catch (err) {
    if (seq !== state.detailSeq) return;
    $('sBody').innerHTML = `<div class="state"><div class="state-inner">解析失败：${esc(err.message)}</div></div>`;
  }
}

function renderResources(data, item) {
  // 搜索结果没给海报时，详情接口可能补到了（源 B 的结果页偶尔没图）：
  // 顺手把抽屉和列表里那张卡的占位字一起换成真海报
  if (data.image && !item.image) {
    item.image = data.image;
    $('sPoster').innerHTML = posterHtml(item, true);
    const idx = state.items.indexOf(item);
    if (idx >= 0) {
      const card = $('results').querySelector(`.item[data-i="${idx}"] .poster`);
      if (card) card.innerHTML = posterHtml(item);
    }
  }
  const metaBits = Object.entries(data.meta || {})
    .filter(([k, v]) => v && String(v).trim().length > 0 && String(v).trim() !== '·' && String(v).length < 40)
    .slice(0, 4)
    .map(([k, v]) => `${esc(k)}：${esc(String(v).trim())}`);
  if (metaBits.length) {
    $('sMeta').innerHTML = metaBits.join('　·　');
  }

  // 登录态文案：空结果和"有种子没明细"两处都要用，先算出来
  const login = data.login || null;
  const loginText = (() => {
    const r = login?.reason || '';
    if (r === 'none') return '站点要求登录后才下发种子明细，这里还没登录源 A 账号';
    if (r === 'expired') return '源 A 登录状态已失效，重新登录即可恢复';
    if (r === 'error') return `源 A 账号校验没通过${login.message ? `（${login.message}）` : ''}`;
    if (r === 'ok') return `源 A 已登录（${login.vip ? '会员' : '普通用户'}），站点这次没下发，稍后重开本面板可再试`;
    return '登录源 A 账号后重开本面板即可';
  })();
  const notes = (data.notes || []).filter(Boolean);

  if (!data.total) {
    const needLogin = data.needLogin;
    const seedMiss = Boolean(data.seedExpect);
    // 一条资源都没有时也要把「为什么没有」说清楚：
    // 是站点要登录、还是要登录但没登录上、又或者只是这次没下发
    const tip = needLogin
      ? '这个片源要登录后才返回资源列表'
      : seedMiss
        ? `站点有 ${data.seedExpect} 个种子，这次没有下发明细<br /><span class="res-empty-sub">${esc(loginText)}</span>`
        : esc(notes.join('　')) || '没有解析到可用资源，换个片名或稍后再试';
    const canLogin = needLogin || (seedMiss && login?.reason !== 'ok');
    // 其余片源的报错照旧列出，别被种子提示盖掉
    const rest = seedMiss ? notes.filter((n) => !/个种子/.test(n)) : [];
    $('sBody').innerHTML = `<div class="state">
      <div class="state-inner">
        <div class="empty-ico">${needLogin || seedMiss ? '🔒' : '🕳'}</div>
        <div class="state-msg" style="margin-bottom:14px">${tip}</div>
        ${rest.length ? `<div class="notebar" style="margin-bottom:12px;text-align:left">${rest.map(esc).join('<br />')}</div>` : ''}
        ${canLogin
          ? `<button class="btn primary sm" id="goLogin">${login?.reason === 'expired' ? '重新登录源 A' : '登录源 A'}</button>`
          : '<button class="btn ghost sm" id="retryResolve">重试</button>'}
      </div>
    </div>`;
    const goLogin = $('goLogin');
    if (goLogin) goLogin.addEventListener('click', () => openALogin(() => openSheet(item)));
    const retry = $('retryResolve');
    if (retry) retry.addEventListener('click', () => openSheet(item));
    return;
  }

  // 只展示种子 / 磁力，按规格（WEB-4K / 1080P…）分桶
  const rows = data.groups.flatMap((g) => (g.items || []).map((it) => ({ ...it })));
  // kind=seed 表示站点只给了种子 id，磁力要另外换，也属于这一档
  const isSeedRow = (it) => Boolean(it.magnet || it.torrentUrl || it.kind === 'torrent' || it.kind === 'seed' || it.seedId);
  const seedRows = rows.filter(isSeedRow);

  const bucketize = (list, pick) => {
    const order = [];
    const map = new Map();
    for (const it of list) {
      const key = String(pick(it) || '').trim() || '其他';
      if (!map.has(key)) {
        map.set(key, []);
        order.push(key);
      }
      map.get(key).push(it);
    }
    return order.map((label) => ({ label, items: map.get(label) }));
  };

  const seedBuckets = bucketize(seedRows, (it) => it.spec || it.quality);

  const rowHtml = (it) => {
    const extra = it.locked ? '<span class="lock">需会员取链接</span>' : '';
    const seedAttr = it.torrentUrl ? ` data-torrent="${esc(it.torrentUrl)}"` : '';
    const dlVal = esc(it.magnet || it.torrentUrl || '');
    const seedIdAttr = !it.magnet && !it.torrentUrl && it.seedId ? ` data-seedid="${esc(it.seedId)}"` : '';
    // 磁力或 .torrent 都能看目录选集；只有种子 id 的先换磁力
    const acts = `<div class="res-acts">
          <button class="btn ghost sm" data-files="${dlVal}"${seedAttr}${seedIdAttr} data-name="${esc(it.name)}">选集</button>
          <button class="btn primary sm" data-dl="${dlVal}"${seedAttr}${seedIdAttr} data-name="${esc(it.name)}">下载</button>
        </div>`;
    const rowSpec = it.spec || it.quality || '其他';
    return `<div class="res${it.locked ? ' locked' : ''}" data-rk="seed" data-spec="${esc(rowSpec)}">
      <div class="res-main">
        <div class="res-name">${esc(it.name)}</div>
        <div class="res-meta">
          <span class="sz">${esc(it.size || '大小未知')}</span>
          <span class="src">${esc(it.sourceLabel)}</span>
          <span class="kind seed">${it.magnet ? '磁力' : '种子'}</span>
          ${extra}
        </div>
      </div>
      ${acts}
    </div>`;
  };

  const blockHtml = (kind, buckets, emptyTip, raw = false) => {
    if (!buckets.length) {
      const tip = raw ? emptyTip : esc(emptyTip);
      return `<div class="res-block" data-block="${kind}" hidden><div class="res-empty">${tip}</div></div>`;
    }
    const list = buckets
      .map(
        (b) => `<div class="qgroup">
        <div class="qtitle"><b>${esc(b.label)}</b><span class="qcount">${b.items.length} 个</span></div>
        ${b.items.map(rowHtml).join('')}
      </div>`,
      )
      .join('');
    return `<div class="res-block" data-block="${kind}" hidden>${list}</div>`;
  };

  const canSignIn = !seedRows.length && Boolean(data.seedExpect) && login?.reason !== 'ok';
  const seedTip = data.seedExpect
    ? `<div>站点有 ${data.seedExpect} 个种子，这次没有下发明细</div>` +
      `<div class="res-empty-sub">${esc(loginText)}</div>` +
      (canSignIn
        ? `<button class="btn primary sm" id="seedLogin" type="button">${login?.reason === 'expired' ? '重新登录源 A' : '登录源 A'}</button>`
        : '<button class="btn ghost sm" id="seedRetry" type="button">再试一次</button>')
    : '这个片源没有种子资源';
  $('sBody').innerHTML =
    `<div class="status" style="margin:10px 0 2px">${seedRows.length} 个种子 / 磁力</div>` +
    `<div class="res-filter">
      <div class="res-tabs">
        <button class="res-tab active" data-rk="seed" type="button">⬇ 种子 / 磁力 <i>${seedRows.length}</i></button>
      </div>
      <div class="res-chips" id="resChips"></div>
    </div>` +
    `<div class="sheet-tools"><button class="btn ghost sm" id="sheetLinkPaste">🔗 粘贴磁力链接选集</button></div>` +
    blockHtml('seed', seedBuckets, seedTip, true) +
    (notes.length ? `<div class="notebar" style="margin-top:12px">${notes.map(esc).join('<br />')}</div>` : '');

  // 只按规格筛种子；只隐藏已渲染的行，不重新请求
  let curSpec = '全部';
  const applyResFilter = () => {
    const block = $('sBody').querySelector('.res-block[data-block="seed"]');
    if (block) {
      block.hidden = false;
      block.querySelectorAll('.res').forEach((row) => {
        row.hidden = !(curSpec === '全部' || row.dataset.spec === curSpec);
      });
      block.querySelectorAll('.qgroup').forEach((g) => {
        const n = g.querySelectorAll('.res:not([hidden])').length;
        g.hidden = n === 0;
        const c = g.querySelector('.qcount');
        if (c) c.textContent = `${n} 个`;
      });
    }
    const sum = seedBuckets.reduce((n, b) => n + b.items.length, 0);
    $('resChips').innerHTML =
      `<button class="res-chip${curSpec === '全部' ? ' active' : ''}" data-spec="全部" type="button">全部 <i>${sum}</i></button>` +
      seedBuckets
        .map(
          (b) => `<button class="res-chip${curSpec === b.label ? ' active' : ''}" data-spec="${esc(b.label)}" type="button">${esc(b.label)} <i>${b.items.length}</i></button>`,
        )
        .join('');
  };

  $('sBody').querySelector('.res-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.res-chip');
    if (chip) {
      curSpec = chip.dataset.spec;
      applyResFilter();
    }
  });
  applyResFilter();

  // 只有种子 id 的行：点的时候再去站点换磁力，换不到（未登录/无权限）就引导登录
  const grabMagnet = async (btn) => {
    const id = btn.dataset.seedid;
    if (!id) return btn.dataset.dl || '';
    if (btn.disabled) return '';
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '取磁力…';
    try {
      const r = await api('/api/a/magnet', { method: 'POST', body: JSON.stringify({ id }) });
      return r.magnet || '';
    } catch (e) {
      if (/登录/.test(e.message)) {
        toast('要登录源 A 才能取磁力', true);
        openALogin(() => openSheet(item));
      } else {
        toast(e.message, true);
      }
      return '';
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  $('sBody').querySelectorAll('[data-dl]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      let link = btn.dataset.dl || '';
      if (!link) {
        link = await grabMagnet(btn);
        if (!link) return;
      }
      openDirPicker(link, btn.dataset.name, item.type, { torrentUrl: btn.dataset.torrent || '' });
    }),
  );
  $('sBody').querySelectorAll('[data-files]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      let link = btn.dataset.files || '';
      if (!link) {
        link = await grabMagnet(btn);
        if (!link) return;
      }
      openLinkModal(link, { torrentUrl: btn.dataset.torrent || '', expect: btn.dataset.name || '' });
    }),
  );
  const seedLogin = $('seedLogin');
  if (seedLogin) seedLogin.addEventListener('click', () => openALogin(() => openSheet(item)));
  const seedRetry = $('seedRetry');
  if (seedRetry) seedRetry.addEventListener('click', () => openSheet(item));
  const paste = $('sheetLinkPaste');
  if (paste) paste.addEventListener('click', () => openLinkModal(''));
  $('sBody').querySelectorAll('[data-copy]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const link = btn.dataset.copy || '';
      if (await copyText(link)) {
        // 复制成功后用户去下载器里粘贴即可
        toast('链接已复制，到下载器里粘贴即可');
        return;
      }
      showCopyBox(link);
      toast('浏览器不让自动复制，链接已选中，手动按 Ctrl+C', true);
    }),
  );
}

/* ---------------- 源 A 登录（资源面板里直接登，不用跑去设置页） ---------------- */
let aLoginBack = null;

async function loadACaptcha() {
  const img = $('aCaptchaImg');
  if (!img) return;
  img.removeAttribute('src');
  img.dataset.key = '';
  try {
    const r = await api('/api/a/captcha');
    img.src = r.img;
    img.dataset.key = r.key || '';
  } catch (e) {
    toast(e.message || '验证码加载失败', true);
  }
}

function openALogin(onDone) {
  aLoginBack = typeof onDone === 'function' ? onDone : null;
  $('aLoginUser').value = '';
  $('aLoginPass').value = '';
  $('aLoginCode').value = '';
  $('aLoginNote').textContent = '';
  $('aLoginModal').hidden = false;
  loadACaptcha();
  setTimeout(() => $('aLoginUser').focus(), 60);
}

function closeALogin() {
  $('aLoginModal').hidden = true;
  aLoginBack = null;
}

async function doALogin() {
  const username = $('aLoginUser').value.trim();
  const password = $('aLoginPass').value;
  const code = $('aLoginCode').value.trim();
  const key = $('aCaptchaImg').dataset.key || '';
  if (!username || !password) return toast('请输入账号密码', true);
  const btn = $('aLoginGo');
  btn.disabled = true;
  btn.textContent = '登录中…';
  $('aLoginNote').textContent = '';
  try {
    const r = await api('/api/a/login', { method: 'POST', body: JSON.stringify({ username, password, code, key }) });
    const who = r.user?.nickname || r.user?.username || username;
    toast(`已登录 ${who}${r.user?.vip ? '（会员）' : ''}，正在刷新资源`);
    const back = aLoginBack;
    closeALogin();
    loadSettingsView();
    if (back) back();
  } catch (e) {
    $('aLoginNote').textContent = e.message || '登录失败';
    loadACaptcha();
    $('aLoginCode').value = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

/* ---------------- 链接解析 / 选集 ---------------- */
function openLinkModal(text = '', opts = {}) {
  stopLinkPoll();
  $('linkGo').disabled = false;
  $('linkInput').value = text || '';
  $('linkModal').hidden = false;
  $('linkTools').hidden = true;
  $('linkList').innerHTML = '';
  $('linkStatus').textContent = '';
  $('linkDownload').disabled = true;
  $('linkDownload').textContent = '下载选中';
  $('linkEpFilter').value = '';
  state.link = null;
  // 资源列表里的 .torrent 直链按种子解析；用户手动改了输入框就走链接识别
  state.linkTorrent = opts.torrentUrl || '';
  state.linkOrigin = text || '';
  // 这一行本该是哪部片：解析出来的种子名跟它对不上时提示，避免下错片
  state.linkExpect = opts.expect || '';
  $('linkWarn').hidden = true;
  $('linkWarn').classList.remove('show');
  $('linkWarn').innerHTML = '';
  if (text) doLinkResolve();
  else setTimeout(() => $('linkInput').focus(), 30);
}

function closeLinkModal() {
  stopLinkPoll();
  $('linkGo').disabled = false;
  $('linkModal').hidden = true;
  state.link = null;
}

/* ---------------- 解析任务轮询 ---------------- */
let linkPollTimer = null;

function stopLinkPoll() {
  if (linkPollTimer) {
    clearTimeout(linkPollTimer);
    linkPollTimer = null;
  }
}

/**
 * 片名相似度：只用来判断「这条种子里到底是不是这一部」。
 * 中文按字重合，英文/数字按词重合；任一边字数太少就不下结论（宁可放过，不要误报）。
 */
function titleChars(s) {
  const t = String(s || '').replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）|<[^>]*>/g, ' ');
  return {
    cjk: new Set(t.match(/[\u4e00-\u9fa5]/g) || []),
    word: new Set(t.toLowerCase().match(/[a-z0-9]{2,}/g) || []),
  };
}

function titleSimilar(a, b) {
  const A = titleChars(a);
  const B = titleChars(b);
  if (A.cjk.size >= 3 && B.cjk.size >= 3) {
    const [small, big] = A.cjk.size <= B.cjk.size ? [A.cjk, B.cjk] : [B.cjk, A.cjk];
    let hit = 0;
    for (const c of small) if (big.has(c)) hit += 1;
    return hit / small.size;
  }
  if (A.word.size >= 2 && B.word.size >= 2) {
    const [small, big] = A.word.size <= B.word.size ? [A.word, B.word] : [B.word, A.word];
    let hit = 0;
    for (const w of small) if (big.has(w)) hit += 1;
    return hit / small.size;
  }
  return 1; // 判断不了就当作一致
}

function checkLinkTitle(r) {
  const expect = String(state.linkExpect || '').trim();
  const got = String(r?.title || '').trim();
  const box = $('linkWarn');
  if (!expect || !got || titleSimilar(expect, got) >= 0.5) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.classList.add('show');
  box.innerHTML = `<b>这条种子里不是这一部</b><br />
    名单写的是「${esc(expect)}」，种子里却是「${esc(got)}」。<br />
    多半是站点把种子配错了行，建议返回换一条；确实要下也可以继续。`;
}

function showLinkResult(r) {
  r.selected = new Set();
  state.link = r;
  $('linkStatus').innerHTML = `<b>${esc(r.title)}</b> · 共 ${(r.files || []).length} 个文件` +
    (r.notes?.length ? `<br /><span class="sub">${r.notes.map(esc).join('<br />')}</span>` : '');
  checkLinkTitle(r);
  if (!r.files?.length) {
    $('linkDownload').disabled = true;
    return;
  }
  $('linkTools').hidden = false;
  renderLinkFiles();
}

function failLink(msg) {
  $('linkStatus').innerHTML = `<span class="err">${esc(friendly(msg))}</span>` +
    '<br /><span class="sub">可以点「解析」重试；磁力若一直没做种者，请直接用资源列表里的「下载」整包下</span>';
  $('linkDownload').disabled = true;
  $('linkTools').hidden = true;
  $('linkGo').disabled = false;
}

async function doLinkResolve() {
  const text = $('linkInput').value.trim();
  if (!text) return toast('先粘贴一条链接', true);
  stopLinkPoll();
  const btn = $('linkGo');
  btn.disabled = true;
  $('linkStatus').textContent = '正在提交解析…';
  $('linkTools').hidden = true;
  $('linkList').innerHTML = '';
  $('linkDownload').disabled = true;
  state.link = null;
  try {
    const torrentUrl = state.linkTorrent && text === state.linkOrigin ? state.linkTorrent : '';
    const r = await api('/api/link/resolve', { method: 'POST', body: JSON.stringify({ text, torrentUrl }) });
    if (!r.pending) {
      showLinkResult(r); // 兼容旧版后端
      btn.disabled = false;
      return;
    }
    const tick = async () => {
      let st;
      try {
        st = await api(`/api/link/status?id=${encodeURIComponent(r.jobId)}`);
      } catch (err) {
        failLink(err.message);
        return;
      }
      if (st.state === 'running') {
        $('linkStatus').textContent = `正在读取里面的文件… 已等 ${st.elapsed} 秒（磁力要等做种者提供种子目录，冷门会久一点）`;
        linkPollTimer = setTimeout(tick, 1200);
        return;
      }
      btn.disabled = false;
      if (st.state === 'error') failLink(st.error);
      else showLinkResult(st.result);
    };
    await tick();
  } catch (err) {
    failLink(err.message);
  }
}

function linkFilter() {
  const raw = $('linkEpFilter').value.trim();
  if (!raw) return null;
  const range = raw.match(/^(\d{1,4})\s*[-~至]\s*(\d{1,4})$/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return (ep) => ep !== null && ep !== undefined && ep >= Math.min(lo, hi) && ep <= Math.max(lo, hi);
  }
  if (/^\d{1,4}$/.test(raw)) return (ep) => ep === Number(raw);
  const kw = raw.toLowerCase();
  return (ep, name) => String(name || '').toLowerCase().includes(kw);
}

function visibleLinkFiles() {
  const r = state.link;
  if (!r) return [];
  const f = linkFilter();
  return f ? r.files.filter((x) => f(x.episode, x.name)) : r.files;
}

function renderLinkFiles() {
  const r = state.link;
  if (!r) return;
  const rows = visibleLinkFiles();
  $('linkList').innerHTML = rows.length
    ? rows.map((x) => {
        const on = r.selected.has(x.id);
        const ep = x.episode !== null && x.episode !== undefined ? `<b class="ep">第${x.episode}集</b>` : '';
        return `<label class="link-row${on ? ' on' : ''}">
          <input type="checkbox" data-lid="${esc(x.id)}" ${on ? 'checked' : ''} />
          <span class="ln">${ep}${esc(x.name)}</span>
          <span class="ls">${esc(x.sizeText || (x.size ? fmtSize(x.size) : ''))}</span>
        </label>`;
      }).join('')
    : '<div class="status">没有匹配的文件，换个集数或关键词试试</div>';

  $('linkList').querySelectorAll('[data-lid]').forEach((box) =>
    box.addEventListener('change', () => {
      if (box.checked) r.selected.add(box.dataset.lid);
      else r.selected.delete(box.dataset.lid);
      box.closest('.link-row')?.classList.toggle('on', box.checked);
      updateLinkCount();
    }),
  );
  updateLinkCount();
}

function updateLinkCount() {
  const n = state.link?.selected?.size || 0;
  $('linkCount').textContent = `已选 ${n} 个`;
  $('linkDownload').disabled = n === 0;
  $('linkDownload').textContent = n ? `下载选中 ${n} 个` : '下载选中';
}

$('btnLinkMode').addEventListener('click', () => openLinkModal(''));
$('linkClose').addEventListener('click', closeLinkModal);
$('linkCancel').addEventListener('click', closeLinkModal);
$('linkModal').addEventListener('click', (e) => {
  if (e.target === $('linkModal')) closeLinkModal();
});
$('linkGo').addEventListener('click', doLinkResolve);
$('linkInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLinkResolve();
});
$('linkEpFilter').addEventListener('input', renderLinkFiles);
$('linkAll').addEventListener('click', () => {
  const r = state.link;
  if (!r) return;
  const rows = visibleLinkFiles();
  const allOn = rows.length > 0 && rows.every((x) => r.selected.has(x.id));
  for (const x of rows) {
    if (allOn) r.selected.delete(x.id);
    else r.selected.add(x.id);
  }
  renderLinkFiles();
});
$('linkVideo').addEventListener('click', () => {
  const r = state.link;
  if (!r) return;
  for (const x of visibleLinkFiles()) {
    if (x.video) r.selected.add(x.id);
    else r.selected.delete(x.id);
  }
  renderLinkFiles();
});
$('linkDownload').addEventListener('click', () => {
  const r = state.link;
  if (!r || !r.selected.size) return;
  const ids = [...r.selected];
  const name = r.title || `选中的 ${ids.length} 个文件`;
  closeLinkModal();
  openDirPicker('', name, state.lastType || '', { rid: r.rid, ids, count: ids.length, kind: r.kind });
});

/* ---------------- 目录选择 ---------------- */
async function openDirPicker(magnet, name, type, extra = {}) {
  state.pending = { magnet, name, ...extra };
  state.dirMode = 'download';
  $('newSub').value = '';
  if (!state.dirs) await loadDirs();
  buildFlatDirs();
  state.selectedDir = pickDirFor(type, name || '');
  renderDirDialog();
  $('dirModal').hidden = false;
}

function buildFlatDirs() {
  const out = [];
  const walk = (n, depth, parent) => {
    out.push({ path: n.path, label: n.label, depth, parent });
    (n.dirs || []).forEach((c) => walk(c, depth + 1, n.path));
  };
  (state.dirs?.roots || []).forEach((r) => walk(r, 0, null));
  state.flatDirs = out;
}

function pickDirFor(type, title) {
  const nodes = state.flatDirs;
  const rootOf = (p) =>
    nodes.find((n) => n.depth === 0 && (p === n.path || p.startsWith(`${n.path.replace(/\/+$/, '')}/`)));
  const prefRoot = rootOf(state.dirs?.defaultDir || '');
  const find = (re) => {
    const hits = nodes.filter((n) => re.test(n.label));
    if (!hits.length) return null;
    // 优先在默认库所在的盘内匹配，避免两个库里都有「电影」时选错
    return hits.find((n) => rootOf(n.path) === prefRoot) || hits[0];
  };
  let rules;
  if (/动漫|动画|番剧|anime/i.test(title)) rules = [/动漫|动画|番/i];
  else if (type === 'tv') rules = [/电视剧|剧集|连续剧|tv|剧/i];
  else rules = [/电影|影片|movie/i];
  for (const re of rules) {
    const n = find(re);
    if (n) return n.path;
  }
  return state.dirs?.defaultDir || nodes[0]?.path || '';
}

function renderDirDialog() {
  const sel = state.selectedDir;
  const cur = state.flatDirs.find((n) => n.path === sel);
  const roots = state.dirs?.roots || [];
  const inRoot = (p, rootPath) => p === rootPath || p.startsWith(`${rootPath.replace(/\/+$/, '')}/`);
  const subMode = state.dirMode === 'sub';
  const atRoot = roots.some((r) => r.path === sel);

  if (subMode) {
    // 订阅扫的是「这部剧的文件夹」，停在片库根会把整库算成一部剧——不给确认
    $('dirTip').innerHTML = atRoot
      ? `这是片库根目录，<b class="pick">订阅不能用</b><br /><span class="sub">点下面的分类文件夹进去，再选到这部剧自己的目录</span>`
      : `订阅保存到 <b class="pick">${esc(cur?.label || '目录')}</b><br /><span class="sub">${esc(sel)}</span>`;
  } else {
    $('dirTip').innerHTML = state.pending?.name
      ? `保存「${esc(state.pending.name)}」到 <b class="pick">${esc(cur?.label || '下载目录')}</b><br /><span class="sub">${esc(sel)}</span>`
      : `选择保存位置 <b class="pick">${esc(cur?.label || '下载目录')}</b><br /><span class="sub">${esc(sel)}</span>`;
  }
  $('dirConfirm').textContent = subMode ? '用这个目录' : '开始下载';
  $('dirConfirm').disabled = subMode && atRoot;

  // 按存储库分组：左边是库名，右边是它的分类文件夹，层级一眼能看清
  $('dirChips').innerHTML = roots
    .map((r) => {
      const kids = state.flatDirs.filter((n) => n.parent === r.path);
      const rootOn = sel === r.path;
      const inside = inRoot(sel || '', r.path);
      const kidHtml = kids.length
        ? kids
            .map(
              (k) => `<button class="dirchip${k.path === sel ? ' on' : ''}" data-path="${esc(k.path)}">
                <span class="ico">📁</span><span class="nm">${esc(k.label)}</span>
              </button>`,
            )
            .join('')
        : '<span class="dirlib-empty">暂无分类文件夹</span>';
      return `<div class="dirlib${inside ? ' here' : ''}">
        <button class="dirlib-hd${rootOn ? ' on' : ''}${subMode ? ' locked' : ''}"${subMode ? ' title="订阅要选到具体剧集文件夹"' : ` data-path="${esc(r.path)}"`}>
          <span class="ico">💾</span><span class="nm">${esc(r.label)}</span>
        </button>
        <div class="dirlib-bd">${kidHtml}</div>
      </div>`;
    })
    .join('') || '<div class="dirlib-empty">还没有可用的存储库</div>';

  const children = state.flatDirs.filter((n) => n.parent === sel);
  const upHtml = cur?.parent
    ? `<div class="sub-item up" data-up="${esc(cur.parent)}"><span>↩</span><span>返回上级</span></div>`
    : '';
  const childHtml = children
    .map(
      (n) => `<div class="sub-item" data-path="${esc(n.path)}">
        <span>📁</span><span>${esc(n.label)}</span><span class="path">${esc(n.path)}</span>
      </div>`,
    )
    .join('');
  const emptyHint = `<div class="sub-item" style="cursor:default;color:var(--dim)">这个目录下没有子文件夹，可以直接下载</div>`;
  $('dirNav').innerHTML = upHtml + (childHtml || emptyHint);

  $('dirChips')
    .querySelectorAll('[data-path]')
    .forEach((el) =>
      el.addEventListener('click', () => {
        state.selectedDir = el.dataset.path;
        renderDirDialog();
      }),
    );
  $('dirNav')
    .querySelectorAll('[data-path]')
    .forEach((el) =>
      el.addEventListener('click', () => {
        state.selectedDir = el.dataset.path;
        renderDirDialog();
      }),
    );
  $('dirNav')
    .querySelectorAll('[data-up]')
    .forEach((el) =>
      el.addEventListener('click', () => {
        state.selectedDir = el.dataset.up;
        renderDirDialog();
      }),
    );
}

$('dirCancel').addEventListener('click', () => {
  $('dirModal').hidden = true;
  state.pending = null;
  state.dirMode = 'download';
});

$('btnMkdir').addEventListener('click', async () => {
  const name = $('newSub').value.trim();
  if (!name) return toast('请输入文件夹名', true);
  try {
    const r = await api('/api/dirs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ parent: state.selectedDir, name }),
    });
    state.selectedDir = r.path;
    await loadDirs();
    buildFlatDirs();
    renderDirDialog();
    $('newSub').value = '';
    toast('已创建');
  } catch (err) {
    toast(err.message, true);
  }
});

$('dirConfirm').addEventListener('click', async () => {
  // 订阅只是借用这个目录浏览器，选完回到订阅弹窗，不发起下载
  if (state.dirMode === 'sub') {
    if (!state.selectedDir) return toast('请选择目录', true);
    if ((state.dirs?.roots || []).some((r) => r.path === state.selectedDir)) {
      return toast('订阅要选到具体的剧集文件夹，不能用片库根目录', true);
    }
    setSubDir(state.selectedDir);
    $('dirModal').hidden = true;
    state.dirMode = 'download';
    return;
  }
  if (!state.pending) return;
  if (!state.selectedDir) return toast('请选择目录', true);
  const btn = $('dirConfirm');
  btn.disabled = true;
  try {
    const r = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        magnet: state.pending.magnet,
        torrentUrl: state.pending.torrentUrl || '',
        dir: state.selectedDir,
        rid: state.pending.rid,
        ids: state.pending.ids,
      }),
    });
    $('dirModal').hidden = true;
    const count = state.pending.count || 1;
    state.pending = null;
    closeSheet();
    // 分流后同一个按钮可能进不同的引擎，告诉用户进了哪个，省得以为是丢任务
    const eng = r?.engine === 'qbit' ? 'qB' : 'aria2';
    toast(
      r && r.already
        ? `已经在下载列表里，没有重复添加（${eng}）`
        : count > 1 ? `已加入 ${count} 个下载任务 · ${eng}` : `已加入下载队列 · ${eng}`,
    );
    switchView('tasks');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- 任务 ---------------- */
function statusText(s) {
  return (
    { downloading: '下载中', queued: '排队中', paused: '已暂停', done: '已完成', error: '出错', removed: '已移除' }[s] || s
  );
}

const DONE_STATUSES = new Set(['done', 'removed']);
let doneExpanded = false;

function taskCard(t) {
  const eta = t.speed > 0 ? fmtEta((t.size - t.done) / t.speed) : '--';
  const canPause = t.status === 'downloading' || t.status === 'queued';
  // 每个任务都挂上它来自哪个引擎。合并显示后两边任务混在一个列表里，
  // 不标出来就分不清这个种子是 aria2 在跑还是 qB 在跑，出问题也没法判断该查谁。
  const engKey = t.engine === 'qbit' ? 'qb' : t.engine === 'aria2' ? 'aria2' : '';
  const engName = t.engine === 'qbit' ? 'qBittorrent' : t.engine === 'aria2' ? 'aria2' : '';
  const engTag = engKey ? `<span class="eng ${engKey}" title="由 ${engName} 下载">${esc(engName)}</span>` : '';
  const eng = esc(t.engine || '');
  return `<div class="task st-${esc(t.status)}">
    <div class="top">
      <span class="stat ${esc(t.status)}">${esc(statusText(t.status))}</span>${engTag}
      <div class="nm" title="${esc(t.name)}">${esc(t.name)}</div>
      <div class="acts">
        ${canPause ? `<button class="btn sm ghost" data-act="pause" data-id="${esc(t.id)}" data-eng="${eng}">暂停</button>` : ''}
        ${t.status === 'paused' ? `<button class="btn sm ghost" data-act="resume" data-id="${esc(t.id)}" data-eng="${eng}">继续</button>` : ''}
        <button class="btn sm danger" data-act="del" data-id="${esc(t.id)}" data-eng="${eng}">删除</button>
      </div>
    </div>
    <div class="prog"><i style="width:${Math.min(100, t.progress || 0).toFixed(1)}%"></i></div>
    <div class="foot">
      <span class="em">${(t.progress || 0).toFixed(1)}%</span>
      <span>${fmtSize(t.done)} / ${fmtSize(t.size)}</span>
      <span>↓ ${fmtSpeed(t.speed)}</span>
      <span>剩余 ${eta}</span>
      <span>连接 ${t.peers || 0}</span>
      <span style="margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%">${esc(t.dir || '')}</span>
    </div>
  </div>`;
}

function taskGroup(title, tone, cards, fold = false) {
  if (!cards.length) return '';
  const head = fold
    ? `<button class="task-group-hd fold" data-toggle-done aria-expanded="${doneExpanded}">
        <span class="gdot ${tone}"></span><b>${title}</b><span class="gcount">${cards.length}</span>
        <span class="gfold">${doneExpanded ? '收起' : '展开'}<i>${doneExpanded ? '▴' : '▾'}</i></span>
      </button>`
    : `<div class="task-group-hd"><span class="gdot ${tone}"></span><b>${title}</b><span class="gcount">${cards.length}</span></div>`;
  return `<div class="task-group ${tone}">
    ${head}
    <div class="task-group-body"${fold && !doneExpanded ? ' hidden' : ''}>${cards.join('')}</div>
  </div>`;
}

async function loadTasks() {
  try {
    const data = await api('/api/tasks');
    const list = data.tasks || [];
    const active = list.filter((t) => t.status === 'downloading' || t.status === 'queued').length;
    const cnt = $('taskCnt');
    cnt.hidden = active === 0;
    cnt.textContent = String(active);

    const bad = (data.errors || []).filter((e) => e.message);
    const badTip = bad.length
      ? `　<span class="err">${bad.map((e) => `${e.engine === 'qbit' ? 'qB' : 'aria2'} 未连接`).join('、')}</span>`
      : '';
    // 两个引擎都在跑时把速度拆开，只看总数分不清快慢是谁的功劳
    const sp = data.speeds || {};
    const busy = Object.entries(sp).filter(([, v]) => v > 0);
    const split = busy.length > 1 ? ` <span class="sub">（${busy.map(([k, v]) => `${k === 'qbit' ? 'qB' : k} ${fmtSpeed(v)}`).join(' · ')}）</span>` : '';
    $('taskStat').innerHTML = `总速度 <b style="color:var(--text)">${fmtSpeed(data.globalSpeed)}</b>${split}　活动 ${data.active} / 等待 ${data.waiting}${badTip}`;
    $('taskEmpty').hidden = list.length > 0;
    const running = list.filter((t) => !DONE_STATUSES.has(t.status)).map((t) => taskCard(t));
    // 已完成：按完成时间倒序，最新下完的排最上面（qB 原生顺序是添加时间早的在前）
    const finishedList = list
      .filter((t) => DONE_STATUSES.has(t.status))
      .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const finished = finishedList.map((t) => taskCard(t));
    $('tasks').innerHTML =
      taskGroup('进行中', 'live', running) + taskGroup('已完成', 'done', finished, true);

    $('tasks')
      .querySelectorAll('[data-act]')
      .forEach((btn) =>
        btn.addEventListener('click', () => {
          const card = btn.closest('.task');
          const name = card ? (card.querySelector('.nm')?.textContent || '') : '';
          taskAction(btn.dataset.act, btn.dataset.id, btn.dataset.eng, name);
        }),
      );
    $('tasks')
      .querySelectorAll('[data-toggle-done]')
      .forEach((btn) =>
        btn.addEventListener('click', () => {
          doneExpanded = !doneExpanded;
          loadTasks();
        }),
      );
  } catch (err) {
    $('taskStat').textContent = `任务读取失败：${friendly(err.message)}`;
  }
}

let pendingDel = null;

async function taskAction(act, id, eng, name) {
  const q = eng ? `engine=${encodeURIComponent(eng)}` : '';
  try {
    if (act === 'del') {
      // 不再用原生 confirm：开一个正经弹窗，X / 取消 / 点背景 / ESC 都只关弹窗不删
      pendingDel = { id, eng, q };
      $('delWithFiles').checked = false;
      $('delTip').textContent = name
        ? `将删除：${name}`
        : '确定要删除这个任务吗？删除后下载记录与进度都会消失。';
      $('delModal').hidden = false;
      return;
    }
    await api(`/api/tasks/${encodeURIComponent(id)}/${act}${q ? `?${q}` : ''}`, { method: 'POST' });
    await loadTasks();
  } catch (err) {
    toast(err.message, true);
  }
}

$('btnRefreshTasks').addEventListener('click', loadTasks);

// 删除确认弹窗：X / 取消 / 点背景 / ESC 都只关弹窗、不删任务；只有「确定删除」才真正删
function closeDelModal() {
  pendingDel = null;
  $('delModal').hidden = true;
}
$('delClose').addEventListener('click', closeDelModal);
$('delCancel').addEventListener('click', closeDelModal);
$('delModal').addEventListener('click', (e) => { if (e.target === $('delModal')) closeDelModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('delModal').hidden) { e.preventDefault(); closeDelModal(); }
});
$('delConfirm').addEventListener('click', async () => {
  if (!pendingDel) return;
  const { id, eng, q } = pendingDel;
  const files = $('delWithFiles').checked ? 1 : 0;
  closeDelModal();
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}?${[q, `files=${files}`].filter(Boolean).join('&')}`, { method: 'DELETE' });
    toast(files ? '任务与文件已删除' : '任务已删除');
  } catch (err) {
    toast(err.message, true);
  }
  await loadTasks();
});

/* ---------------- 磁力搜索源管理 ---------------- */
let magnetSources = [];
let lastProbe = null;

async function loadMagnetSources() {
  try {
    const d = await api('/api/magnet/sources');
    magnetSources = d.sources || [];
    const on = magnetSources.filter((x) => x.enabled).length;
    const pill = $('magnetPill');
    pill.textContent = on ? `${on}/${magnetSources.length} 已启用` : '未启用';
    pill.className = `pill ${on ? 'ok' : ''}`;
    renderMagnetSources();
  } catch (err) {
    $('magnetStatus').textContent = err.message;
  }
}

function renderMagnetSources() {
  $('magnetList').innerHTML = magnetSources.length
    ? magnetSources
        .map(
          (x) => `<div class="row-line">
            <span>${x.enabled ? '🧲' : '⚪'}</span>
            <div class="p">${esc(x.name)}${x.usable ? '' : '（地址不合法）'}<small>${esc(x.url)}${x.method === 'POST' ? ` · POST ${esc(x.postBody || '')}` : ''}</small></div>
            <button class="btn sm ghost" data-mgtest="${esc(x.id)}">测试</button>
            <label class="sw" title="启用 / 停用"><input type="checkbox" data-mgtoggle="${esc(x.id)}" ${x.enabled ? 'checked' : ''} /></label>
            <button class="btn sm danger" data-mgdel="${esc(x.id)}">移除</button>
          </div>`,
        )
        .join('')
    : '<div class="status">还没有磁搜源。填站点首页或搜索地址，点「测试当前地址」会自动找入口。</div>';

  $('magnetList').querySelectorAll('[data-mgtoggle]').forEach((el) =>
    el.addEventListener('change', async () => {
      const hit = magnetSources.find((x) => x.id === el.dataset.mgtoggle);
      if (hit) hit.enabled = el.checked;
      await saveMagnetSources();
      loadMagnetSources();
    }),
  );
  $('magnetList').querySelectorAll('[data-mgdel]').forEach((el) =>
    el.addEventListener('click', async () => {
      magnetSources = magnetSources.filter((x) => x.id !== el.dataset.mgdel);
      await saveMagnetSources();
      loadMagnetSources();
    }),
  );
  $('magnetList').querySelectorAll('[data-mgtest]').forEach((el) =>
    el.addEventListener('click', async () => {
      const hit = magnetSources.find((x) => x.id === el.dataset.mgtest);
      if (!hit) return;
      $('magnetStatus').textContent = `正在测试「${hit.name}」…`;
      try {
        const r = await api('/api/magnet/test', { method: 'POST', body: JSON.stringify(hit) });
        renderProbe(r, `「${hit.name}」诊断`);
        $('magnetStatus').textContent = r.ok
          ? `「${hit.name}」可用，试搜到 ${r.count} 个磁力${r.sample?.length ? `：${r.sample.join('、')}` : ''}`
          : `「${hit.name}」没抓到磁力，看下方诊断`;
      } catch (err) {
        $('magnetStatus').textContent = err.message;
      }
    }),
  );
}

/** 把探测过程逐条列出来，用户能看懂「404 → 找到表单 → 详情页命中」 */
function renderProbe(r, title) {
  const el = $('magnetProbe');
  if (!r || !Array.isArray(r.steps) || !r.steps.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<div class="probe-head">${esc(title)} · ${r.ok ? `找到 ${r.count} 个磁力` : '没找到可用入口'}</div>`
    + (r.sample?.length ? `<div class="probe-sample">示例：${esc(r.sample.join('、'))}</div>` : '')
    + `<div class="probe-steps">${r.steps.map((x) => `<div class="probe-step${x.found ? ' hit' : ''}"><span>${esc(x.label)}</span><span>${esc(x.note)}</span></div>`).join('')}</div>`
    + (r.hint ? `<div class="probe-hint">${esc(r.hint)}</div>` : '');
}

async function saveMagnetSources() {
  await api('/api/magnet/sources', {
    method: 'POST',
    body: JSON.stringify({ sources: magnetSources }),
  });
}

/** 测试一个地址：后端会自动探测表单 / 跳转 / 详情页，结果缓存下来给「添加」用 */
async function probeAddress(url, label) {
  return api('/api/magnet/test', {
    method: 'POST',
    body: JSON.stringify({ url, encoding: 'utf-8', detail: 'auto' }),
  }).then((r) => {
    lastProbe = { url, detected: r.detected || null, ok: Boolean(r.ok) };
    renderProbe(r, label);
    return r;
  });
}

$('btnMgAdd').addEventListener('click', async () => {
  const name = $('mgName').value.trim();
  const url = $('mgUrl').value.trim();
  if (!url) return toast('请填站点首页或搜索地址', true);

  let cfg = { url, method: 'GET', postBody: '', encoding: 'utf-8', detail: 'auto' };
  // 地址里没有关键词占位符（比如只填了首页）→ 先自动探测出真实入口
  if (!url.includes('{kw')) {
    $('magnetStatus').textContent = '地址里没有 {kw}，正在自动探测搜索入口…';
    try {
      const r = await probeAddress(url, '自动探测');
      if (!r.ok || !r.detected) {
        $('magnetStatus').textContent = '没找到可用入口，看下方诊断；也可以填带 {kw} 的完整搜索地址。';
        return;
      }
      cfg = { ...cfg, ...r.detected };
      $('magnetStatus').textContent = `已识别入口（${cfg.method} ${cfg.url}），试搜到 ${r.count} 个磁力，正在添加…`;
    } catch (err) {
      $('magnetStatus').textContent = err.message;
      return;
    }
  } else if (lastProbe?.url === url && lastProbe.ok && lastProbe.detected) {
    // 刚才测过且探测出的入口更准，直接采用
    cfg = { ...cfg, ...lastProbe.detected };
  }

  magnetSources.push({
    id: `mg-${Date.now().toString(36)}`,
    name: name || (() => { try { return new URL(url).host; } catch { return '未命名'; } })(),
    enabled: true,
    ...cfg,
    timeout: 12000,
  });
  try {
    await saveMagnetSources();
    $('mgName').value = '';
    $('mgUrl').value = '';
    lastProbe = null;
    toast('已添加');
    loadMagnetSources();
  } catch (err) {
    magnetSources.pop();
    toast(err.message, true);
  }
});

$('btnMgTest').addEventListener('click', async () => {
  const url = $('mgUrl').value.trim();
  if (!url) return toast('先填站点首页或搜索地址再测试', true);
  $('magnetStatus').textContent = '正在测试并探测搜索入口…';
  try {
    const r = await probeAddress(url, '测试当前地址');
    $('magnetStatus').textContent = r.ok
      ? `可用，试搜到 ${r.count} 个磁力${r.sample?.length ? `：${r.sample.join('、')}` : ''}；直接点「添加」即可`
      : `没抓到磁力：${r.hint || '看下方诊断'}`;
  } catch (err) {
    $('magnetStatus').textContent = err.message;
  }
});

/* ---------------- 设置 ---------------- */
function diagHtml(d) {
  if (!d) return '';
  return `<div class="diag-head">连接诊断</div>
    <div class="diag-line"><span>请求地址</span><b>${esc(d.url || '—')}</b></div>
    <div class="diag-line"><span>HTTP 状态</span><b>${esc(String(d.http ?? 0))}</b></div>
    ${d.body ? `<div class="diag-line"><span>响应摘要</span><b>${esc(d.body)}</b></div>` : ''}`;
}

async function loadSettingsView() {
  loadMagnetSources();
  try {
    const data = await api('/api/meta');
    const s = data.settings;
    state.meta = s;

    // 访问账号：只回显账号名与模式，密码/哈希一律不回显
    const au = s.auth || { mode: 'none', enabled: false };
    const authPillEl = $('authPill');
    authPillEl.textContent = au.mode === 'panel' ? '面板已设置'
      : au.mode === 'env' ? 'compose 环境变量'
        : au.mode === 'off' ? '已关闭' : '免登录';
    authPillEl.className = `pill ${au.enabled ? 'ok' : ''}`;
    $('authUser').value = au.username || '';
    $('authCurrentRow').hidden = !au.enabled;
    $('btnLogout').hidden = !au.enabled;
    $('btnClearAuth').hidden = !au.enabled;
    $('authPass').value = '';
    $('authConfirm').value = '';
    $('authCurrent').value = '';
    $('authStatus').textContent = au.mode === 'panel'
      ? `当前登录账号：${au.username} · 面板设置优先`
      : au.mode === 'env'
        ? '当前用 compose 里的 ACCESS_PASSWORD（只有密码）· 在下面设置账号密码即可接管'
        : au.mode === 'off'
          ? '已在面板关闭登录验证，compose 里的旧密码不再生效'
          : '当前免登录，任何人打开网页都能直接使用';

    $('engineSel').value = s.engine || 'auto';
    $('qbitRow').hidden = s.engine === 'aria2';
    $('qbitUrl').value = s.qbit?.url || '';
    $('qbitUser').value = s.qbit?.username || '';
    // 密码不回显：留空就是「不改」，所以占位文字要说明白，否则容易以为被清掉了
    $('qbitPass').value = '';
    $('qbitPass').placeholder = s.qbit?.configured ? '已保存，不改就留空' : '密码';
    const mode = data.engine.mode || s.engine || 'auto';
    const engs = data.engines || {};
    const ep = $('enginePill');
    ep.textContent = mode === 'auto' ? '自动分流' : data.engine.ok ? `${data.engine.name} 就绪` : `${data.engine.name} 离线`;
    ep.className = `pill ${data.engine.ok ? 'ok' : 'bad'}`;
    const diag = $('engineDiag');
    // 一个引擎的状态行：圆点 + 名称 + 用途 + 版本或原因
    const engLine = (label, role, ping, missingNote) => {
      if (!ping) {
        return `<div class="row-line"><span>⚪</span><div class="p">${label}<small>${esc(missingNote || role)}</small></div></div>`;
      }
      const ok = Boolean(ping.ok);
      const note = ok ? `${role} · 版本 ${esc(ping.version || '—')}` : `${role} · ${esc(friendly(ping.error || '不可用'))}`;
      return `<div class="row-line"><span>${ok ? '🟢' : '🔴'}</span><div class="p">${label}<small>${note}</small></div></div>`;
    };
    if (mode === 'auto') {
      const qb = engs.qbit;
      $('engineStatus').innerHTML =
        engLine('aria2', '种子回落', engs.aria2) +
        (qb
          ? engLine('qBittorrent', '种子·磁力', qb)
          : engLine('qBittorrent', '', null, '未填账号密码，种子暂时也交给 aria2 下载'));
      diag.hidden = Boolean(engs.aria2?.ok);
      if (!diag.hidden) diag.innerHTML = diagHtml(engs.aria2?.detail);
    } else if (data.engine.ok) {
      $('engineStatus').innerHTML = `版本 ${esc(data.engine.version || '—')}`;
      diag.hidden = true;
    } else {
      $('engineStatus').innerHTML = `<span class="err">不可用：${esc(friendly(data.engine.error || ''))}</span>`;
      diag.hidden = !data.engine.detail;
      if (!diag.hidden) diag.innerHTML = diagHtml(data.engine.detail);
    }

    // 片源接入状态
    const okA = Boolean(s.a?.configured);
    const okB = Boolean(s.b?.configured);
    const sp = $('sitePill');
    sp.textContent = okA && okB ? '已接入' : okA || okB ? '部分接入' : '未接入';
    sp.className = `pill ${okA && okB ? 'ok' : okA || okB ? '' : 'bad'}`;
    const line = (label, ok, note) =>
      `<div class="row-line"><span>${ok ? '🟢' : '⚪'}</span><div class="p">${label}<small>${
        ok ? (note || '已接入，可正常搜索') : '未接入，填写 config/sites.json 后重启生效'
      }</small></div></div>`;
    $('siteStatus').innerHTML = line('资源库 A', okA)
      + line('资源库 B', okB, s.bProxy ? '已接入，请求经代理转发' : '');

    // 资源库 A 账号：先按有没有 token 渲染，再向站点确认真实有效性
    const ap = $('srcAPill');
    ap.textContent = s.a.loggedIn ? '校验中' : okA ? '未登录' : '未接入';
    ap.className = `pill ${s.a.loggedIn ? '' : okA ? '' : 'bad'}`;
    $('srcANote').hidden = okA;
    if (!okA) $('srcANote').innerHTML = '还没有配置片源地址，填好 <code>config/sites.json</code> 后重启容器即可登录。';
    if (s.a.loggedIn) {
      $('srcALogged').hidden = false;
      $('srcAForm').hidden = true;
      const u = s.a.user || {};
      $('srcAUserLine').innerHTML = `当前账号 <b>${esc(u.nickname || s.a.username || '')}</b> ${u.vip ? '（会员）' : '（普通用户）'}`;
      // token 存着不代表还有效：真去站点问一次，失效就提示重登
      api('/api/a/status')
        .then((st) => {
          if (st.valid) {
            ap.textContent = '已登录';
            ap.className = 'pill ok';
            $('srcAUserLine').innerHTML = `当前账号 <b>${esc(st.user?.nickname || s.a.username || '')}</b> ${st.vip ? '（会员）' : '（普通用户）'} · 登录有效`;
          } else if (st.hasToken) {
            ap.textContent = '登录失效';
            ap.className = 'pill bad';
            // 把站点的真实原因带出来，避免「登录失效」四个字把所有情况都糊住
            const why = st.reason === 'error' && st.message ? `（${esc(st.message)}）` : '';
            $('srcAUserLine').innerHTML = `原账号 <b>${esc(s.a.username || '')}</b> 的登录状态已失效${why}，重新登录即可恢复种子明细`;
            $('srcALogged').hidden = true;
            $('srcAForm').hidden = !okA;
            if (okA) loadCaptcha();
          }
        })
        .catch(() => {
          ap.textContent = '已登录';
          ap.className = 'pill ok';
        });
    } else {
      $('srcALogged').hidden = true;
      $('srcAForm').hidden = !okA;
      if (okA) loadCaptcha();
    }

    $('indexPages').value = s.b.pagesPerCategory || 40;
    renderDouban(s);
    renderTmdb(s);
    renderIndexLine(data.index);
    renderDirList(s.dirs);
    loadDisk();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderIndexLine(idx) {
  if (!idx) return;
  const syncBtn = $('btnSync');
  if (syncBtn) syncBtn.disabled = Boolean(idx.running);
  const pill = $('idxPill');
  if (idx.configured === false) {
    pill.textContent = '未接入';
    pill.className = 'pill bad';
  } else {
    pill.textContent = idx.total ? `${idx.total} 条` : '未同步';
    pill.className = `pill ${idx.total ? 'ok' : ''}`;
  }

  if (idx.running) {
    $('syncProgress').innerHTML = `<span class="spinner" style="width:12px;height:12px;display:inline-block;margin:0 6px 0 0;vertical-align:-2px"></span>${esc(idx.current || '同步中')}　分类 ${idx.catDone}/${idx.catTotal}　新增 ${idx.added}`;
    if (!state.indexTimer) state.indexTimer = setInterval(pollIndex, 1500);
  } else {
    $('syncProgress').textContent = idx.finishedAt
      ? `上次同步：${new Date(idx.finishedAt).toLocaleString('zh-CN')}`
      : '还没有同步过';
    if (state.indexTimer) {
      clearInterval(state.indexTimer);
      state.indexTimer = null;
    }
  }
  if (idx.error) $('syncProgress').innerHTML += `<br /><span class="err">${esc(idx.error)}</span>`;
}

async function pollIndex() {
  try {
    const idx = await api('/api/index/status');
    renderIndexLine(idx);
  } catch {
    /* ignore */
  }
}

$('btnSync').addEventListener('click', async () => {
  const btn = $('btnSync');
  btn.disabled = true;
  $('syncProgress').innerHTML = '<span class="spinner" style="width:12px;height:12px;display:inline-block;margin:0 6px 0 0;vertical-align:-2px"></span>正在启动同步…';
  try {
    const r = await api('/api/index/sync', { method: 'POST', body: JSON.stringify({ pages: Number($('indexPages').value) || 40 }) });
    if (!r.started) {
      toast(r.status?.error || '无法开始同步', true);
      renderIndexLine(r.status);
      return;
    }
    toast('已开始同步片库');
    renderIndexLine(r.status);
    pollIndex();
  } catch (err) {
    btn.disabled = false;
    toast(err.message, true);
  }
});

$('engineSel').addEventListener('change', () => {
  // 选了自动分流也得填 qB 地址账号，所以只有「全部走 aria2」才把这一行收起来
  $('qbitRow').hidden = $('engineSel').value === 'aria2';
});

$('btnSaveEngine').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ engine: $('engineSel').value }) });
    toast($('engineSel').value === 'auto' ? '已改为自动分流' : '已切换引擎');
    loadSettingsView();
    loadTasks();
  } catch (err) {
    toast(err.message, true);
  }
});

$('btnSaveQbit').addEventListener('click', async () => {
  try {
    // 只存 qB 账号，不动分流档位——自动分流档下填完账号，种子就会自动交给 qB
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        qbit: { url: $('qbitUrl').value.trim(), username: $('qbitUser').value.trim(), password: $('qbitPass').value },
      }),
    });
    toast('已保存');
    loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadCaptcha() {
  try {
    const c = await api('/api/a/captcha');
    $('captchaImg').src = c.img;
    $('captchaImg').dataset.key = c.key;
  } catch (err) {
    $('captchaImg').removeAttribute('src');
    toast(`验证码加载失败：${err.message}`, true);
  }
}
$('btnCaptcha').addEventListener('click', loadCaptcha);
$('captchaImg').addEventListener('click', loadCaptcha);

$('aLoginClose').addEventListener('click', closeALogin);
$('aLoginCancel').addEventListener('click', closeALogin);
$('aLoginGo').addEventListener('click', doALogin);
$('aCaptchaBtn').addEventListener('click', loadACaptcha);
$('aCaptchaImg').addEventListener('click', loadACaptcha);
$('aLoginPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doALogin();
});
$('aLoginCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doALogin();
});

$('btnSrcALogin').addEventListener('click', async () => {
  const username = $('srcAUser').value.trim();
  const password = $('srcAPass').value;
  const code = $('srcACode').value.trim();
  const key = $('captchaImg').dataset.key || '';
  if (!username || !password) return toast('请输入账号密码', true);
  const btn = $('btnSrcALogin');
  btn.disabled = true;
  try {
    await api('/api/a/login', { method: 'POST', body: JSON.stringify({ username, password, code, key }) });
    $('srcAPass').value = '';
    $('srcACode').value = '';
    loadSettingsView();
    // 登录后站点才下发种子明细：面板开着就立刻重拉，否则下次打开自然刷新
    if (state.sheetItem && $('sheet').classList.contains('on')) {
      openSheet(state.sheetItem);
      toast('登录成功，已刷新资源列表');
    } else {
      toast('登录成功，重新打开资源面板即可刷新种子列表');
    }
  } catch (err) {
    toast(err.message, true);
    loadCaptcha();
  } finally {
    btn.disabled = false;
  }
});

$('btnSrcALogout').addEventListener('click', async () => {
  await api('/api/a/logout', { method: 'POST' });
  toast('已退出登录');
  loadSettingsView();
});

function renderDirList(dirs) {
  $('dirList').innerHTML =
    (dirs || [])
      .map(
        (d) => `<div class="row-line">
          <span>📁</span>
          <div class="p">${esc(d.label)}<small>${esc(d.path)}</small></div>
          <button class="btn sm danger" data-rmdir="${esc(d.path)}">移除</button>
        </div>`,
      )
      .join('') || '<div class="status">尚未配置</div>';

  $('dirList')
    .querySelectorAll('[data-rmdir]')
    .forEach((btn) =>
      btn.addEventListener('click', async () => {
        const dirs2 = (state.meta?.dirs || []).filter((d) => d.path !== btn.dataset.rmdir);
        if (!dirs2.length) return toast('至少保留一个目录', true);
        await api('/api/settings', {
          method: 'POST',
          body: JSON.stringify({ dirs: dirs2, defaultDir: dirs2[0].path, removeDir: btn.dataset.rmdir }),
        });
        state.dirs = null;
        toast('已移除');
        loadSettingsView();
      }),
    );
}

$('btnAddDir').addEventListener('click', async () => {
  const path = $('newDirPath').value.trim();
  const label = $('newDirLabel').value.trim() || path.split('/').filter(Boolean).pop() || path;
  if (!path) return toast('请输入目录路径', true);
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ dirs: [...(state.meta?.dirs || []), { label, path }], addDir: path }),
    });
    state.dirs = null;
    $('newDirPath').value = '';
    $('newDirLabel').value = '';
    toast('已添加');
    loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadDisk() {
  try {
    const d = await api('/api/disk');
    $('diskLine').innerHTML = (d.disks || [])
      .map((x) => `📀 ${esc(x.path)}　剩余 <b>${esc(x.freeText)}</b> / 共 ${esc(x.totalText)}`)
      .join('<br />');
  } catch {
    /* ignore */
  }
}

async function loadDirs() {
  try {
    state.dirs = await api('/api/dirs');
    buildFlatDirs();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderDouban(s) {
  const ok = Boolean(s?.douban?.cookieSet);
  const pill = $('doubanPill');
  pill.textContent = ok ? '已设置' : '未设置';
  pill.className = `pill ${ok ? 'ok' : ''}`;
  // Cookie 永远不回显：接口只告诉「有没有」，输入框留空表示「不改」
  $('doubanUid').value = s?.douban?.uid || '';
  $('doubanCookie').value = '';
  $('doubanCookie').placeholder = ok
    ? `已保存 · 末 4 位 ${s.douban?.cookieTail || '****'}（要换就粘贴新的）`
    : 'dbcl2=…; ck=…; 粘贴整行';
  $('doubanStatus').textContent = ok
    ? '已保存 Cookie：订阅里点「豆瓣查」能带回别名和总集数。'
    : '未设置：订阅照常能用，只是自动补的集数、别名可能不准。';
}

$('btnSaveDouban').addEventListener('click', async () => {
  const cookie = $('doubanCookie').value.trim();
  if (!cookie) return toast('先粘贴 Cookie（留空点「保存」不会清除已保存的）', true);
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ douban: { cookie } }) });
    $('doubanCookie').value = '';
    toast('已保存豆瓣 Cookie');
    loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
});

$('btnSaveDoubanUid').addEventListener('click', async () => {
  const uid = $('doubanUid').value.trim();
  try {
    // 只发 uid：不带 cookie 字段，deepMerge 就不会把已存的 Cookie 抹掉
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ douban: { uid } }) });
    toast(uid ? '已保存用户 id' : '已清空用户 id');
    loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
});

$('btnClearDouban').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ douban: { cookie: '' } }) });
    $('doubanCookie').value = '';
    toast('已清空');
    loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- TMDB ---------------- */
function renderTmdb(s) {
  const t = s?.tmdb || {};
  const ok = Boolean(t.configured);
  state.tmdbConfigured = ok;
  const pill = $('tmdbPill');
  pill.textContent = ok ? '已设置' : '未设置';
  pill.className = `pill ${ok ? 'ok' : ''}`;
  // 两个密钥框永远留空：接口只告诉「填没填」，留空表示「这次不改」。
  // 但空着容易让人以为没存上，所以用占位文字带上末 4 位——既确认存了，又不把整串密钥摊在页面上。
  $('tmdbToken').value = '';
  $('tmdbKey').value = '';
  $('tmdbToken').placeholder = t.tokenTail
    ? `已保存 eyJ…${t.tokenTail}（要换就填新的）`
    : 'v4 读访问令牌，eyJ 开头那串';
  $('tmdbKey').placeholder = t.keyTail
    ? `已保存 …${t.keyTail}（要换就填新的）`
    : 'v3 密钥，32 位十六进制';
  $('tmdbBase').value = t.base || '';
  const saved = [];
  if (t.tokenTail) saved.push(`读访问令牌，末 4 位 ${t.tokenTail}`);
  if (t.keyTail) saved.push(`API Key，末 4 位 ${t.keyTail}`);
  $('tmdbStatus').textContent = ok
    ? `已保存：${saved.join('；')}。订阅里点「TMDB 查」能带出总集数和下一集播出日。要换就填新的再保存。`
    : '未设置：订阅照常能用，只是总集数、更新日得自己填。';
}

$('btnSaveTmdb').addEventListener('click', async () => {
  const token = $('tmdbToken').value.trim();
  const apiKey = $('tmdbKey').value.trim();
  const base = $('tmdbBase').value.trim();
  // 两个框都空、之前也没配过 → 等于什么没做，直接说清楚
  if (!token && !apiKey && !state.tmdbConfigured) {
    return toast('读令牌和 API Key 至少填一个', true);
  }
  const patch = { base };
  if (token) patch.token = token;
  if (apiKey) patch.apiKey = apiKey;
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ tmdb: patch }) });
    toast(token || apiKey ? '已保存 TMDB 密钥' : '已保存 API 域名');
    loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
});

$('btnClearTmdb').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ tmdb: { token: '', apiKey: '', base: '' } }) });
    toast('已清空 TMDB 配置');
    loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
});

$('btnTestTmdb').addEventListener('click', async () => {
  const btn = $('btnTestTmdb');
  btn.disabled = true;
  const st = $('tmdbStatus');
  st.textContent = '正在由 NAS 发请求（最长 25 秒）…';
  try {
    const r = await api('/api/tmdb/test', { method: 'POST' });
    st.textContent = `连通：${r.ms} ms，用${r.auth === 'token' ? '读访问令牌' : ' API Key'}鉴权。`;
    toast('TMDB 连通');
  } catch (err) {
    // 分清是「网络不通」还是「密钥不对」：这两种在 NAS 上的处理方式完全不同
    st.textContent = `失败：${err.message}`;
    toast('没连通，原因看上面那行', true);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- 密钥输入框：眼睛开关 ---------------- */
// 保存后服务端不回显密钥，输入框必然是空的。眼睛只作用于「你刚粘进去的那串」，
// 用途是核对有没有粘全——读令牌少一位就是 401，肉眼又看不出来。
const ICO_EYE =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M2.5 12S6.4 5.8 12 5.8 21.5 12 21.5 12 17.6 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const ICO_EYE_OFF =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M2.5 12S6.4 5.8 12 5.8c1.6 0 3 .45 4.2 1.1M21.5 12s-3.9 6.2-9.5 6.2c-1.5 0-2.9-.4-4-1"/><path d="M4 4l16 16"/></svg>';

document.querySelectorAll('input[data-eye]').forEach((inp) => {
  if (inp.parentElement?.classList.contains('pw')) return;
  const wrap = document.createElement('span');
  wrap.className = 'pw';
  // 宽度类是给 input 用的，包一层之后要挪到外层，否则 .pw 会把定宽吃掉
  for (const c of ['w110', 'w120', 'w140']) {
    if (inp.classList.contains(c)) {
      wrap.classList.add(c);
      inp.classList.remove(c);
    }
  }
  inp.parentNode.insertBefore(wrap, inp);
  wrap.appendChild(inp);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'eye';
  btn.title = '显示';
  btn.setAttribute('aria-label', '显示或隐藏这段密钥');
  btn.innerHTML = ICO_EYE_OFF;
  btn.addEventListener('click', () => {
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.innerHTML = show ? ICO_EYE : ICO_EYE_OFF;
    btn.title = show ? '隐藏' : '显示';
    inp.focus();
  });
  wrap.appendChild(btn);
});

/* ---------------- 设置板块切换 ---------------- */
document.querySelectorAll('#settingsNav .snav').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('#settingsNav .snav').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.spanel').forEach((p) => p.classList.toggle('on', p.dataset.panel === b.dataset.panel));
  }),
);

/* ---------------- 访问账号 ---------------- */
$('btnSaveAuth').onclick = async () => {
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  if (!username) return toast('先填登录账号', true);
  if (!password) return toast('先填新密码', true);
  try {
    await api('/api/auth/set', {
      method: 'POST',
      body: JSON.stringify({
        username,
        password,
        confirm: $('authConfirm').value,
        currentPassword: $('authCurrent').value,
      }),
    });
    toast('访问账号已保存，立即生效');
    await loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
};

$('btnClearAuth').onclick = async () => {
  if (!confirm('关闭后任何人打开网页都能直接操作（包括公网访问）。\n\n请先在「当前密码」里填现在的密码，再点确定。\n\n确定关闭登录验证吗？')) return;
  try {
    await api('/api/auth/set', {
      method: 'POST',
      body: JSON.stringify({ username: '', password: '', currentPassword: $('authCurrent').value }),
    });
    toast('已关闭登录验证');
    await loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
};

$('btnLogout').onclick = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => null);
  location.href = '/login';
};

/* ---------------- 版本与检测更新 ---------------- */
let currentVersion = '1.2.34';

function setVersion(v) {
  if (!v) return;
  currentVersion = String(v);
  $('verBadge').textContent = `v${currentVersion}`;
  $('verNow').textContent = `v${currentVersion}`;
  $('verPill').textContent = `v${currentVersion}`;
}

async function checkUpdate() {
  const boxes = [$('verPopStatus'), $('verStatus')];
  boxes.forEach((x) => { x.textContent = '正在检查更新…'; });
  try {
    const r = await api('/api/update/check');
    let msg;
    if (!r.ok && !r.latestSha) msg = `${r.error || '检查失败'}。${r.hint || ''}`;
    else if (r.hasUpdate) msg = `发现新版本 v${r.latest}${r.latestNote ? ` · ${r.latestNote}` : ''}，建议更新。`;
    else msg = `已是最新版本 v${currentVersion}${r.latestSha ? ` · 仓库最新提交 ${r.latestSha}` : ''}。`;
    boxes.forEach((x) => { x.textContent = msg; });
    $('verCmd').hidden = !r.hasUpdate;
    $('verRepo').href = r.releaseUrl || '#';
    $('verBadge').classList.toggle('has', Boolean(r.hasUpdate));
  } catch (err) {
    boxes.forEach((x) => { x.textContent = err.message; });
  }
}

$('verBadge').addEventListener('click', () => { $('verModal').hidden = false; });
$('verClose').addEventListener('click', () => { $('verModal').hidden = true; });
$('verModal').addEventListener('click', (e) => {
  if (e.target === $('verModal')) $('verModal').hidden = true;
});
$('btnCheckUpdate').addEventListener('click', checkUpdate);
$('btnCheckUpdate2').addEventListener('click', checkUpdate);

/* ---------------- 剧集订阅 ---------------- */
const WEEK_NAME = ['', '每周一', '每周二', '每周三', '每周四', '每周五', '每周六', '每周日'];
const DOW_NAME = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
let subItems = [];
let subData = {}; // 最近一次 /api/sub 的结果：重绘时要沿用，否则「TMDB 已配」会被当成没配
let editingSubId = '';
const subBusy = new Set();

const fmtWhen = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function loadSubs() {
  try {
    const d = await api('/api/sub');
    subItems = d.items || [];
    renderSubs(d);
  } catch (err) {
    toast(err.message, true);
  }
}

function subCard(s) {
  const isMovie = s.type === 'movie';
  // 更新日可能是数组（一周更两天），老数据只有单值 updateDay
  const ds = Array.isArray(s.updateDays) && s.updateDays.length ? s.updateDays : s.updateDay ? [Number(s.updateDay)] : [];
  const off = s.enabled === false;
  const done = s.state === 'done'; // 自动完成归档：不再轮询，仍可恢复
  const busy = subBusy.has(s.id);
  const pending = Number(s.pending) || 0;
  const last = s.lastResult || '还没检查过';
  const when = done
    ? `已完成归档 · 下次复查 ${s.nextCheckAt ? fmtWhen(s.nextCheckAt) : '—'}`
    : off
      ? '已暂停，不再自动检查'
      : s.nextCheckAt
        ? `下次检查 ${fmtWhen(s.nextCheckAt)}`
        : '排队等首次检查';
  // 更新日标签只有剧集才有意义；电影只下一整部，不按周更新
  const at = String(s.updateTime || '');
  const perNight = Math.max(1, Number(s.episodesPerNight) || 1);
  const dayTag = isMovie ? '' : ds.length
    ? `<span class="day">${esc(ds.map((d) => DOW_NAME[d]).join('、'))}${
        at ? ` ${esc(at)} 起` : '更新'
      }${perNight > 1 ? ` · 每晚 ${perNight} 集` : ''}</span>`
    : '<span class="day off">未指定更新日</span>';
  const logs = (s.log || []).slice(-2).reverse();
  // TMDB 那一行：剧集看集数/下一集，电影看状态/上映日。拿不到就整行不出现
  const tm = s.tmdbMeta;
  let tmLine = '';
  if (isMovie) {
    if (tm && (tm.statusCn || tm.releaseDate)) {
      const bits = [];
      if (tm.statusCn) bits.push(tm.statusCn);
      if (tm.releaseDate) bits.push(`上映 ${tm.releaseDate}`);
      tmLine = `<div class="line tm">TMDB：${esc(bits.join(' · '))}</div>`;
    }
  } else if (tm && (tm.statusCn || tm.totalEpisodes || tm.nextAirDate)) {
    const bits = [];
    if (tm.statusCn) bits.push(tm.statusCn);
    if (tm.totalEpisodes) bits.push(`共 ${tm.totalEpisodes} 集`);
    // 多季剧每季都从第 1 集重数，只写「第 21 集」分不清是哪一季
    const multi = Number(tm.totalSeasons) > 1 && Number(tm.nextAirSeason) > 0;
    const epLabel = tm.nextAirEpisode
      ? multi
        ? `（S${tm.nextAirSeason}E${tm.nextAirEpisode}）`
        : `（第 ${tm.nextAirEpisode} 集）`
      : '';
    if (tm.nextAirDate) bits.push(`下一集 ${tm.nextAirDate}${epLabel}`);
    else if (tm.lastAirDate) bits.push(`上集 ${tm.lastAirDate}`);
    tmLine = `<div class="line tm">TMDB：${esc(bits.join(' · '))}</div>`;
  }
  // 电影没有「集」的概念，下发失败要换说法，片库根提示也不提集数
  const failText = isMovie ? '下载失败，等待重试' : `${pending} 集下发失败`;
  const rootTip = isMovie
    ? '保存目录是片库根目录，电影要存到自己的文件夹里，点「编辑」改一下'
    : '保存目录是片库根目录，集数会算成整个片库的量，点「编辑」改到这部剧自己的文件夹';
  const typeTag = `<span class="subtype-tag ${isMovie ? 'm' : 't'}">${isMovie ? '电影' : '剧集'}</span>`;
  return `<div class="sub${off ? ' off' : ''}${done ? ' done' : ''}${isMovie ? ' movie' : ''}" data-id="${esc(s.id)}">
  <div class="top">
    ${typeTag}
    <div class="nm" title="${esc(s.title)}">${esc(s.title)}</div>
    ${dayTag}
    <span class="stat ${busy ? 'downloading' : off ? 'paused' : done ? 'archived' : 'done'}">${busy ? '检查中' : off ? '已暂停' : done ? '已完成' : '订阅中'}</span>
  </div>
  <div class="line">${esc(last)}${pending && !done ? ` · <span class="warn">${failText}</span>` : ''}</div>
  <div class="path" title="${esc(s.dir)}">${esc(s.dir)}</div>
  ${tmLine}
  ${s.rootBad ? `<div class="line warn">${rootTip}</div>` : ''}
  <div class="line">${esc(when)}</div>
  <div class="acts">
    ${done
      ? '<button class="btn sm" data-act="resume">恢复订阅</button>'
      : `<button class="btn sm" data-act="check"${busy ? ' disabled' : ''}>${busy ? '检查中…' : '立即检查'}</button>`}
    <button class="btn sm ghost" data-act="edit">编辑</button>
    ${done ? '' : `<button class="btn sm ghost" data-act="toggle">${off ? '启用' : '暂停'}</button>`}
    <button class="btn sm danger" data-act="del">删除</button>
  </div>
  ${logs.length ? `<div class="recent">${logs.map((l) => `${fmtWhen(l.at)}　${esc(l.text)}`).join('<br />')}</div>` : ''}
</div>`;
}

function renderSubs(d = subData) {
  if (d) subData = d;
  const stats = d?.stats || {};
  const limit = stats.dailyLimit || 36;
  const used = stats.dailyUsed || 0;
  // 归档的单独成组，不再混在活跃订阅里刷屏；记录不删，点「恢复订阅」即可回到上面
  const done = subItems.filter((s) => s.state === 'done');
  const tv = subItems.filter((s) => s.type !== 'movie' && s.state !== 'done');
  const movies = subItems.filter((s) => s.type === 'movie' && s.state !== 'done');
  $('subStat').innerHTML = `共 ${subItems.length} 个（剧集 ${tv.length} · 电影 ${movies.length}${done.length ? ` · 已完成 ${done.length}` : ''}） · 今日已检查 ${used}/${limit}`;
  // 始终按类型分组：不管另一类有没有，标题都在，数量变化时界面不会突然跳变
  const group = (label, cls, arr) => arr.length
    ? `<div class="subgroup ${cls}"><span class="sgdot"></span>${label}<span class="sgcount">${arr.length}</span></div>`
      + arr.map((s) => subCard({ ...s, rootBad: isLibRoot(s.dir) })).join('')
    : '';
  $('subList').innerHTML = group('剧集订阅', 't', tv) + group('电影订阅', 'm', movies) + group('已完成', 'd', done);
  $('subEmpty').hidden = subItems.length > 0;
  // 没配 TMDB 就提一句：不影响补集，但集数和播出日历要自己看。
  // 配了就不再唠叨——豆瓣只是备选，两个都有反而让人以为缺东西。
  const hint = $('subHint');
  const tmOk = Boolean(d?.tmdb?.ready);
  if (subItems.length && !tmOk) {
    hint.hidden = false;
    // 只订了电影时别再念叨「总集数/播出日历」——电影没这些概念
    const tip = tv.length
      ? '没填 TMDB 密钥：总集数要自己填，也不会自动跟播出日历。'
      : '没填 TMDB 密钥：电影上映日期要自己留意，不会自动跟上映日历。';
    const extra = tv.length && !d?.douban?.ready ? '豆瓣也没配，别名准确度会差一些。' : '';
    hint.innerHTML = `${tip}${extra}<a href="#" id="subHintGo">去设置 → 影视元数据填上</a>`;
    $('subHintGo').addEventListener('click', (e) => {
      e.preventDefault();
      switchView('settings');
      const btn = document.querySelector('#settingsNav .snav[data-panel="meta"]');
      if (btn) btn.click();
      setTimeout(() => $('tmdbToken')?.focus(), 120);
    });
  } else {
    hint.hidden = true;
  }
}

const isLibRoot = (p) => Boolean(p) && (state.dirs?.roots || []).some((r) => r.path === p);

/** 「保存到」显示成「目录名 · 完整路径」，只读，点它或点「选择」都走目录浏览器 */
function setSubDir(p) {
  const v = String(p || '');
  $('subDir').value = v;
  const node = (state.flatDirs || []).find((n) => n.path === v);
  const label = node?.label || v.split('/').filter(Boolean).pop() || '';
  $('subDirText').value = v ? `${label} · ${v}` : '';
  $('subDirText').title = v;
}

function openSubDirPicker(start) {
  state.dirMode = 'sub';
  state.pending = null;
  $('newSub').value = '';
  // 起点优先级：已有的保存目录 > 默认下载目录 > 第一个库。
  // 起点若是片库根，自动往下带一层——一进弹窗就停在「不可选」的根目录上很别扭
  const pick = [String(start || ''), state.dirs?.defaultDir || '', state.flatDirs[0]?.path || ''].find(Boolean) || '';
  const usable = (p) => (isLibRoot(p) ? state.flatDirs.find((n) => n.parent === p)?.path || p : p);
  state.selectedDir = usable(pick);
  renderDirDialog();
  $('dirModal').hidden = false;
}

$('btnPickSubDir').addEventListener('click', async () => {
  if (!state.dirs) await loadDirs();
  buildFlatDirs();
  openSubDirPicker($('subDir').value);
});
$('subDirText').addEventListener('click', () => $('btnPickSubDir').click());

/** 更新日多选：数组进、方块点亮；一个都不选＝不指定 */
function setSubDays(list) {
  const set = new Set((list || []).map(Number).filter((d) => d >= 1 && d <= 7));
  document.querySelectorAll('#subDays .dchip').forEach((b) => b.classList.toggle('on', set.has(Number(b.dataset.d))));
  $('subDay').value = String([...set].sort((a, b) => a - b)[0] || 0);
}
function getSubDays() {
  return [...document.querySelectorAll('#subDays .dchip.on')].map((b) => Number(b.dataset.d)).sort((a, b) => a - b);
}
document.querySelectorAll('#subDays .dchip').forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')));

/**
 * 切换订阅类型（剧集 / 电影）。
 * 电影只下一次整包，没有更新日、集数、补集范围这些概念，
 * 所以整块藏起来而不是留着让人误以为要填。
 */
function setSubType(type, { fromUser = false } = {}) {
  const t = type === 'movie' ? 'movie' : 'tv';
  state.tmdbType = t;
  const isMovie = t === 'movie';
  document.querySelectorAll('#subType .stchip').forEach((b) => {
    b.classList.toggle('on', b.dataset.type === t);
  });
  $('subTvOnly').hidden = isMovie;
  $('subTitleLabel').textContent = isMovie ? '片名' : '剧名';
  $('subTitle').placeholder = isMovie ? '例如：流浪地球 3' : '例如：凡人修仙传';
  $('subDirText').placeholder = isMovie ? '点右边「选择」挑这部电影自己的文件夹' : '点右边「选择」挑这部剧自己的文件夹';
  $('btnTmdb').title = isMovie ? '从 TMDB 选片，带出上映日期' : '从 TMDB 选剧，带出总集数和下一集播出日';
  // 豆瓣查只补剧集集数/别名，电影没集数概念，电影模式下藏掉免得点了没用
  $('btnDouban').hidden = isMovie;
  $('subTopTip').innerHTML = isMovie
    ? '填片名就能用。点 <b>TMDB 查</b> 能带出上映日期，上映后自动下载整部。<br />电影不按集、没有更新日：只在你点检查或到上映日时，找一次整部资源下完为止。'
    : '填剧名就能用。点 <b>TMDB 查</b> 能自动带出总集数和下一集播出日（连更新日都不用挑）。<br />更新时刻只影响<b>多久查一次</b>，不影响补集：例 周三 20:00 → 20 点起每 30 分钟查一次。';
  // 用户手点切换时才清空剧集字段；编辑回填、TMDB 回填不该被这里清掉
  if (fromUser && isMovie) {
    $('subTotal').value = '';
    $('subFrom').value = '';
    $('subTo').value = '';
    setSubDays([]);
    $('subTime').value = '';
    $('subPerNight').value = '1';
  }
}

document.querySelectorAll('#subType .stchip').forEach((b) => {
  b.addEventListener('click', () => setSubType(b.dataset.type, { fromUser: true }));
});

function openSubModal(sub) {
  editingSubId = sub?.id || '';
  $('subModalTitle').textContent = sub ? '编辑订阅' : '新建订阅';
  $('subTitle').value = sub?.title || state.keyword || '';
  $('subKeyword').value = sub?.keyword && sub.keyword !== sub.title ? sub.keyword : '';
  $('subTotal').value = sub?.totalEpisodes || '';
  $('subFrom').value = sub?.startEpisode && sub.startEpisode > 1 ? sub.startEpisode : '';
  $('subTo').value = sub?.endEpisode || '';
  $('subQuality').value = String(sub?.quality || 1080);
  $('strictQuality').checked = Boolean(sub?.strictQuality);
  setSubDays(Array.isArray(sub?.updateDays) && sub.updateDays.length ? sub.updateDays : sub?.updateDay ? [sub.updateDay] : []);
  $('subTime').value = sub?.updateTime || '';
  $('subPerNight').value = String(sub?.episodesPerNight || 1);
  $('subTmdbId').value = sub?.tmdbId ? String(sub.tmdbId) : '';
  state.tmdbTitle = sub?.title || '';
  setSubDir(sub ? sub.dir : defaultSubDir());
  // 编辑时把类型回填：不回填的话，编辑一个电影订阅又没重选 TMDB，会被当成剧集存回去。
  // 新建时固定回「剧集」，不用上次残留的类型，免得点「新建订阅」莫名其妙变成电影。
  setSubType(sub ? (sub.type || 'tv') : 'tv');
  // 老订阅可能存的是片库根，进来就点明，不然下次检查又扫一遍全库
  const kindWord = sub?.type === 'movie' ? '这部电影' : '这部剧';
  $('subFormTip').textContent = isLibRoot($('subDir').value)
    ? sub?.type === 'movie'
      ? `保存目录是片库根目录，电影要存到自己的文件夹里。请点「选择」改成${kindWord}的目录。`
      : '这个订阅的保存目录是片库根目录，会扫到整个片库、集数算不准。请点「选择」改成这部剧自己的文件夹。'
    : '';
  $('subModal').hidden = false;
  setTimeout(() => $('subTitle').focus(), 30);
}

/** 默认下载目录如果是片库根，就不预填——订阅必须选到具体文件夹 */
function defaultSubDir() {
  const d = state.dirs?.defaultDir || '';
  return d && !isLibRoot(d) ? d : '';
}

$('btnNewSub').addEventListener('click', () => {
  openSubModal(null);
});

$('subCancel').addEventListener('click', () => { $('subModal').hidden = true; });
$('subModal').addEventListener('click', (e) => {
  if (e.target === $('subModal')) $('subModal').hidden = true;
});

/* ---------------- TMDB 选剧 ---------------- */
const DOW_CN = ['', '一', '二', '三', '四', '五', '六', '日'];

/** "2026-11-13" → 1~7；按本地时区构造，避免 UTC 解析导致退一天 */
function weekdayOfDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!m) return 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) ? 0 : d.getDay() || 7;
}

function openTmdbPick() {
  const q = $('subTitle').value.trim();
  if (!q) return toast('先在「剧名」里填剧名', true);
  $('tmdbModal').hidden = false;
  $('tmdbTip').textContent = `正在 TMDB 找「${q}」…`;
  $('tmdbList').innerHTML = '';
  searchTmdb(q);
}

async function searchTmdb(q) {
  const tip = $('tmdbTip');
  const list = $('tmdbList');
  try {
    // 默认搜全类型：电影 + 剧集一起返回，列表上用徽章区分，选中后分别走电影/剧集逻辑
    const r = await api(`/api/tmdb/search?q=${encodeURIComponent(q)}&type=all`);
    const items = r.items || [];
    if (!items.length) {
      tip.textContent = `TMDB 上没有「${q}」。国产剧、短剧收录不全，可以试试原名，或者改用「豆瓣查」。`;
      return;
    }
    tip.textContent = `找到 ${items.length} 条，选一个（会带出集数/上映日/状态）：`;
    list.innerHTML = items
      .map(
        (x) => `<button class="tmdb-item" data-id="${x.id}" data-type="${x.mediaType || 'tv'}">
  <span class="t"><b>${esc(x.name)}</b>${x.year ? `<i>${esc(x.year)}</i>` : ''}<em class="mtag ${x.mediaType === 'movie' ? 'm' : 't'}">${x.mediaType === 'movie' ? '电影' : '剧集'}</em></span>
  <span class="s">${esc(x.originalName || '')}${x.country ? ` · ${esc(x.country)}` : ''}</span>
  ${x.overview ? `<span class="o">${esc(x.overview)}</span>` : ''}
</button>`,
      )
      .join('');
  } catch (err) {
    // 没填密钥是最常见的一种，直接把路指给用户，别让他猜
    if (/TMDB 密钥/.test(err.message)) {
      tip.innerHTML = `${esc(err.message)}　<a href="#" id="tmdbGoKey">去填</a>`;
      const go = $('tmdbGoKey');
      if (go) {
        go.addEventListener('click', (e) => {
          e.preventDefault();
          $('tmdbModal').hidden = true;
          switchView('settings');
          const b = document.querySelector('#settingsNav .snav[data-panel="meta"]');
          if (b) b.click();
          setTimeout(() => $('tmdbToken')?.focus(), 120);
        });
      }
      return;
    }
    tip.textContent = err.message;
  }
}

function applyTmdb(d) {
  const tmdbType = d.mediaType === 'movie' ? 'movie' : 'tv';
  setSubType(tmdbType);
  $('subTmdbId').value = String(d.id || '');
  state.tmdbTitle = d.name || '';
  if (d.name) $('subTitle').value = d.name;
  // 站上的资源名常常是原名（英文/日文），拿它当搜索词命中率更高
  if (d.originalName && d.originalName !== d.name) $('subKeyword').value = d.originalName;

  // 电影订阅：没有集数/播出日历概念，清掉剧集专属字段，只留「到点下整部」
  if (tmdbType === 'movie') {
    $('subTotal').value = '';
    $('subFrom').value = '';
    $('subTo').value = '';
    setSubDays([]);
    $('subTime').value = '';
    $('subPerNight').value = '1';
    const when = d.releaseDate ? `（预计 ${d.releaseDate} ${d.statusCn || ''}）` : (d.statusCn ? `（${d.statusCn}）` : '');
    $('subFormTip').textContent = `TMDB 电影${when}：无需填集数/更新日，到点自动下载整部`;
    return;
  }

  if (d.totalEpisodes > 0) $('subTotal').value = d.totalEpisodes;

  const bits = [];
  if (d.totalEpisodes) bits.push(`共 ${d.totalEpisodes} 集`);
  if (d.totalSeasons > 1) bits.push(`${d.totalSeasons} 季`);
  if (d.statusCn) bits.push(d.statusCn);

  // 只有「下一集已经排期」才动更新日；完结剧保持用户原来的选择
  const wd = d.nextAirDate ? weekdayOfDate(d.nextAirDate) : 0;
  if (wd) {
    // TMDB 只给「下一集哪天」，所以用它替换掉手选的那几天
    setSubDays([wd]);
    $('subDay').value = String(wd);
    // 多季剧要带季号，否则「第 21 集」分不清是第几季的
    const multi = Number(d.totalSeasons) > 1 && Number(d.nextAirSeason) > 0;
    const epText = multi ? `S${d.nextAirSeason}E${d.nextAirEpisode}` : `第 ${d.nextAirEpisode} 集`;
    bits.push(`下一集 ${d.nextAirDate} 周${DOW_CN[wd]}（${epText}）→ 更新日已设为周${DOW_CN[wd]}`);
  } else if (d.lastAirDate) {
    bits.push(`上集 ${d.lastAirDate}`);
  }
  $('subFormTip').textContent = bits.length ? `TMDB：${bits.join(' · ')}` : 'TMDB：这个条目没给集数';
}

$('btnTmdb').addEventListener('click', openTmdbPick);

$('tmdbCancel').addEventListener('click', () => {
  $('tmdbModal').hidden = true;
});

$('tmdbList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.tmdb-item');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const type = btn.dataset.type === 'movie' ? 'movie' : 'tv';
  if (!id) return;
  const tip = $('tmdbTip');
  tip.textContent = '正在取详情…';
  try {
    const d = await api('/api/tmdb/lookup', { method: 'POST', body: JSON.stringify({ id, type }) });
    applyTmdb(d);
    $('tmdbModal').hidden = true;
  } catch (err) {
    tip.textContent = err.message;
  }
});

// 改了剧名却没重新选条目：TMDB 数据就不再对得上，直接把 id 清掉，避免张冠李戴
$('subTitle').addEventListener('input', () => {
  if (!$('subTmdbId').value) return;
  if ($('subTitle').value.trim() === state.tmdbTitle) return;
  $('subTmdbId').value = '';
  state.tmdbTitle = '';
  $('subFormTip').textContent = '剧名改了，TMDB 条目已解绑：再用「TMDB 查」选一次才能带上播出日历';
});

$('btnDouban').addEventListener('click', async () => {
  const q = $('subTitle').value.trim();
  const tip = $('subFormTip');
  if (!q) return toast('先填剧名', true);
  tip.textContent = '正在豆瓣查…';
  try {
    const r = await api(`/api/douban/search?q=${encodeURIComponent(q)}`);
    const items = r.items || [];
    if (!items.length) {
      tip.textContent = '豆瓣没搜到，不影响使用——直接用剧名去资源站搜就行';
      return;
    }
    const it = items.find((x) => x.episodes > 0) || items[0];
    if (it.episodes > 0) {
      $('subTotal').value = it.episodes;
      tip.textContent = `豆瓣：${it.title}${it.year ? ` (${it.year})` : ''} · 共 ${it.episodes} 集，已自动填好`;
    } else {
      tip.textContent = `豆瓣：${it.title}${it.year ? ` (${it.year})` : ''} · 没有集数信息，手动填「总集数」更准`;
    }
  } catch (err) {
    tip.textContent = err.message;
  }
});

$('subSave').addEventListener('click', async () => {
  const dayList = getSubDays();
  const dayValue = dayList[0] || 0;
  const body = {
    title: $('subTitle').value.trim(),
    keyword: $('subKeyword').value.trim(),
    dir: $('subDir').value,
    updateDays: dayList,
    // 旧字段一起发：老版本读 updateDay，保持向后兼容
    updateDay: dayValue,
    // 没选更新日就存不下时刻，避免留下一个看不出作用的孤儿值
    updateTime: dayValue ? ($('subTime').value || '') : '',
    episodesPerNight: Number($('subPerNight').value) || 1,
    totalEpisodes: Number($('subTotal').value) || 0,
    // 永远发出去：0 表示「解绑」，不发明的话编辑时清空条目会失效（后端会沿用旧 id）
    tmdbId: Number($('subTmdbId').value) || 0,
    startEpisode: Math.max(1, Number($('subFrom').value) || 1),
    endEpisode: Number($('subTo').value) || 0,
    quality: Number($('subQuality').value) || 1080,
    strictQuality: $('strictQuality').checked,
    type: state.tmdbType || 'tv',
  };
  if (body.type === 'movie') {
    // 电影没有集数/更新日概念，清掉避免干扰调度
    body.totalEpisodes = 0;
    body.startEpisode = 1;
    body.endEpisode = 0;
    body.updateDays = [];
    body.updateDay = 0;
    body.updateTime = '';
    body.episodesPerNight = 1;
  }
  const noun = body.type === 'movie' ? '片名' : '剧名';
  const which = body.type === 'movie' ? '这部电影' : '这部剧';
  if (!body.title) return toast(`先填${noun}`, true);
  if (!body.dir) return toast(`先点「选择」挑${which}的保存目录`, true);
  if (isLibRoot(body.dir)) return toast(`保存目录不能是片库根目录，请选到${which}自己的文件夹`, true);
  const btn = $('subSave');
  btn.disabled = true;
  try {
    let id = editingSubId;
    if (id) {
      await api(`/api/sub/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(body) });
      $('subModal').hidden = true;
      toast('已保存');
      await loadSubs();
    } else {
      const r = await api('/api/sub', { method: 'POST', body: JSON.stringify(body) });
      id = r.item.id;
      $('subModal').hidden = true;
      await loadSubs();
      runSubCheck(id);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

async function runSubCheck(id) {
  if (subBusy.has(id)) return;
  subBusy.add(id);
  renderSubs();
  try {
    const r = await api(`/api/sub/${encodeURIComponent(id)}/check`, { method: 'POST' });
    if (!r.pending) {
      toast('检查完成');
      return;
    }
    for (let i = 0; i < 120; i += 1) {
      await new Promise((res) => setTimeout(res, 1500));
      const st = await api(`/api/job?id=${encodeURIComponent(r.jobId)}`);
      if (st.state === 'running') continue;
      if (st.state === 'error') toast(st.error, true);
      else toast(st.result?.message || '检查完成');
      break;
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    subBusy.delete(id);
    await loadSubs();
  }
}

$('subList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.sub')?.dataset.id;
  const sub = subItems.find((s) => s.id === id);
  if (!sub) return;
  const act = btn.dataset.act;
  if (act === 'check') return runSubCheck(id);
  if (act === 'edit') return openSubModal(sub);
  if (act === 'resume') {
    try {
      await api(`/api/sub/${encodeURIComponent(id)}/resume`, { method: 'POST' });
      toast('已恢复订阅，稍后自动检查');
      loadSubs();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  if (act === 'toggle') {
    try {
      await api(`/api/sub/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify({ enabled: sub.enabled === false }),
      });
      toast(sub.enabled === false ? '已启用，稍后会自动检查' : '已暂停');
      loadSubs();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  if (act === 'del') {
    if (!confirm(`删除订阅「${sub.title}」？\n已下载的文件不会删。`)) return;
    try {
      await api(`/api/sub/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('已删除');
      loadSubs();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

/* ---------------- 启动 ---------------- */
(async function init() {
  try {
    const data = await api('/api/meta');
    setVersion(data.version);
    state.meta = data.settings;
    state.sources = data.sources || null;
    renderSourceState();
    state.selectedDir = data.settings.defaultDir;
    renderIndexLine(data.index);
    if (data.index?.running) pollIndex();
  } catch (err) {
    toast(err.message, true);
  }

  loadDirs();
  loadTasks();
  loadHot();

  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    kwEl.value = q;
    $('btnClear').hidden = false;
    doSearch();
  }

  // #settings/meta 这类深链接：直接落到某个设置板块，省得进来再点一次
  const [h, hp] = location.hash.replace('#', '').split('/');
  if (['search', 'tasks', 'sub', 'settings'].includes(h)) {
    switchView(h);
    if (h === 'settings' && hp) {
      document.querySelector(`#settingsNav .snav[data-panel="${hp}"]`)?.click();
    }
  } else kwEl.focus();

  setInterval(() => {
    if (!document.hidden) loadTasks();
  }, 2500);
})();
