/* 객실 공지사항 오프라인 뷰어 (PDF / GitHub 저장소 기반) */

const STORAGE_KEYS = {
  owner: 'cn_gh_owner',
  repo: 'cn_gh_repo',
  branch: 'cn_gh_branch',
  path: 'cn_gh_path',
  notices: 'cn_notices_cache',
  lastSync: 'cn_last_sync',
  authed: 'cn_authed'
};

const LOGIN_ID = 'PTACC';
const LOGIN_PW = 'ptacc1!';
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbyYWK6g3hDpCXMKuhpIU7S1uL1U8DvVUCI3azTPL5g

const RUNTIME_CACHE = 'cn-runtime';

const el = (id) => document.getElementById(id);

const state = {
  notices: [],
  activeCategory: '전체',
  query: '',
  current: null
};

/* ---------------- Filename → pinned + date + title ---------------- */
function parseFilename(name) {
  let base = name.replace(/\.pdf$/i, '');
  let pinned = false;
  const pinMatch = base.match(/^\[공지\]\s*/);
  if (pinMatch) {
    pinned = true;
    base = base.slice(pinMatch[0].length);
  }
  const m = base.match(/^(.*?)[\s_-]*(\d{4})\.(\d{2})\.(\d{2})$/);
  if (m) {
    const title = m[1].trim() || base;
    const date = `${m[2]}-${m[3]}-${m[4]}`;
    return { date, title, pinned };
  }
  return { date: '', title: base, pinned };
}

const CATEGORY_ORDER = ['Safety&Security', 'Service', 'General', 'Catering', 'Station INFO'];
function categoryRank(cat) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/* ---------------- Storage ---------------- */
function loadCachedNotices() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.notices);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveNotices(list) { localStorage.setItem(STORAGE_KEYS.notices, JSON.stringify(list)); }

function getConfig() {
  return {
    owner: localStorage.getItem(STORAGE_KEYS.owner) || 'parataaircc',
    repo: localStorage.getItem(STORAGE_KEYS.repo) || 'CabinCrewNotice',
    branch: localStorage.getItem(STORAGE_KEYS.branch) || 'main',
    path: localStorage.getItem(STORAGE_KEYS.path) || 'notices'
  };
}
function setConfig({ owner, repo, branch, path }) {
  localStorage.setItem(STORAGE_KEYS.owner, owner);
  localStorage.setItem(STORAGE_KEYS.repo, repo);
  localStorage.setItem(STORAGE_KEYS.branch, branch || 'main');
  localStorage.setItem(STORAGE_KEYS.path, path || 'notices');
}
function getLastSync() { return localStorage.getItem(STORAGE_KEYS.lastSync); }
function setLastSync(iso) { localStorage.setItem(STORAGE_KEYS.lastSync, iso); }

