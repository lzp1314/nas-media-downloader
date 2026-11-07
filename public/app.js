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
  pending: null,
  searchTimer: null,
  searchSeq: 0,
  detailSeq: 0,
  indexTimer: null,
  lastType: '',
  link: null,
  sheetItem: null,
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
        .map((s) => `<span class="src src-${esc(s)}">${({ a: '源 A', b: '源 B', m: '磁力搜索' })[s] || esc(s)}</span>`)
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
  $('sBody').innerHTML = `<div class="state"><div class="state-inner"><div class="spinner"></div>正在解析磁力与网盘资源…</div></div>`;
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
  const metaBits = Object.entries(data.meta || {})
    .filter(([k, v]) => v && String(v).trim().length > 0 && String(v).trim() !== '·' && String(v).length < 40)
    .slice(0, 4)
    .map(([k, v]) => `${esc(k)}：${esc(String(v).trim())}`);
  if (metaBits.length) {
    $('sMeta').innerHTML = metaBits.join('　·　');
  }

  if (!data.total) {
    const needLogin = data.needLogin;
    const tip = needLogin
      ? '这个片源要登录后才返回资源列表'
      : (data.notes || []).join('<br />') || '没有解析到可用资源，换个片名或稍后再试';
    $('sBody').innerHTML = `<div class="state">
      <div class="state-inner">
        <div class="empty-ico">${needLogin ? '🔒' : '🕳'}</div>
        <div class="state-msg" style="margin-bottom:14px">${tip}</div>
        ${needLogin ? '<button class="btn primary sm" id="goLogin">去设置里登录</button>' : '<button class="btn ghost sm" id="retryResolve">重试</button>'}
      </div>
    </div>`;
    const goLogin = $('goLogin');
    if (goLogin)
      goLogin.addEventListener('click', () => {
        closeSheet();
        switchView('settings');
      });
    const retry = $('retryResolve');
    if (retry) retry.addEventListener('click', () => openSheet(item));
    return;
  }

  const html = data.groups
    .map(
      (g) => `<div class="qgroup">
        <div class="qtitle"><b>${esc(g.label)}</b>${g.items.length} 个</div>
        ${g.items
          .map((it) => {
            const panCls = `pan-${String(it.panKey || 'other').replace(/[^a-z0-9_-]/gi, '')}`;
            const kindTag = it.magnet
              ? ''
              : `<span class="kind ${panCls}">${it.kind === 'ed2k' ? '电驴' : esc(it.panName || '网盘')}</span>`;
            const extra = [
              it.code ? `<span class="code">提取码 ${esc(it.code)}</span>` : '',
              it.locked ? '<span class="lock">需会员取链接</span>' : '',
            ].filter(Boolean).join('');
            // 磁力可展开种子目录选集；网盘可展开分享里的文件列表；被站点锁住链接的只展示信息
            const acts = it.magnet
              ? `<div class="res-acts">
                  <button class="btn ghost sm" data-files="${esc(it.magnet)}" data-name="${esc(it.name)}">选集</button>
                  <button class="btn primary sm" data-dl="${esc(it.magnet)}" data-name="${esc(it.name)}">下载</button>
                </div>`
              : it.locked
                ? '<div class="res-acts"><span class="lock-tip">登录后可刷新链接</span></div>'
                : `<div class="res-acts">
                  <button class="btn ghost sm" data-files="${esc(it.url)}" data-name="${esc(it.name)}">展开</button>
                  <button class="btn ghost sm" data-copy="${esc(it.url)}">复制链接</button>
                </div>`;
            return `<div class="res${it.locked ? ' locked' : ''}">
              <div class="res-main">
                <div class="res-name">${esc(it.name)}</div>
                <div class="res-meta">
                  <span class="sz">${esc(it.size || '大小未知')}</span>
                  <span class="src">${esc(it.sourceLabel)}</span>
                  ${kindTag}
                  ${extra}
                </div>
              </div>
              ${acts}
            </div>`;
          })
          .join('')}
      </div>`,
    )
    .join('');

  const notes = (data.notes || []).filter(Boolean);
  $('sBody').innerHTML =
    `<div class="status" style="margin:10px 0 2px">共 ${data.total} 个资源，优先显示磁力</div>` +
    `<div class="sheet-tools"><button class="btn ghost sm" id="sheetLinkPaste">🔗 粘贴链接解析 / 选集</button></div>` +
    html +
    (notes.length ? `<div class="notebar" style="margin-top:12px">${notes.map(esc).join('<br />')}</div>` : '');

  $('sBody').querySelectorAll('[data-dl]').forEach((btn) =>
    btn.addEventListener('click', () => openDirPicker(btn.dataset.dl, btn.dataset.name, item.type)),
  );
  $('sBody').querySelectorAll('[data-files]').forEach((btn) =>
    btn.addEventListener('click', () => openLinkModal(btn.dataset.files)),
  );
  const paste = $('sheetLinkPaste');
  if (paste) paste.addEventListener('click', () => openLinkModal(''));
  $('sBody').querySelectorAll('[data-copy]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        toast('链接已复制，去网盘打开');
      } catch {
        toast('复制失败，请手动长按选择', true);
      }
    }),
  );
}

