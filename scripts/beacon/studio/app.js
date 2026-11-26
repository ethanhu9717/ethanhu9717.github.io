const root = document.querySelector('#app');
const pageSize = 20;
const sessionToken = document.querySelector('meta[name="beacon-session-token"]')?.content || '';

const state = {
  view: 'home',
  sidebarCollapsed: false,
  health: { state: 'checking', workspace: '', detail: '' },
  home: { loading: true, items: [], error: '', creating: false },
  articles: { loading: true, items: [], error: '', search: '', filter: 'all', offset: 0, total: 0 },
  editor: null,
  editorLoading: '',
  editorError: '',
  panel: '',
  dialog: null,
  currentPath: location.pathname,
  searchTimer: null,
};

const icons = {
  home:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z"/></svg>',
  articles:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 3h9l3 3v15H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M9 11h6M9 15h6M9 7h2"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.1 2.1-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55v.09h-3v-.09A1.7 1.7 0 0 0 10.7 18.6a1.7 1.7 0 0 0-1.88.34l-.06.06-2.1-2.1.06-.06A1.7 1.7 0 0 0 7.06 15a1.7 1.7 0 0 0-1.55-1.03h-.09v-3h.09A1.7 1.7 0 0 0 7.06 9.94a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.1-2.1.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.55v-.09h3v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.1 2.1-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.55 1.03h.09v3h-.09A1.7 1.7 0 0 0 19.4 15Z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2"/><path d="m16 16 4.1 4.1"/></svg>',
  back:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  chevron:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function apiError(message, status, payload) {
  const error = new Error(message);
  error.status = status;
  error.payload = payload;
  return error;
}

async function api(path, options = {}) {
  const headers = {
    Accept: 'application/json',
    'X-Beacon-Token': sessionToken,
    ...(options.headers || {}),
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw apiError('无法连接本地 Beacon 服务。', 0, null);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* Preserve the actionable HTTP status below. */
  }
  if (!response.ok) {
    const message =
      typeof payload?.error === 'string'
        ? payload.error
        : payload?.error?.message || `请求失败（${response.status}）`;
    throw apiError(message, response.status, payload);
  }
  return payload;
}

function routeFromPath(pathname) {
  const article = pathname.match(/^\/articles\/([^/]+)$/);
  if (article) {
    try {
      return { type: 'editor', id: decodeURIComponent(article[1]) };
    } catch {
      return { type: 'home' };
    }
  }
  if (pathname === '/articles') return { type: 'articles' };
  return { type: 'home' };
}

function pathForArticle(id) {
  return `/articles/${encodeURIComponent(id)}`;
}

function relativeTime(value) {
  const time = Number(value) || Date.parse(value) || 0;
  if (!time) return '未知时间';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 172800) return '昨天';
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(time);
}

function articleTitle(article) {
  return String(article?.title || '').trim() || '未命名文章';
}

function badgeMarkup(article) {
  const status = article.status || (article.published ? '本地发布稿' : '草稿');
  const className = status === '草稿' ? 'is-draft' : status === '有未发布修改' ? 'is-changed' : '';
  return `<span class="badge ${className}">${escapeHtml(status)}</span>`;
}

function articleRowsMarkup(items, emptyText) {
  if (!items.length) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  return `<div class="article-rows">${items
    .map(
      (article) => `<button class="article-row" type="button" data-open-id="${escapeHtml(article.id)}">
        <span class="article-title-wrap">
          <span class="article-title">${escapeHtml(articleTitle(article))}</span>
          <span class="article-id">${escapeHtml(article.id)}</span>
        </span>
        ${badgeMarkup(article)}
        <time class="article-time">${escapeHtml(relativeTime(article.updatedAt ?? article.modified))}</time>
      </button>`,
    )
    .join('')}</div>`;
}

