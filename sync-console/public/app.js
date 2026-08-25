const $ = (sel) => document.querySelector(sel);

const state = {
  templates: [],
  stores: [],
  selection: { sourceId: null, targetId: null },
  currentJobId: null,
  eventSource: null,
  savingSelection: false,
};

function setBadge(status) {
  const el = $('#jobBadge');
  el.textContent = status || 'idle';
  el.dataset.status = status || 'idle';
}

function setError(message) {
  const el = $('#formError');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function selectedModules() {
  return [...document.querySelectorAll('input[name="module"]:checked')].map((el) => el.value);
}

function syncModuleFields() {
  const selected = new Set(selectedModules());
  document.querySelectorAll('.mod-fields[data-for]').forEach((el) => {
    const keys = String(el.dataset.for || '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    el.hidden = !keys.some((key) => selected.has(key));
  });
}

function openStoreManager() {
  const el = $('#storeManager');
  if (el) el.open = true;
}

function selectedTemplates() {
  return [...document.querySelectorAll('#templateList input[type="checkbox"]:checked')].map(
    (el) => el.value,
  );
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function findStore(id) {
  return state.stores.find((s) => s.id === id) || null;
}

function updateConnectionMeta(config) {
  const source = findStore(state.selection.sourceId);
  const target = findStore(state.selection.targetId);
  const authOk = Boolean(source?.authReady && target?.authReady);
  $('#connectionMeta').innerHTML = `
    <div><strong>Source</strong> ${source ? `${source.name} · ${source.shop}` : '未选择'}</div>
    <div><strong>Target</strong> ${target ? `${target.name} · ${target.shop}` : '未选择'}</div>
    <div>API ${config?.apiVersion || '—'} · Auth ${authOk ? 'OK' : '待完善'} · 店铺 ${state.stores.length}</div>
  `;
}

function fillSelect(selectEl, selectedId) {
  const options = [
    `<option value="">请选择店铺…</option>`,
    ...state.stores.map(
      (s) =>
        `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${s.name} — ${s.shop}${s.authReady ? '' : ' (凭证缺失)'}</option>`,
    ),
  ];
  selectEl.innerHTML = options.join('');
}

function renderStoreSelects() {
  fillSelect($('#sourceSelect'), state.selection.sourceId);
  fillSelect($('#targetSelect'), state.selection.targetId);
}

function renderStoreList() {
  const el = $('#storeList');
  if (!state.stores.length) {
    el.innerHTML = `<li><div>还没有店铺。可手动添加，或点击「从 .env 导入」。</div></li>`;
    return;
  }
  el.innerHTML = state.stores
    .map(
      (s) => `
      <li>
        <div>
          <div><strong>${s.name}</strong> · <span class="${s.authReady ? 'auth-ok' : 'auth-bad'}">${s.authReady ? '凭证就绪' : '凭证缺失'}</span></div>
          <div class="meta">${s.shop}</div>
        </div>
        <div class="row-actions">
          <button type="button" class="ghost" data-edit="${s.id}">编辑</button>
          <button type="button" class="danger" data-del="${s.id}">删除</button>
        </div>
      </li>
    `,
    )
    .join('');
}

function applyStoresPayload(payload, config) {
  state.stores = payload.stores || [];
  state.selection = payload.selection || { sourceId: null, targetId: null };
  renderStoreSelects();
  renderStoreList();
  updateConnectionMeta(config);
}

function renderTemplates(filter = '') {
  const q = filter.trim().toLowerCase();
  const list = $('#templateList');
  const items = state.templates.filter((t) => !q || t.name.toLowerCase().includes(q));
  if (!items.length) {
    list.innerHTML = `<div class="template-item"><em style="color:var(--muted)">没有匹配的模板。请填写 Templates 目录后点「扫描目录」。</em></div>`;
    return;
  }
  list.innerHTML = items
    .map((t) => {
      const value = String(t.path || t.name).replace(/"/g, '&quot;');
      const label = String(t.name).replace(/</g, '&lt;');
      return `
      <label class="template-item">
        <input type="checkbox" value="${value}" />
        <code>${label}</code>
        <span>${formatBytes(t.size)}</span>
      </label>
    `;
    })
    .join('');
}

function setTemplatesMeta(payload) {
  const meta = $('#templatesDirMeta');
  if (!meta) return;
  if (payload?.error) {
    meta.textContent = payload.error;
    return;
  }
  const count = payload?.templates?.length || 0;
  meta.textContent = payload?.dir
    ? `当前目录：${payload.dir} · ${count} 个 JSON`
    : '尚未扫描';
}

function applyTemplatesPayload(payload, preferredDir) {
  state.templates = payload.templates || [];
  if (preferredDir || payload.dir) {
    $('#templatesDir').value = preferredDir || payload.dir || '';
  }
  setTemplatesMeta(payload);
  renderTemplates($('#templateFilter').value || '');
}

async function scanTemplates({ persist = true } = {}) {
  setError('');
  const dir = $('#templatesDir').value.trim();
  try {
    const payload = persist
      ? await fetchJson('/api/templates-dir', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templatesDir: dir || null }),
        })
      : await fetchJson(`/api/templates?dir=${encodeURIComponent(dir)}`);
    applyTemplatesPayload(payload, dir || payload.dir);
    if (payload.error) setError(payload.error);
  } catch (error) {
    setError(error.message);
  }
}

function appendLog(line) {
  const view = $('#logView');
  if (view.textContent === '等待任务…') view.textContent = '';
  view.textContent += `${line}\n`;
  view.scrollTop = view.scrollHeight;
}

function resetLog() {
  $('#logView').textContent = '';
}

function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function attachStream(jobId) {
  closeStream();
  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  state.eventSource = es;

  es.addEventListener('log', (event) => {
    const data = JSON.parse(event.data);
    appendLog(data.line);
  });

  es.addEventListener('status', (event) => {
    const job = JSON.parse(event.data);
    setBadge(job.status);
    $('#jobMeta').textContent = `Job ${job.id} · ${job.sourceShop || '?'} → ${job.targetShop || '?'} · ${job.dryRun ? 'dry-run' : 'live'} · ${job.modules.join(', ')}`;
    $('#cancelBtn').disabled = !(job.status === 'running' || job.status === 'queued');
    $('#startBtn').disabled = job.status === 'running' || job.status === 'queued';
  });

  es.addEventListener('done', (event) => {
    const job = JSON.parse(event.data);
    setBadge(job.status);
    $('#cancelBtn').disabled = true;
    $('#startBtn').disabled = false;
    closeStream();
  });

  es.onerror = () => {
    /* browser will retry; ignore transient */
  };
}

function resetStoreForm() {
  $('#editStoreId').value = '';
  $('#storeName').value = '';
  $('#storeShop').value = '';
  $('#storeToken').value = '';
  $('#saveStoreBtn').textContent = '保存店铺';
  $('#storeToken').placeholder = 'shpat_ / shpca_ / shpua_…';
}

function fillStoreForm(store) {
  $('#editStoreId').value = store.id;
  $('#storeName').value = store.name;
  $('#storeShop').value = store.shop;
  $('#storeToken').value = '';
  $('#storeToken').placeholder = store.hasAccessToken ? '已保存（留空不改）' : '必填：Admin API access token';
  $('#saveStoreBtn').textContent = '更新店铺';
  openStoreManager();
}

async function persistSelection() {
  if (state.savingSelection) return;
  state.savingSelection = true;
  try {
    const payload = await fetchJson('/api/selection', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceId: $('#sourceSelect').value || null,
        targetId: $('#targetSelect').value || null,
      }),
    });
    applyStoresPayload(payload, payload.config);
    setError('');
  } catch (error) {
    setError(error.message);
  } finally {
    state.savingSelection = false;
  }
}