/* ---------------- Sync (GitHub Git Trees API, recursive) ---------------- */
function buildRawUrl(owner, repo, branch, path) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodedPath}`;
}

async function syncFromGitHub(showToastOnFail = true) {
  const { owner, repo, branch, path } = getConfig();
  if (!owner || !repo) { openSettings(); return; }

  const oldNotices = state.notices;
  const treeUrl = PROXY_URL;
  const rootPrefix = path.replace(/^\/|\/$/g, '') + '/';

  try {
    const res = await fetch(treeUrl, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('GitHub API 오류: ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data.tree)) throw new Error('저장소/브랜치 정보를 확인해줘.');

    const pdfBlobs = data.tree.filter(it => it.type === 'blob' && it.path.startsWith(rootPrefix) && /\.pdf$/i.test(it.path));

    const seenSha = new Set();
    const groupMap = new Map();

    for (const it of pdfBlobs) {
      if (seenSha.has(it.sha)) continue;
      seenSha.add(it.sha);

      const rel = it.path.slice(rootPrefix.length);
      const segments = rel.split('/');
      const category = segments.length > 1 ? segments[0] : '미분류';
      const filename = segments[segments.length - 1];
      const dirSegments = segments.slice(0, -1);
      const isGrouped = dirSegments.length >= 2;
      const groupKey = isGrouped ? dirSegments.join('/') : it.path;
      const nameForParsing = isGrouped ? dirSegments[dirSegments.length - 1] : filename;
      const { date, title, pinned } = parseFilename(nameForParsing);

      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, { id: groupKey, category, date, title, pinned, attachments: [] });
      }
      groupMap.get(groupKey).attachments.push({
        name: filename.replace(/\.pdf$/i, ''),
        url: buildRawUrl(owner, repo, branch, it.path)
      });
    }

    const notices = Array.from(groupMap.values());

    for (const n of notices) {
      n.attachments.sort((a, b) => {
        const aMatch = parseFilename(a.name).title === n.title;
        const bMatch = parseFilename(b.name).title === n.title;
        if (aMatch === bMatch) return 0;
        return aMatch ? -1 : 1;
      });
    }

    notices.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (!a.date && !b.date) return a.title.localeCompare(b.title, 'ko');
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.localeCompare(a.date);
    });

    state.notices = notices;
    saveNotices(notices);
    await pruneStaleCache(oldNotices, notices);
    setLastSync(new Date().toISOString());
    renderCategoryChips();
    renderList();
    updateSyncLine();
    showToast(`공지사항 ${notices.length}건을 동기화했어요.`);
  } catch (e) {
    if (showToastOnFail) showToast('동기화 실패 — 오프라인 상태이거나 저장소 정보가 올바르지 않아요.');
  }
}

/* ---------------- PDF caching ---------------- */
async function isCached(url) {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    return !!(await cache.match(url, { ignoreVary: true }));
  } catch { return false; }
}

async function pruneStaleCache(oldNotices, newNotices) {
  if (!('caches' in window)) return;
  try {
    const newUrls = new Set(newNotices.flatMap(n => n.attachments.map(a => a.url)));
    const cache = await caches.open(RUNTIME_CACHE);
    for (const n of oldNotices) {
      for (const att of n.attachments) {
        if (!newUrls.has(att.url)) {
          await cache.delete(att.url);
        }
      }
    }
  } catch { /* ignore */ }
}

async function isNoticeFullyCached(n) {
  for (const att of n.attachments) {
    if (!(await isCached(att.url))) return false;
  }
  return true;
}

async function ensureCached(url) {
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    const existing = await cache.match(url, { ignoreVary: true });
    if (existing) return true;
    const res = await fetch(url);
    if (!res.ok) return false;
    await cache.put(url, res.clone());
    return true;
  } catch { return false; }
}

async function getPdfObjectUrl(url) {
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    let res = await cache.match(url, { ignoreVary: true });
    if (!res) {
      res = await fetch(url);
      if (res && res.ok) await cache.put(url, res.clone());
    }
    if (res) {
      const rawBlob = await res.blob();
      const pdfBlob = rawBlob.type === 'application/pdf'
        ? rawBlob
        : new Blob([rawBlob], { type: 'application/pdf' });
      return URL.createObjectURL(pdfBlob);
    }
  } catch { /* fall through */ }
  return url;
}

async function downloadAllPdfs() {
  const statusEl = el('downloadStatus');
  const allAttachments = state.notices.flatMap(n => n.attachments);
  if (!allAttachments.length) { statusEl.textContent = '내려받을 PDF가 없어요.'; return; }
  let done = 0;
  statusEl.textContent = `내려받는 중... (0/${allAttachments.length})`;
  for (const att of allAttachments) {
    await ensureCached(att.url);
    done++;
    statusEl.textContent = `내려받는 중... (${done}/${allAttachments.length})`;
  }
  statusEl.textContent = `완료: ${done}/${allAttachments.length}건 오프라인 저장됨`;
  renderList();
}

/* ---------------- Rendering: list ---------------- */
function updateSyncLine() {
  const last = getLastSync();
  el('syncLine').textContent = last
    ? `마지막 동기화: ${new Date(last).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    : '아직 동기화되지 않음';
}

function renderCategoryChips() {
  const present = [...new Set(state.notices.map(n => n.category))];
  present.sort((a, b) => categoryRank(a) - categoryRank(b));
  const cats = ['전체', ...present];
  const wrap = el('categoryChips');
  wrap.innerHTML = '';
  cats.forEach(cat => {
    const b = document.createElement('button');
    b.className = 'chip' + (state.activeCategory === cat ? ' active' : '');
    b.textContent = cat;
    b.onclick = () => { state.activeCategory = cat; renderCategoryChips(); renderList(); };
    wrap.appendChild(b);
  });
}