function sidebarMarkup() {
  const route = state.view;
  const collapseLabel = state.sidebarCollapsed ? '展开侧栏' : '收起侧栏';
  const collapseMark = state.sidebarCollapsed ? '›' : '‹';
  const active = (name) => (route === name ? ' aria-current="page"' : '');
  return `<aside class="sidebar" aria-label="Beacon Studio 导航">
    <div class="brand-row">
      <span class="brand-mark" aria-hidden="true">B</span>
      <span class="brand-name">Beacon</span>
      <button class="collapse-button" type="button" data-action="collapse" aria-label="${collapseLabel}" title="${collapseLabel}">${collapseMark}</button>
    </div>
    <nav class="nav-group">
      <button class="nav-button" type="button" data-nav="home" aria-label="首页"${active('home')}>
        <span class="nav-icon">${icons.home}</span><span class="nav-label">首页</span>
      </button>
      <button class="nav-button" type="button" data-nav="articles" aria-label="文章"${active('articles')}>
        <span class="nav-icon">${icons.articles}</span><span class="nav-label">文章</span>
      </button>
    </nav>
    <div class="sidebar-footer">
      <button class="settings-button" type="button" data-action="settings" aria-label="设置">
        <span class="nav-icon">${icons.settings}</span><span class="settings-label">设置</span>
      </button>
    </div>
  </aside>`;
}

function homeMarkup() {
  const home = state.home;
  let rows = '';
  if (home.loading) rows = '<p class="empty">正在读取最近写作…</p>';
  else if (home.error)
    rows = `<p class="load-error">${escapeHtml(home.error)}<br><button class="retry-button" type="button" data-action="retry-home">重试</button></p>`;
  else rows = articleRowsMarkup(home.items, '写下第一篇文章。');
  return `<section class="home" aria-labelledby="home-title">
    <h1 id="home-title" class="home-kicker">Beacon</h1>
    <p class="home-tagline">Broadcast your ideas.</p>
    <button class="primary-button" type="button" data-action="new-article"${home.creating ? ' disabled' : ''}>
      <span aria-hidden="true">＋</span>${home.creating ? '正在新建…' : '新建文章'}
    </button>
    ${home.error && !home.loading ? `<p class="load-error">${escapeHtml(home.error)}</p>` : ''}
    <div class="section-head">
      <h2>最近写作</h2>
      ${home.items.length ? '<button class="text-button" type="button" data-nav="articles">查看全部 →</button>' : ''}
    </div>
    ${rows}
  </section>`;
}

function articlesMarkup() {
  const articles = state.articles;
  const page = Math.floor(articles.offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(articles.total / pageSize));
  const list = articles.loading
    ? '<p class="empty">正在读取文章…</p>'
    : articles.error
      ? `<p class="load-error">${escapeHtml(articles.error)}<br><button class="retry-button" type="button" data-action="retry-articles">重试</button></p>`
      : articleRowsMarkup(articles.items, '没有符合条件的文章。');
  const filterButton = (value, label) =>
    `<button class="filter-button" type="button" data-filter="${value}" aria-pressed="${articles.filter === value}">${label}</button>`;
  return `<section class="articles-page" aria-labelledby="articles-title">
    <h1 id="articles-title" class="page-title">文章</h1>
    <div class="articles-toolbar">
      <label class="search-box"><span class="visually-hidden">按标题搜索</span>${icons.search}<input data-search type="search" value="${escapeHtml(articles.search)}" placeholder="搜索标题" /></label>
      <div class="filters" aria-label="文章状态筛选">
        ${filterButton('all', '全部')}${filterButton('draft', '草稿')}${filterButton('published', '已发布')}
      </div>
    </div>
    ${list}
    ${articles.total > pageSize ? `<nav class="pagination" aria-label="分页"><button class="compact-button" type="button" data-page="previous"${articles.offset === 0 ? ' disabled' : ''}>上一页</button><span>第 ${page} / ${pages} 页</span><button class="compact-button" type="button" data-page="next"${page >= pages ? ' disabled' : ''}>下一页</button></nav>` : ''}
  </section>`;
}

function saveStatusText(editor) {
  const labels = {
    saved: '已保存到本地',
    dirty: '有未保存修改',
    saving: '正在保存',
    error: '保存失败',
    conflict: '版本冲突',
  };
  return editor?.saveMessage || labels[editor?.saveStatus] || '正在加载';
}