async function loadBootstrap() {
  const [config, storesPayload, templatesPayload] = await Promise.all([
    fetchJson('/api/config'),
    fetchJson('/api/stores'),
    fetchJson('/api/templates'),
  ]);

  applyStoresPayload(storesPayload, config);
  $('#templatesDir').value = config.templatesDir || config.defaultTemplatesDir || '';
  applyTemplatesPayload(templatesPayload, $('#templatesDir').value);
  if (!state.stores.length) openStoreManager();
  syncModuleFields();
}

async function startJob() {
  setError('');
  const payload = {
    modules: selectedModules(),
    dryRun: $('#dryRun').checked,
    menuHandle: $('#menuHandle').value.trim(),
    pageHandle: $('#pageHandle').value.trim() || 'about-us',
    pageSyncAll: $('#pageSyncAll').checked,
    articleHandle: $('#articleHandle').value.trim() || 'test',
    articleSyncAll: $('#articleSyncAll').checked,
    collectionSyncAll: $('#collectionSyncAll').checked,
    productSyncAll: $('#productSyncAll').checked,
    menuSyncAll: $('#menuSyncAll').checked,
    metaobjectTypes: $('#metaobjectTypes').value.trim(),
    metafieldKeys: $('#metafieldKeys').value.trim(),
    collectionHandle: $('#collectionHandle').value.trim() || 'robot-vacuums',
    productIds: $('#productIds').value.trim(),
    templatesDir: $('#templatesDir').value.trim(),
    templatePaths: $('#templatePaths').value.trim(),
    templates: selectedTemplates(),
    sourceId: $('#sourceSelect').value || null,
    targetId: $('#targetSelect').value || null,
  };

  if (!payload.dryRun) {
    const target = findStore(payload.targetId);
    if (!target) {
      setError('请先选择目标店铺');
      return;
    }
    const confirmed = prompt(
      `即将以 LIVE 模式写入目标店铺：\n${target.name} · ${target.shop}\n\n请输入完整目标店铺域名以确认：`,
    );
    if (String(confirmed || '').trim().toLowerCase() !== target.shop.toLowerCase()) {
      setError('目标店铺确认不匹配，已取消 Live 同步');
      return;
    }
  }

  try {
    resetLog();
    appendLog('Creating job…');
    const job = await fetchJson('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.currentJobId = job.id;
    setBadge(job.status);
    $('#startBtn').disabled = true;
    $('#cancelBtn').disabled = false;
    attachStream(job.id);
  } catch (error) {
    setError(error.message);
    appendLog(`ERROR: ${error.message}`);
    $('#startBtn').disabled = false;
  }
}

async function cancelJob() {
  if (!state.currentJobId) return;
  try {
    await fetchJson(`/api/jobs/${state.currentJobId}/cancel`, { method: 'POST' });
  } catch (error) {
    setError(error.message);
  }
}

$('#templateFilter').addEventListener('input', (e) => {
  renderTemplates(e.target.value);
});

$('#scanTemplatesBtn').addEventListener('click', () => {
  scanTemplates({ persist: true });
});

$('#templatesDir').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    scanTemplates({ persist: true });
  }
});

