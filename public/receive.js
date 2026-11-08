(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const panelSend = $('panel-send');
  const panelReceive = $('panel-receive');
  const tabSend = $('tab-send');
  const tabReceive = $('tab-receive');
  const dot = $('recv-dot');
  const listBox = $('recv-list');
  let rows = [];
  let evtSource = null;
  let searchTimer = null;
  let authed = false;

  function showTab(which) {
    const receiving = which === 'receive';
    panelSend.hidden = receiving;
    panelReceive.hidden = !receiving;
    tabSend.classList.toggle('active', !receiving);
    tabReceive.classList.toggle('active', receiving);
    if (receiving) {
      dot.hidden = true;
      if (authed) loadFiles();
    }
  }

  // 服务端对 html/svg/js 强制 attachment，前端不提供预览入口，避免点了变下载
  function canPreview(f) {
    if (/\.(html?|svg|xml|js|mjs|xhtml|hta)$/i.test(f.name)) return false;
    return FT.kind(f.name, f.mime).preview !== 'none';
  }

  function render() {
    listBox.replaceChildren();
    $('recv-count').textContent = `共 ${rows.length} 个文件`;
    if (!rows.length) {
      const empty = FT.el('div', 'empty');
      empty.append(
        FT.el('h3', '', '还没有文件'),
        FT.el('div', '', '在电脑端点「发送文件到手机」，文件会自动出现在这里')
      );
      listBox.append(empty);
      return;
    }

    for (const f of rows) {
      const k = FT.kind(f.name, f.mime);
      const row = FT.el('div', 'file-row');
      const meta = FT.el('div', 'file-meta');
      meta.append(
        FT.el('div', 'file-name', f.name),
        FT.el('div', 'file-sub', `${FT.fmtSize(f.size)} · ${FT.fmtDate(f.created_at)}`)
      );

      const actions = FT.el('div', 'file-actions');
      if (canPreview(f)) {
        const pv = FT.el('a', 'btn sm', '预览');
        pv.href = `/api/files/${f.id}`;
        pv.target = '_blank';
        pv.rel = 'noopener';
        actions.append(pv);
      }
      const dl = FT.el('a', 'btn sm primary', '下载');
      dl.href = `/api/files/${f.id}?dl=1`;
      actions.append(dl);

      row.append(FT.el('div', 'type-tag ' + k.cls, k.label), meta, actions);
      listBox.append(row);
    }
  }

  async function loadFiles() {
    try {
      const q = $('recv-search').value.trim();
      const data = await FT.api('/api/files?q=' + encodeURIComponent(q) + '&limit=200');
      rows = data.rows || [];
      render();
    } catch (e) {
      FT.toast(e.message, true);
    }
  }

  function connectEvents() {
    if (evtSource) evtSource.close();
    evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'new') {
          if (panelReceive.hidden) {
            dot.hidden = false;
            FT.toast(`收到 ${d.count} 个新文件，点「接收文件」查看`);
          } else {
            FT.toast(`收到 ${d.count} 个新文件`);
            loadFiles();
          }
        } else if (d.type === 'delete' && !panelReceive.hidden) {
          loadFiles();
        }
      } catch { /* 忽略非法事件 */ }
    };
  }

  tabSend.onclick = () => showTab('send');
  tabReceive.onclick = () => showTab('receive');
  $('recv-refresh').onclick = () => {
    if (authed) loadFiles(); else FT.toast('请先登录房间', true);
  };
  $('recv-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (authed) loadFiles(); }, 250);
  });

  (async () => {
    if (new URLSearchParams(location.search).get('tab') === 'receive') showTab('receive');
    authed = await FT.ensureAuth();
    if (!authed) return;
    if (!panelReceive.hidden) await loadFiles();
    connectEvents();
  })();
})();