function editorMarkup() {
  if (state.editorLoading)
    return `<section class="editor"><header class="editor-topbar"><button class="back-button" type="button" data-nav="home">${icons.back}<span>返回</span></button></header><main class="editor-main"><p class="empty">正在打开文章…</p></main></section>`;
  if (!state.editor)
    return `<section class="editor"><header class="editor-topbar"><button class="back-button" type="button" data-nav="home">${icons.back}<span>返回</span></button></header><main class="editor-main"><p class="load-error">${escapeHtml(state.editorError || '无法打开文章。')}<br><button class="retry-button" type="button" data-action="retry-editor">重试</button></p></main></section>`;
  const editor = state.editor;
  return `<section class="editor" aria-label="文章编辑器">
    <header class="editor-topbar">
      <div class="editor-topbar-left">
        <button class="back-button" type="button" data-nav="home">${icons.back}<span>返回</span></button>
        <span class="save-state is-${escapeHtml(editor.saveStatus)}" aria-live="polite"><span class="save-state-dot" aria-hidden="true"></span><span data-save-copy>${escapeHtml(saveStatusText(editor))}</span></span>
      </div>
      <div class="editor-topbar-right">
        <button class="more-button" type="button" data-action="metadata">更多 <span aria-hidden="true">···</span></button>
      </div>
    </header>
    <main class="editor-main">
      <input class="editor-title" data-field="title" aria-label="文章标题" value="${escapeHtml(editor.title)}" placeholder="文章标题" autocomplete="off" />
      <textarea class="editor-body" data-field="body" aria-label="Markdown 正文" placeholder="开始写作…" spellcheck="true">${escapeHtml(editor.body)}</textarea>
    </main>
  </section>`;
}

function metadataMarkup() {
  if (!state.editor || !state.panel) return '';
  const editor = state.editor;
  return `<aside class="metadata-panel" role="dialog" aria-modal="true" aria-labelledby="metadata-title">
    <div class="panel-heading"><h2 id="metadata-title">文章信息</h2><button class="icon-button" type="button" data-action="close-panel" aria-label="关闭文章信息">${icons.close}</button></div>
    <div class="metadata-fields">
      <div class="metadata-field"><label for="article-summary">摘要</label><textarea id="article-summary" data-field="summary" placeholder="可选，用于文章简介">${escapeHtml(editor.summary)}</textarea></div>
      <div class="metadata-field"><label for="article-slug">固定链接</label><input id="article-slug" data-field="slug" value="${escapeHtml(editor.slug)}" placeholder="可选，发布前再填写" autocomplete="off" /></div>
    </div>
    <p class="panel-note">草稿允许留空。预览和发布将在后续阶段接入。</p>
  </aside>`;
}

function settingsMarkup() {
  if (state.panel !== 'settings') return '';
  const service = state.health.state === 'online' ? '正常（仅本机回环地址）' : '不可用';
  return `<div class="overlay" role="presentation"><section class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="panel-heading"><h2 id="settings-title">设置</h2><button class="icon-button" type="button" data-action="close-panel" aria-label="关闭设置">${icons.close}</button></div>
    <dl class="settings-list">
      <div><dt>当前工作区</dt><dd>${escapeHtml(state.health.workspace || '正在读取…')}</dd></div>
      <div><dt>本地服务</dt><dd>${escapeHtml(service)}</dd></div>
      <div><dt>发布</dt><dd>连接 GitHub 后即可发布。此 Studio 版本尚未接入发布流程。</dd></div>
    </dl>
  </section></div>`;
}

function dialogMarkup() {
  const dialog = state.dialog;
  if (!dialog) return '';
  const heading = dialog.kind === 'conflict' ? '版本冲突' : '保存失败';
  let actions = '<button class="compact-button" type="button" data-action="dialog-close">继续编辑</button>';
  if (dialog.kind === 'conflict')
    actions = `<button class="compact-button" type="button" data-action="dialog-close">继续编辑</button><button class="compact-button" type="button" data-action="reload-disk">重新载入磁盘版本</button><button class="primary-button" type="button" data-action="save-copy">保留为新草稿</button>`;
  else
    actions = `<button class="compact-button" type="button" data-action="dialog-close">继续编辑</button><button class="compact-button" type="button" data-action="download">下载当前 Markdown</button><button class="primary-button" type="button" data-action="retry-save">重试保存</button>`;
  return `<div class="overlay" role="presentation"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <h2 id="dialog-title">${heading}</h2><p>${escapeHtml(dialog.message)}</p><div class="dialog-actions">${actions}</div>
  </section></div>`;
}

