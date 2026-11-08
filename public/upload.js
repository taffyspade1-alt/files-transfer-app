(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fileInput = $('file-input');
  const photoInput = $('photo-input');
  const queue = $('queue');
  const btnUpload = $('btn-upload');
  const status = $('status');
  const bar = $('progress-bar');
  const badge = $('status-badge');
  let pending = [];

  function addFiles(list) {
    for (const f of list) {
      if (pending.some((p) => p.name === f.name && p.size === f.size)) continue;
      pending.push(f);
    }
    renderQueue();
  }

  function renderQueue() {
    queue.replaceChildren();
    pending.forEach((f, i) => {
      const k = FT.kind(f.name, f.type);
      const row = FT.el('div', 'queue-item');
      const meta = FT.el('div', 'file-meta');
      meta.append(
        FT.el('div', 'file-name', f.name),
        FT.el('div', 'file-sub', FT.fmtSize(f.size))
      );
      const rm = FT.el('button', 'rm', '×');
      rm.type = 'button';
      rm.setAttribute('aria-label', '移除');
      rm.onclick = () => { pending.splice(i, 1); renderQueue(); };
      row.append(FT.el('div', 'type-tag ' + k.cls, k.label), meta, rm);
      queue.append(row);
    });
    btnUpload.disabled = pending.length === 0;
    const total = pending.reduce((s, f) => s + f.size, 0);
    status.textContent = pending.length
      ? `已选 ${pending.length} 个文件，共 ${FT.fmtSize(total)}`
      : '选择文件后点击上传';
  }

  function upload() {
    if (!pending.length) return;
    const files = pending.slice();
    btnUpload.disabled = true;
    bar.style.width = '0%';

    const fd = new FormData();
    // 前端提交 UTF-8 文件名清单，绕开 multipart 文件名编码差异
    fd.append('_names', JSON.stringify(files.map((f) => f.name)));
    for (const f of files) fd.append('files', f, f.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = pct + '%';
      status.textContent = `上传中 ${pct}%`;
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* 忽略 */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        bar.style.width = '100%';
        status.textContent = `上传成功，共 ${(data.files || []).length} 个文件`;
        FT.toast('发送成功，同一房间的设备已可查看');
        pending = [];
        renderQueue();
        setTimeout(() => { bar.style.width = '0%'; }, 1200);
      } else if (xhr.status === 401) {
        FT.showLogin();
        status.textContent = '登录已过期，请重新输入口令';
        bar.style.width = '0%';
      } else {
        FT.toast(data.error || `上传失败 (${xhr.status})`, true);
        status.textContent = data.error || '上传失败';
        bar.style.width = '0%';
      }
      btnUpload.disabled = pending.length === 0;
    };
    xhr.onerror = () => {
      FT.toast('网络错误，请确认电脑端服务仍在运行', true);
      status.textContent = '上传失败，请检查网络';
      bar.style.width = '0%';
      btnUpload.disabled = false;
    };
    xhr.send(fd);
  }

  $('pick-box').onclick = () => fileInput.click();
  $('btn-files').onclick = () => fileInput.click();
  $('btn-photo').onclick = () => photoInput.click();
  fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ''; };
  photoInput.onchange = () => { addFiles(photoInput.files); photoInput.value = ''; };
  btnUpload.onclick = upload;

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  (async () => {
    try {
      const c = await FT.config();
      badge.textContent = '房间 ' + c.roomCode;
      badge.className = 'badge ok';
    } catch {
      badge.textContent = '未连接';
    }
    await FT.ensureAuth();
  })();
})();
