(function () {
  'use strict';

  const FT = {};
  let configCache = null;
  let toastTimer = null;

  FT.config = async function () {
    if (!configCache) {
      const r = await fetch('/api/config', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('无法读取服务配置');
      configCache = await r.json();
    }
    return configCache;
  };

  FT.api = async function (url, opts) {
    const res = await fetch(url, { credentials: 'same-origin', ...(opts || {}) });
    let data = null;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try { data = await res.json(); } catch { /* 忽略非 JSON 响应 */ }
    }
    if (res.status === 401) {
      FT.showLogin();
      throw new Error((data && data.error) || '请先登录');
    }
    if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
    return data;
  };

  FT.showLogin = async function () {
    let mask = document.getElementById('login-mask');
    if (mask) { mask.style.display = 'flex'; return; }

    mask = document.createElement('div');
    mask.id = 'login-mask';
    mask.className = 'mask';
    mask.innerHTML = `
      <form class="panel" id="login-form">
        <h2>连接房间</h2>
        <p class="muted tiny" style="margin:0 0 16px">请输入电脑端显示的房间码与口令</p>
        <label class="field"><span>房间码</span><input type="text" id="login-code" autocomplete="off" required></label>
        <label class="field"><span>口令</span><input type="password" id="login-pin" required></label>
        <div class="err" id="login-err"></div>
        <button type="submit" class="btn primary" style="width:100%">进入</button>
      </form>`;
    document.body.appendChild(mask);

    const form = mask.querySelector('#login-form');
    const err = mask.querySelector('#login-err');
    const pin = mask.querySelector('#login-pin');
    try {
      const c = await FT.config();
      mask.querySelector('#login-code').value = c.roomCode || '';
    } catch { /* 服务不可达时留空 */ }
    pin.focus();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: mask.querySelector('#login-code').value.trim(),
            pin: pin.value,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '登录失败');
        location.reload();
      } catch (e2) {
        err.textContent = e2.message;
        btn.disabled = false;
      }
    });
  };

  FT.ensureAuth = async function () {
    try {
      const r = await fetch('/api/session', { credentials: 'same-origin' }).then((x) => x.json());
      if (r.authed) return true;
    } catch { /* 服务不可达 */ }
    FT.showLogin();
    return false;
  };

  FT.toast = function (msg, isErr) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 2600);
  };

  FT.el = function (tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  FT.fmtSize = function (n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return v.toFixed(v >= 10 ? 1 : 2) + ' ' + units[i];
  };

  FT.fmtDate = function (s) {
    return String(s || '').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$1/$2/$3');
  };

  FT.kind = function (name, mime) {
    const n = String(name || '');
    const ext = n.includes('.') ? n.split('.').pop().toLowerCase() : '';
    if (/^(jpg|jpeg|png|gif|webp|bmp|heic|avif)$/.test(ext)) return { label: 'IMG', cls: 'img', preview: 'image' };
    if (/^(mp4|mkv|mov|avi|webm|m4v|flv)$/.test(ext)) return { label: 'VID', cls: 'video', preview: 'video' };
    if (/^(mp3|m4a|flac|wav|ogg|aac)$/.test(ext)) return { label: 'AUD', cls: 'audio', preview: 'audio' };
    if (ext === 'pdf') return { label: 'PDF', cls: 'pdf', preview: 'pdf' };
    if (/^(txt|md|json|js|ts|css|html|xml|csv|log|ini|yml|yaml|py|java|c|cpp|h|go|rs|sh|bat|sql)$/.test(ext)
        || /^text\//.test(String(mime || ''))) return { label: 'TXT', cls: 'text', preview: 'text' };
    if (/^(doc|docx|xls|xlsx|ppt|pptx)$/.test(ext)) return { label: 'OFF', cls: 'text', preview: 'none' };
    if (/^(zip|rar|7z|tar|gz)$/.test(ext)) return { label: 'ZIP', cls: '', preview: 'none' };
    return { label: 'FILE', cls: '', preview: 'none' };
  };

  window.FT = FT;
})();