function mainMarkup() {
  if (state.view === 'articles') return articlesMarkup();
  if (state.view === 'editor') return editorMarkup();
  return homeMarkup();
}

function render() {
  root.innerHTML = `<div class="shell${state.sidebarCollapsed ? ' is-collapsed' : ''}">${sidebarMarkup()}<main class="main">${mainMarkup()}</main></div>${metadataMarkup()}${settingsMarkup()}${dialogMarkup()}`;
  bindRenderedControls();
}

function bindRenderedControls() {
  root.querySelector('[data-action="collapse"]')?.addEventListener('click', () => {
    if (holdComposition('请先完成中文输入，再调整侧栏')) return;
    state.sidebarCollapsed = !state.sidebarCollapsed;
    render();
  });
  root.querySelectorAll('[data-nav]').forEach((button) =>
    button.addEventListener('click', () => navigate(button.dataset.nav === 'articles' ? '/articles' : '/')),
  );
  root.querySelector('[data-action="settings"]')?.addEventListener('click', () => {
    if (holdComposition('请先完成中文输入，再打开设置')) return;
    state.panel = 'settings';
    render();
  });
  root.querySelector('[data-action="close-panel"]')?.addEventListener('click', closePanel);
  root.querySelector('[data-action="new-article"]')?.addEventListener('click', createArticle);
  root.querySelector('[data-action="retry-home"]')?.addEventListener('click', loadHome);
  root.querySelector('[data-action="retry-articles"]')?.addEventListener('click', loadArticles);
  root.querySelector('[data-action="retry-editor"]')?.addEventListener('click', () => {
    const route = routeFromPath(location.pathname);
    if (route.type === 'editor') loadEditor(route.id);
  });
  root.querySelectorAll('[data-open-id]').forEach((button) =>
    button.addEventListener('click', () => navigate(pathForArticle(button.dataset.openId))),
  );
  root.querySelectorAll('[data-filter]').forEach((button) =>
    button.addEventListener('click', () => {
      state.articles.filter = button.dataset.filter;
      state.articles.offset = 0;
      loadArticles();
    }),
  );
  root.querySelector('[data-search]')?.addEventListener('input', (event) => {
    state.articles.search = event.target.value;
    state.articles.offset = 0;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(loadArticles, 220);
  });
  root.querySelectorAll('[data-page]').forEach((button) =>
    button.addEventListener('click', () => {
      state.articles.offset = Math.max(
        0,
        state.articles.offset + (button.dataset.page === 'next' ? pageSize : -pageSize),
      );
      loadArticles();
    }),
  );
  root.querySelector('[data-action="metadata"]')?.addEventListener('click', () => {
    if (holdComposition('请先完成中文输入，再打开文章信息')) return;
    state.panel = 'metadata';
    render();
    root.querySelector('[data-field="summary"]')?.focus();
  });
  root.querySelectorAll('[data-field]').forEach(bindEditorField);
  root.querySelector('[data-action="dialog-close"]')?.addEventListener('click', () => {
    state.dialog = null;
    render();
  });
  root.querySelector('[data-action="retry-save"]')?.addEventListener('click', async () => {
    state.dialog = null;
    render();
    await queueSave(true);
  });
  root.querySelector('[data-action="download"]')?.addEventListener('click', downloadCurrentMarkdown);
  root.querySelector('[data-action="reload-disk"]')?.addEventListener('click', reloadDisk);
  root.querySelector('[data-action="save-copy"]')?.addEventListener('click', saveAsCopy);
}

function closePanel() {
  if (holdComposition('请先完成中文输入，再关闭面板')) return;
  state.panel = '';
  render();
}

function holdComposition(message) {
  const editor = state.editor;
  if (!editor?.composing) return false;
  if (!['conflict', 'error'].includes(editor.saveStatus)) editor.saveStatus = 'dirty';
  editor.saveMessage = message;
  updateSaveStatus();
  return true;
}

function renderWhenCompositionEnds(editor) {
  if (editor.composing) {
    editor.renderPending = true;
    updateSaveStatus();
    return;
  }
  render();
}

