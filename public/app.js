(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let rows = [];
  let evtSource = null;
  let searchTimer = null;
  let currentMedia = null;

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* 不支持 */ }
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  async function loadConfig(ip) {
    const c = ip
      ? await fetch('/api/config?ip=' + encodeURIComponent(ip), { credentials: 'same-origin' }).then((r) => r.json())
      : await FT.config();
    $('qr').src = c.qr;
    $('lan-url').textContent = c.lanUrl;
    $('room-code').textContent = c.roomCode;
    $('max-size').textContent = c.maxFileMB ? c.maxFileMB + ' MB / 单文件' : '不限';
    $('btn-copy').onclick = () => {
      copyText(c.lanUrl)
        .then(() => FT.toast('已复制手机访问地址'))
        .catch(() => FT.toast('复制失败，请手动选中地址', true));
    };

    const row = $('ip-row');
    const sel = $('ip-select');
    if (c.candidates && c.candidates.length > 1) {
      sel.replaceChildren();
      for (const addr of c.candidates) {
        const o = document.createElement('option');
        o.value = addr;
        o.textContent = addr;
        o.selected = addr === c.currentIp;
        sel.append(o);
      }
      row.style.display = '';
      sel.onchange = () => loadConfig(sel.value);
    } else {
      row.style.display = 'none';
    }
    if (!c.candidates || !c.candidates.length) {
      $('net-hint').textContent = '未检测到局域网网卡：请连上 WiFi，或让电脑开启「移动热点」后重启本程序。';
    }
  }

  async function loadFiles() {
    try {
      const q = $('search').value.trim();
      const data = await FT.api('/api/files?q=' + encodeURIComponent(q) + '&limit=200');
      rows = data.rows || [];
      render();
    } catch (e) {
      FT.toast(e.message, true);
    }
  }

  function placeholder(body, f, msg) {
    const p = FT.el('div', 'placeholder');
    p.append(FT.el('h3', '', f.name), FT.el('p', '', msg));
    const a = FT.el('a', 'btn primary', '下载到本地打开');
    a.href = `/api/files/${f.id}?dl=1`;
    p.append(a);
    body.append(p);
  }

  function closeViewer() {
    $('viewer').classList.remove('open');
    $('viewer-body').replaceChildren();
    if (currentMedia) {
      try { currentMedia.pause(); } catch { /* 非媒体元素 */ }
      currentMedia = null;
    }
  }

  function openViewer(f, kind) {
    const body = $('viewer-body');
    body.replaceChildren();
    $('viewer-name').textContent = f.name;
    $('viewer-download').href = `/api/files/${f.id}?dl=1`;
    $('viewer').classList.add('open');

    const url = `/api/files/${f.id}`;
    if (kind === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.alt = f.name;
      body.append(img);
    } else if (kind === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      currentMedia = video;
      body.append(video);
    } else if (kind === 'audio') {
      const audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      currentMedia = audio;
      body.append(audio);
    } else if (kind === 'pdf') {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.title = f.name;
      body.append(iframe);
    } else if (kind === 'text') {
      if (f.size > 2 * 1024 * 1024) {
        placeholder(body, f, '文件超过 2 MB，不建议在网页中展开');
        return;
      }
      const pre = FT.el('pre', '', '正在加载...');
      body.append(pre);
      fetch(url, { credentials: 'same-origin' })
        .then((r) => { if (!r.ok) throw new Error('读取失败'); return r.text(); })
        .then((t) => { pre.textContent = t; })
        .catch((e) => { pre.textContent = '无法读取：' + e.message; });
    } else {
      placeholder(body, f, '此类型暂不支持网页在线预览');
    }
  }

  function render() {
    const box = $('file-list');
    box.replaceChildren();
    $('count').textContent = `共 ${rows.length} 个文件`;

    if (!rows.length) {
      const empty = FT.el('div', 'empty');
      empty.append(
        FT.el('h3', '', '还没有文件'),
        FT.el('div', '', '用手机扫上方二维码，选择文件后上传即可')
      );
      box.append(empty);
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
      if (k.preview !== 'none') {
        const pv = FT.el('button', 'btn sm primary', '预览');
        pv.onclick = () => openViewer(f, k.preview);
        actions.append(pv);
      }
      const dl = FT.el('a', 'btn sm', '下载');
      dl.href = `/api/files/${f.id}?dl=1`;
      actions.append(dl);
      const del = FT.el('button', 'btn sm danger', '删除');
      del.onclick = () => removeFile(f);
      actions.append(del);

      row.append(FT.el('div', 'type-tag ' + k.cls, k.label), meta, actions);
      box.append(row);
    }
  }

  async function removeFile(f) {
    if (!window.confirm(`确定删除「${f.name}」？此操作不可恢复。`)) return;
    try {
      await FT.api(`/api/files/${f.id}`, { method: 'DELETE' });
      FT.toast('已删除');
      closeViewer();
      await loadFiles();
    } catch (e) {
      FT.toast(e.message, true);
    }
  }

  function connectEvents() {
    if (evtSource) evtSource.close();
    evtSource = new EventSource('/api/events');
    evtSource.onopen = () => {
      $('sse-badge').textContent = '实时同步';
      $('sse-badge').className = 'badge ok';
    };
    evtSource.onerror = () => {
      $('sse-badge').textContent = '重连中';
      $('sse-badge').className = 'badge';
    };
    evtSource.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'new') {
          FT.toast(`收到 ${d.count} 个新文件`);
          loadFiles();
        } else if (d.type === 'delete') {
          loadFiles();
        }
      } catch { /* 忽略非法事件 */ }
    };
  }

  $('btn-refresh').onclick = loadFiles;
  $('viewer-close').onclick = closeViewer;
  $('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) closeViewer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer(); });
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadFiles, 250);
  });
  $('btn-logout').onclick = async () => {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    location.reload();
  };

  (async () => {
    const ok = await FT.ensureAuth();
    if (!ok) return;
    try { await loadConfig(); } catch (e) { FT.toast(e.message, true); }
    await loadFiles();
    connectEvents();
  })();
})();