$('#selectVisible').addEventListener('click', () => {
  document.querySelectorAll('#templateList input[type="checkbox"]').forEach((el) => {
    el.checked = true;
  });
});

$('#clearTemplates').addEventListener('click', () => {
  document.querySelectorAll('#templateList input[type="checkbox"]').forEach((el) => {
    el.checked = false;
  });
});

$('#sourceSelect').addEventListener('change', persistSelection);
$('#targetSelect').addEventListener('change', persistSelection);

$('#swapBtn').addEventListener('click', async () => {
  const source = $('#sourceSelect').value;
  const target = $('#targetSelect').value;
  $('#sourceSelect').value = target;
  $('#targetSelect').value = source;
  await persistSelection();
});

$('#importEnvBtn').addEventListener('click', async () => {
  setError('');
  try {
    const payload = await fetchJson('/api/stores/import-env', { method: 'POST' });
    applyStoresPayload(payload, await fetchJson('/api/config'));
    appendLog(payload.message || 'Import done');
  } catch (error) {
    setError(error.message);
  }
});

$('#resetStoreForm').addEventListener('click', resetStoreForm);

$('#storeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('');
  const id = $('#editStoreId').value;
  const body = {
    name: $('#storeName').value.trim(),
    shop: $('#storeShop').value.trim(),
  };

  const token = $('#storeToken').value.trim();
  if (id) {
    if (token) body.accessToken = token;
  } else {
    body.accessToken = token;
  }

  try {
    const payload = id
      ? await fetchJson(`/api/stores/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await fetchJson('/api/stores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
    applyStoresPayload(payload, await fetchJson('/api/config'));
    resetStoreForm();
  } catch (error) {
    setError(error.message);
  }
});

$('#storeList').addEventListener('click', async (event) => {
  const editId = event.target.getAttribute?.('data-edit');
  const delId = event.target.getAttribute?.('data-del');
  if (editId) {
    const store = findStore(editId);
    if (store) fillStoreForm(store);
    return;
  }
  if (delId) {
    if (!confirm('确定删除这个店铺配置？')) return;
    try {
      const payload = await fetchJson(`/api/stores/${delId}`, { method: 'DELETE' });
      applyStoresPayload(payload, await fetchJson('/api/config'));
      if ($('#editStoreId').value === delId) resetStoreForm();
    } catch (error) {
      setError(error.message);
    }
  }
});

$('#startBtn').addEventListener('click', startJob);
$('#cancelBtn').addEventListener('click', cancelJob);

document.querySelectorAll('input[name="module"]').forEach((el) => {
  el.addEventListener('change', syncModuleFields);
});

function bindSyncAllToggle(checkboxId, fieldId) {
  const checkbox = $(`#${checkboxId}`);
  const field = $(`#${fieldId}`);
  if (!checkbox || !field) return;
  const apply = () => {
    field.disabled = checkbox.checked;
  };
  checkbox.addEventListener('change', apply);
  apply();
}

bindSyncAllToggle('articleSyncAll', 'articleHandle');
bindSyncAllToggle('pageSyncAll', 'pageHandle');
bindSyncAllToggle('productSyncAll', 'productIds');
bindSyncAllToggle('collectionSyncAll', 'collectionHandle');
bindSyncAllToggle('menuSyncAll', 'menuHandle');

loadBootstrap().catch((error) => {
  setError(error.message);
  $('#connectionMeta').textContent = `配置加载失败：${error.message}`;
});