function updateSaveStatus() {
  const editor = state.editor;
  const node = root.querySelector('.save-state');
  if (!editor || !node) return;
  node.className = `save-state is-${editor.saveStatus}`;
  const copy = node.querySelector('[data-save-copy]');
  if (copy) copy.textContent = saveStatusText(editor);
}

async function checkHealth() {
  try {
    const payload = await api('/api/health');
    state.health = {
      state: 'online',
      workspace: payload.workspace || state.health.workspace,
      detail: payload.message || '本地服务正常',
    };
  } catch (error) {
    state.health = { state: 'offline', workspace: state.health.workspace, detail: error.message };
  }
  if (state.panel === 'settings') render();
}

async function loadHome() {
  state.home = { ...state.home, loading: true, error: '' };
  if (state.view === 'home') render();
  try {
    const payload = await api('/api/articles?limit=6&offset=0');
    state.home = { ...state.home, loading: false, items: payload.items || [], error: '' };
  } catch (error) {
    state.home = { ...state.home, loading: false, items: [], error: error.message };
  }
  if (state.view === 'home') render();
}

async function loadArticles() {
  state.articles = { ...state.articles, loading: true, error: '' };
  if (state.view === 'articles') render();
  const query = new URLSearchParams({
    limit: String(pageSize),
    offset: String(state.articles.offset),
    status: state.articles.filter,
  });
  if (state.articles.search.trim()) query.set('search', state.articles.search.trim());
  try {
    const payload = await api(`/api/articles?${query}`);
    state.articles = {
      ...state.articles,
      loading: false,
      items: payload.items || [],
      total: Number(payload.total || 0),
      error: '',
    };
  } catch (error) {
    state.articles = { ...state.articles, loading: false, items: [], total: 0, error: error.message };
  }
  if (state.view === 'articles') render();
}

function editorSignature(editor) {
  return JSON.stringify([editor.title, editor.body, editor.summary, editor.slug]);
}

function makeEditor(article) {
  const editor = {
    id: article.id,
    title: String(article.title || ''),
    body: String(article.body || ''),
    summary: String(article.summary || ''),
    slug: String(article.slug || ''),
    revision: article.revision,
    saveStatus: 'saved',
    saveMessage: '',
    editVersion: 0,
    lastSavedVersion: 0,
    queuedVersion: 0,
    saveChain: Promise.resolve(true),
    saveTimer: null,
    composing: false,
    compositionDirty: false,
    renderPending: false,
  };
  editor.lastEditSignature = editorSignature(editor);
  return editor;
}

async function loadEditor(id, { focusTitle = false } = {}) {
  state.view = 'editor';
  state.editor = null;
  state.editorLoading = id;
  state.editorError = '';
  state.panel = '';
  render();
  try {
    const payload = await api(`/api/articles/${encodeURIComponent(id)}`);
    if (state.editorLoading !== id || state.view !== 'editor') return;
    state.editor = makeEditor(payload.article);
    state.editorLoading = '';
    render();
    if (focusTitle) requestAnimationFrame(() => root.querySelector('[data-field="title"]')?.focus());
  } catch (error) {
    if (state.editorLoading !== id || state.view !== 'editor') return;
    state.editorLoading = '';
    state.editorError = error.message;
    render();
  }
}

function hasUnsavedEditor() {
  const editor = state.editor;
  if (!editor) return false;
  return (
    editor.composing ||
    editor.compositionDirty ||
    editor.editVersion !== editor.lastSavedVersion ||
    !['saved'].includes(editor.saveStatus)
  );
}

async function navigate(path, { replace = false, skipGuard = false } = {}) {
  if (!skipGuard && path !== state.currentPath && hasUnsavedEditor()) {
    const saved = await saveBeforeLeave();
    if (!saved) return;
  }
  if (path !== state.currentPath) {
    history[replace ? 'replaceState' : 'pushState']({}, '', path);
    state.currentPath = path;
  }
  const route = routeFromPath(path);
  if (route.type !== 'editor') {
    state.editor = null;
    state.editorLoading = '';
    state.panel = '';
    state.dialog = null;
  }
  if (route.type === 'articles') {
    state.view = 'articles';
    render();
    await loadArticles();
  } else if (route.type === 'editor') await loadEditor(route.id);
  else {
    state.view = 'home';
    render();
    await loadHome();
  }
}