function filteredNotices() {
  return state.notices.filter(n => {
    const catOk = state.activeCategory === '전체' || n.category === state.activeCategory;
    const q = state.query.trim().toLowerCase();
    const qOk = !q || n.title.toLowerCase().includes(q);
    return catOk && qOk;
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CATEGORY_COLORS = ['#4A6FA5', '#C9A227', '#6B8F71', '#A45C6B', '#7A6BA5', '#4A9BA5'];
function colorForCategory(cat) {
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return CATEGORY_COLORS[h % CATEGORY_COLORS.length];
}

async function renderList() {
  const list = filteredNotices();
  const wrap = el('noticeList');
  wrap.innerHTML = '';
  el('emptyState').hidden = list.length > 0;

  for (const n of list) {
    const cached = await isNoticeFullyCached(n);
    const multi = n.attachments.length > 1;
    const card = document.createElement('div');
    card.className = 'notice-card' + (n.pinned ? ' pinned' : '');
    card.style.borderLeftColor = n.pinned ? '#C9A227' : colorForCategory(n.category);
    card.innerHTML = `
      <div class="meta">${n.pinned ? '<span class="pin-badge">📌 공지</span>' : ''}<span class="cat">${escapeHtml(n.category)}</span>${n.date ? `<span>${escapeHtml(n.date)}</span>` : ''}</div>
      <h3>${escapeHtml(n.title)}</h3>
      <span class="attach-flag${cached ? ' saved' : ''}">${cached ? '오프라인 저장됨' : (multi ? `첨부 ${n.attachments.length}건 · 온라인 필요` : 'PDF · 온라인 필요')}</span>
    `;
    card.onclick = () => openDetail(n);
    wrap.appendChild(card);
  }
}

/* ---------------- Detail (PDF viewer) ---------------- */
async function openDetail(n) {
  state.current = n;
  el('listView').hidden = true;
  el('detailView').hidden = false;

  el('detailCat').textContent = n.category;
  el('detailDate').textContent = n.date ? ` · ${n.date}` : '';
  el('detailTitle').textContent = n.title;

  const multi = n.attachments.length > 1;
  const wrap = el('attachmentList');
  wrap.innerHTML = '';

  for (const att of n.attachments) {
    const btn = document.createElement('button');
    btn.className = 'btn-primary pdf-open-btn';
    wrap.appendChild(btn);

    const cachedBefore = await isCached(att.url);
    if (!cachedBefore && !navigator.onLine) {
      btn.disabled = true;
      btn.textContent = (multi ? att.name + ' · ' : '') + '오프라인 상태 · 열 수 없음';
      continue;
    }
    btn.disabled = true;
    btn.textContent = (multi ? att.name + ' · ' : '') + '불러오는 중...';
    const objectUrl = await getPdfObjectUrl(att.url);
    btn.disabled = false;
    btn.textContent = multi ? att.name : 'PDF 보기';
    btn.onclick = () => {
      window.location.href = objectUrl;
    };
  }

  const allCached = await isNoticeFullyCached(n);
  el('detailCachedTag').textContent = allCached ? '오프라인 저장됨' : (navigator.onLine ? '온라인에서 볼 수 있음 (저장 안 됨)' : '오프라인 · 일부 미저장');
  el('detailCachedTag').className = 'cached-tag' + (allCached ? '' : ' pending');

  window.scrollTo(0, 0);
}

function closeDetail() {
  el('detailView').hidden = true;
  el('listView').hidden = false;
}

/* ---------------- Settings panel ---------------- */
function openSettings() {
  const c = getConfig();
  el('ownerInput').value = c.owner;
  el('repoInput').value = c.repo;
  el('branchInput').value = c.branch;
  el('pathInput').value = c.path;
  el('settingsPanel').hidden = false;
}
function closeSettings() { el('settingsPanel').hidden = true; }

/* ---------------- Toast ---------------- */
let toastTimer = null;
function showToast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------- Online status ---------------- */
function updateNetDot() {
  const dot = el('netDot');
  const online = navigator.onLine;
  dot.className = 'net-dot ' + (online ? 'online' : 'offline');
  dot.title = online ? '온라인' : '오프라인';
}

/* ---------------- Login gate ---------------- */
function isLoggedIn() {
  return localStorage.getItem(STORAGE_KEYS.authed) === '1';
}

function attemptLogin() {
  const idVal = el('loginIdInput').value.trim();
  const pwVal = el('loginPwInput').value.trim();
  const errorEl = el('loginError');
  errorEl.hidden = true;

  if (idVal.toUpperCase() === LOGIN_ID && pwVal === LOGIN_PW) {
    localStorage.setItem(STORAGE_KEYS.authed, '1');
    showApp();
  } else {
    errorEl.hidden = false;
  }
}

function showApp() {
  el('loginView').hidden = true;
  el('appRoot').hidden = false;
  initApp();
}

/* ---------------- Wire up ---------------- */
function init() {
  if (isLoggedIn()) {
    showApp();
    return;
  }
  el('loginBtn').addEventListener('click', attemptLogin);
  el('loginPwInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptLogin();
  });
}

function initApp() {
  state.notices = loadCachedNotices();
  renderCategoryChips();
  renderList();
  updateSyncLine();
  updateNetDot();

  el('searchInput').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  el('backBtn').addEventListener('click', closeDetail);
  el('syncBtn').addEventListener('click', () => syncFromGitHub());
  el('settingsBtn').addEventListener('click', openSettings);
  el('closeSettingsBtn').addEventListener('click', closeSettings);
  el('saveSettingsBtn').addEventListener('click', () => {
    setConfig({
      owner: el('ownerInput').value.trim(),
      repo: el('repoInput').value.trim(),
      branch: el('branchInput').value.trim() || 'main',
      path: el('pathInput').value.trim() || 'notices'
    });
    closeSettings();
    syncFromGitHub();
  });
  el('downloadAllBtn').addEventListener('click', downloadAllPdfs);

  window.addEventListener('online', () => { updateNetDot(); syncFromGitHub(false); });
  window.addEventListener('offline', updateNetDot);

  syncFromGitHub(false);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