/* ---------------- 链接解析 / 选集 ---------------- */
function openLinkModal(text = '') {
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

function showLinkResult(r) {
  r.selected = new Set();
  state.link = r;
  $('linkStatus').innerHTML = `<b>${esc(r.title)}</b> · 共 ${(r.files || []).length} 个文件` +
    (r.notes?.length ? `<br /><span class="sub">${r.notes.map(esc).join('<br />')}</span>` : '');
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
    const r = await api('/api/link/resolve', { method: 'POST', body: JSON.stringify({ text }) });
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
          ${r.kind === 'pan' ? `<span class="lk${x.hasDirect ? ' ok' : ''}">${x.hasDirect ? '可直下' : '仅查看'}</span>` : ''}
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
  const name = r.kind === 'magnet' ? r.title : `选中的 ${ids.length} 个文件`;
  closeLinkModal();
  openDirPicker('', name, state.lastType || '', { rid: r.rid, ids, count: ids.length, kind: r.kind });
});

/* ---------------- 目录选择 ---------------- */
async function openDirPicker(magnet, name, type, extra = {}) {
  state.pending = { magnet, name, ...extra };
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

  $('dirTip').innerHTML = state.pending?.name
    ? `保存「${esc(state.pending.name)}」到 <b class="pick">${esc(cur?.label || '下载目录')}</b><br /><span class="sub">${esc(sel)}</span>`
    : `选择保存位置 <b class="pick">${esc(cur?.label || '下载目录')}</b><br /><span class="sub">${esc(sel)}</span>`;

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
        <button class="dirlib-hd${rootOn ? ' on' : ''}" data-path="${esc(r.path)}">
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
  if (!state.pending) return;
  if (!state.selectedDir) return toast('请选择目录', true);
  const btn = $('dirConfirm');
  btn.disabled = true;
  try {
    await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        magnet: state.pending.magnet,
        dir: state.selectedDir,
        rid: state.pending.rid,
        ids: state.pending.ids,
      }),
    });
    $('dirModal').hidden = true;
    const count = state.pending.count || 1;
    state.pending = null;
    closeSheet();
    toast(count > 1 ? `已加入 ${count} 个下载任务` : '已加入下载队列');
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
  return `<div class="task st-${esc(t.status)}">
    <div class="top">
      <span class="stat ${esc(t.status)}">${esc(statusText(t.status))}</span>
      <div class="nm" title="${esc(t.name)}">${esc(t.name)}</div>
      <div class="acts">
        ${canPause ? `<button class="btn sm ghost" data-act="pause" data-id="${esc(t.id)}">暂停</button>` : ''}
        ${t.status === 'paused' ? `<button class="btn sm ghost" data-act="resume" data-id="${esc(t.id)}">继续</button>` : ''}
        <button class="btn sm danger" data-act="del" data-id="${esc(t.id)}">删除</button>
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

    $('taskStat').innerHTML = `总速度 <b style="color:var(--text)">${fmtSpeed(data.globalSpeed)}</b>　活动 ${data.active} / 等待 ${data.waiting}`;
    $('taskEmpty').hidden = list.length > 0;
    const running = list.filter((t) => !DONE_STATUSES.has(t.status)).map(taskCard);
    const finished = list.filter((t) => DONE_STATUSES.has(t.status)).map(taskCard);
    $('tasks').innerHTML =
      taskGroup('进行中', 'live', running) + taskGroup('已完成', 'done', finished, true);

    $('tasks')
      .querySelectorAll('[data-act]')
      .forEach((btn) => btn.addEventListener('click', () => taskAction(btn.dataset.act, btn.dataset.id)));
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

async function taskAction(act, id) {
  try {
    if (act === 'del') {
      const withFiles = confirm('删除任务。是否同时删除已下载的文件？\n\n确定＝同时删文件，取消＝只删任务');
      await api(`/api/tasks/${encodeURIComponent(id)}?files=${withFiles ? 1 : 0}`, { method: 'DELETE' });
      toast(withFiles ? '任务与文件已删除' : '任务已删除');
    } else {
      await api(`/api/tasks/${encodeURIComponent(id)}/${act}`, { method: 'POST' });
    }
    await loadTasks();
  } catch (err) {
    toast(err.message, true);
  }
}

$('btnRefreshTasks').addEventListener('click', loadTasks);

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
    detailLimit: 5,
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
async function loadSettingsView() {
  loadMagnetSources();
  try {
    const data = await api('/api/meta');
    const s = data.settings;
    state.meta = s;

    $('engineSel').value = s.engine;
    $('qbitRow').hidden = s.engine !== 'qbit';
    $('qbitUrl').value = s.qbit?.url || '';
    $('qbitUser').value = s.qbit?.username || '';
    const ep = $('enginePill');
    ep.textContent = data.engine.ok ? `${data.engine.name} 就绪` : `${data.engine.name} 离线`;
    ep.className = `pill ${data.engine.ok ? 'ok' : 'bad'}`;
    const diag = $('engineDiag');
    if (data.engine.ok) {
      $('engineStatus').innerHTML = `版本 ${esc(data.engine.version || '—')}`;
      diag.hidden = true;
    } else {
      $('engineStatus').innerHTML = `<span class="err">不可用：${esc(friendly(data.engine.error || ''))}</span>`;
      const d = data.engine.detail;
      if (d) {
        diag.hidden = false;
        diag.innerHTML = `<div class="diag-head">连接诊断</div>
          <div class="diag-line"><span>请求地址</span><b>${esc(d.url || '—')}</b></div>
          <div class="diag-line"><span>HTTP 状态</span><b>${esc(String(d.http ?? 0))}</b></div>
          ${d.body ? `<div class="diag-line"><span>响应摘要</span><b>${esc(d.body)}</b></div>` : ''}`;
      } else {
        diag.hidden = true;
      }
    }

    // 片源接入状态
    const okA = Boolean(s.a?.configured);
    const okB = Boolean(s.b?.configured);
    const sp = $('sitePill');
    sp.textContent = okA && okB ? '已接入' : okA || okB ? '部分接入' : '未接入';
    sp.className = `pill ${okA && okB ? 'ok' : okA || okB ? '' : 'bad'}`;
    const line = (label, ok) =>
      `<div class="row-line"><span>${ok ? '🟢' : '⚪'}</span><div class="p">${label}<small>${
        ok ? '已接入，可正常搜索' : '未接入，填写 config/sites.json 后重启生效'
      }</small></div></div>`;
    $('siteStatus').innerHTML = line('资源库 A', okA) + line('资源库 B', okB);

    // 资源库 A 账号
    const ap = $('srcAPill');
    ap.textContent = s.a.loggedIn ? '已登录' : okA ? '未登录' : '未接入';
    ap.className = `pill ${s.a.loggedIn ? 'ok' : okA ? '' : 'bad'}`;
    $('srcANote').hidden = okA;
    if (!okA) $('srcANote').innerHTML = '还没有配置片源地址，填好 <code>config/sites.json</code> 后重启容器即可登录。';
    if (s.a.loggedIn) {
      $('srcALogged').hidden = false;
      $('srcAForm').hidden = true;
      const u = s.a.user || {};
      $('srcAUserLine').innerHTML = `当前账号 <b>${esc(u.nickname || s.a.username || '')}</b> ${u.vip ? '（会员）' : '（普通用户）'}`;
    } else {
      $('srcALogged').hidden = true;
      $('srcAForm').hidden = !okA;
      if (okA) loadCaptcha();
    }

    $('indexPages').value = s.b.pagesPerCategory || 40;
    const panOk = Boolean(s.pan?.configured);
    const pp = $('panPill');
    pp.textContent = panOk ? '已设置' : '未设置';
    pp.className = `pill ${panOk ? 'ok' : ''}`;
    $('panStatus').textContent = panOk
      ? '已保存 Cookie；重新粘贴分享链接就能取直链下载。'
      : '未设置 Cookie：仍可查看分享里的文件列表，但不能直接下载到 NAS。';
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
  $('qbitRow').hidden = $('engineSel').value !== 'qbit';
});

$('btnSaveEngine').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ engine: $('engineSel').value }) });
    toast('已切换引擎');
    loadSettingsView();
    loadTasks();
  } catch (err) {
    toast(err.message, true);
  }
});

$('btnSaveQbit').addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        qbit: { url: $('qbitUrl').value.trim(), username: $('qbitUser').value.trim(), password: $('qbitPass').value },
        engine: 'qbit',
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
    // 登录后详情接口可能放开更多网盘链接：面板开着就立刻重拉，否则下次打开自然刷新
    if (state.sheetItem && $('sheet').classList.contains('on')) {
      openSheet(state.sheetItem);
      toast('登录成功，已刷新资源列表');
    } else {
      toast('登录成功，重新打开资源面板即可刷新网盘链接');
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
        await api('/api/settings', { method: 'POST', body: JSON.stringify({ dirs: dirs2, defaultDir: dirs2[0].path }) });
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
      body: JSON.stringify({ dirs: [...(state.meta?.dirs || []), { label, path }] }),
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

$('btnSavePan').addEventListener('click', async () => {
  const cookie = $('panCookie').value.trim();
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ pan: { cookie } }) });
    $('panCookie').value = '';
    toast(cookie ? '已保存' : '没有内容可保存');
    if (cookie) loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
});

$('btnClearPan').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ pan: { cookie: '' } }) });
    $('panCookie').value = '';
    toast('已清空');
    loadSettingsView();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- 设置板块切换 ---------------- */
document.querySelectorAll('#settingsNav .snav').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('#settingsNav .snav').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.spanel').forEach((p) => p.classList.toggle('on', p.dataset.panel === b.dataset.panel));
  }),
);

/* ---------------- 版本与检测更新 ---------------- */
let currentVersion = '1.2.5';

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

  const h = location.hash.replace('#', '');
  if (['search', 'tasks', 'settings'].includes(h)) switchView(h);
  else kwEl.focus();

  setInterval(() => {
    if (!document.hidden) loadTasks();
  }, 2500);
})();