async function createArticle() {
  if (state.home.creating) return;
  state.home = { ...state.home, creating: true, error: '' };
  render();
  try {
    const payload = await api('/api/articles', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: {},
    });
    state.home = { ...state.home, creating: false };
    await navigate(pathForArticle(payload.article.id));
    requestAnimationFrame(() => root.querySelector('[data-field="title"]')?.focus());
  } catch (error) {
    state.home = { ...state.home, creating: false, error: `无法新建文章：${error.message}` };
    if (state.view === 'home') render();
  }
}

function bindEditorField(element) {
  const field = element.dataset.field;
  if (!field || !state.editor) return;
  element.addEventListener('compositionstart', () => {
    if (state.editor) state.editor.composing = true;
  });
  element.addEventListener('compositionend', (event) => {
    if (!state.editor) return;
    const editor = state.editor;
    editor[field] = event.target.value;
    editor.composing = false;
    if (editor.compositionDirty) {
      editor.compositionDirty = false;
      commitEditorChange();
    }
    if (editor.renderPending) {
      editor.renderPending = false;
      render();
    }
  });
  element.addEventListener('input', (event) => {
    if (!state.editor) return;
    state.editor[field] = event.target.value;
    if (event.isComposing || state.editor.composing) {
      state.editor.compositionDirty = true;
      if (!['conflict', 'error'].includes(state.editor.saveStatus)) {
        state.editor.saveStatus = 'dirty';
        state.editor.saveMessage = '';
        updateSaveStatus();
      }
      return;
    }
    commitEditorChange();
  });
}

function commitEditorChange() {
  const editor = state.editor;
  if (!editor) return;
  const signature = editorSignature(editor);
  if (signature === editor.lastEditSignature) {
    if (
      !editor.composing &&
      !editor.compositionDirty &&
      editor.editVersion === editor.lastSavedVersion &&
      editor.saveStatus === 'dirty'
    ) {
      editor.saveStatus = 'saved';
      editor.saveMessage = '';
      updateSaveStatus();
    }
    return;
  }
  editor.lastEditSignature = signature;
  editor.editVersion += 1;
  if (!['conflict', 'error'].includes(editor.saveStatus)) {
    editor.saveMessage = '';
    editor.saveStatus = 'dirty';
  }
  updateSaveStatus();
  scheduleSave();
}

function scheduleSave() {
  const editor = state.editor;
  if (!editor || editor.saveStatus === 'conflict') return;
  clearTimeout(editor.saveTimer);
  editor.saveTimer = setTimeout(() => void queueSave(), 600);
}

function snapshot(editor) {
  return {
    title: editor.title,
    body: editor.body,
    summary: editor.summary,
    slug: editor.slug,
  };
}

function queueSave(immediate = false) {
  const editor = state.editor;
  if (!editor || editor.saveStatus === 'conflict') return Promise.resolve(false);
  if (immediate) clearTimeout(editor.saveTimer);
  const version = editor.editVersion;
  if (version === editor.lastSavedVersion) return Promise.resolve(true);
  if (version <= editor.queuedVersion) return editor.saveChain;
  const captured = snapshot(editor);
  editor.queuedVersion = version;
  editor.saveChain = editor.saveChain.then(
    () => persistSnapshot(editor, version, captured),
    () => persistSnapshot(editor, version, captured),
  );
  return editor.saveChain;
}

async function persistSnapshot(editor, version, captured) {
  if (state.editor !== editor || editor.saveStatus === 'conflict') return false;
  if (version <= editor.lastSavedVersion) return true;
  if (version === editor.editVersion) {
    editor.saveStatus = 'saving';
    editor.saveMessage = '';
    updateSaveStatus();
  }
  try {
    const payload = await api(`/api/articles/${encodeURIComponent(editor.id)}`, {
      method: 'PUT',
      body: { ...captured, baseRevision: editor.revision },
    });
    if (state.editor !== editor) return false;
    editor.revision = payload.article.revision;
    editor.lastSavedVersion = Math.max(editor.lastSavedVersion, version);
    if (editor.editVersion === version && !editor.composing && !editor.compositionDirty) {
      editor.saveStatus = 'saved';
      editor.saveMessage = '';
    } else {
      editor.saveStatus = 'dirty';
      editor.saveMessage = '';
    }
    updateSaveStatus();
    void refreshListsAfterSave();
    return true;
  } catch (error) {
    if (state.editor !== editor) return false;
    editor.queuedVersion = Math.min(editor.queuedVersion, version - 1);
    if (error.status === 409) {
      editor.saveStatus = 'conflict';
      editor.saveMessage = '';
      state.dialog = {
        kind: 'conflict',
        message: '磁盘版本已变化。当前编辑仍保留在此页面；请继续编辑、重新载入磁盘版本，或保留为一篇新草稿。',
      };
      renderWhenCompositionEnds(editor);
      return false;
    }
    editor.saveStatus = 'error';
    editor.saveMessage = error.message;
    state.dialog = { kind: 'error', message: `内容尚未写入文件：${error.message}` };
    renderWhenCompositionEnds(editor);
    return false;
  }
}

async function saveBeforeLeave() {
  const editor = state.editor;
  if (!editor) return true;
  if (editor.composing) {
    editor.saveStatus = 'dirty';
    editor.saveMessage = '请先完成中文输入，再保存或离开';
    updateSaveStatus();
    return false;
  }
  if (editor.compositionDirty) {
    editor.compositionDirty = false;
    commitEditorChange();
  }
  clearTimeout(editor.saveTimer);
  await queueSave(true);
  await editor.saveChain;
  if (!hasUnsavedEditor()) return true;
  if (!state.dialog) {
    state.dialog = {
      kind: 'error',
      message: '离开前无法确认内容已写入本地文件。请重试保存或下载当前 Markdown；此页面会保留你的编辑。',
    };
    render();
  }
  return false;
}

async function reloadDisk() {
  const editor = state.editor;
  if (!editor) return;
  if (!window.confirm('重新载入会放弃当前页面中尚未保存的编辑。是否继续？')) return;
  try {
    const payload = await api(`/api/articles/${encodeURIComponent(editor.id)}`);
    state.editor = makeEditor(payload.article);
    state.dialog = null;
    render();
  } catch (error) {
    state.dialog = { kind: 'error', message: `无法重新读取磁盘版本：${error.message}` };
    render();
  }
}

async function saveAsCopy() {
  const editor = state.editor;
  if (!editor) return;
  try {
    const payload = await api('/api/articles', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { ...snapshot(editor), title: editor.title ? `${editor.title}（副本）` : '' },
    });
    state.dialog = null;
    state.editor = makeEditor(payload.article);
    state.currentPath = pathForArticle(payload.article.id);
    history.pushState({}, '', state.currentPath);
    render();
    void refreshListsAfterSave();
  } catch (error) {
    state.dialog = { kind: 'error', message: `无法创建副本：${error.message}` };
    render();
  }
}

function downloadCurrentMarkdown() {
  const editor = state.editor;
  if (!editor) return;
  const quote = (value) => JSON.stringify(String(value || ''));
  const markdown = `---\ntitle: ${quote(editor.title)}\ndescription: ${quote(editor.summary)}\nslug: ${quote(editor.slug)}\ndraft: true\n---\n${editor.body}`;
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${editor.id.replace(/\.mdx?$/, '') || 'beacon-draft'}-unsaved.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function refreshListsAfterSave() {
  if (state.view === 'home') return loadHome();
  if (state.view === 'articles') return loadArticles();
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (state.dialog) {
      state.dialog = null;
      render();
      return;
    }
    if (state.panel) {
      closePanel();
      return;
    }
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === 's' &&
    state.editor &&
    !event.isComposing &&
    !state.editor.composing
  ) {
    event.preventDefault();
    void queueSave(true);
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!hasUnsavedEditor()) return;
  event.preventDefault();
});

window.addEventListener('popstate', async () => {
  const nextPath = location.pathname;
  if (hasUnsavedEditor() && nextPath !== state.currentPath) {
    history.pushState({}, '', state.currentPath);
    const saved = await saveBeforeLeave();
    if (saved) await navigate(nextPath, { skipGuard: true });
    return;
  }
  state.currentPath = nextPath;
  await navigate(nextPath, { skipGuard: true });
});

async function boot() {
  render();
  await checkHealth();
  await navigate(location.pathname, { replace: true, skipGuard: true });
  setInterval(checkHealth, 15_000);
}

void boot();
