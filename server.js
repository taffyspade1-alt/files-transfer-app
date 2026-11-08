'use strict';

// node:sqlite 需要 Node 22+，用旧版启动时给出可读提示而不是抛模块错误
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`\n需要 Node.js 22 或更高版本（当前 ${process.versions.node}）。`);
  console.error('请到 https://nodejs.org 安装 LTS 版本后重新运行 start.bat。\n');
  process.exit(1);
}

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const cfg = require('./config');
const store = require('./db');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

/* ---------------- 会话：HMAC 签名 Cookie ---------------- */

const COOKIE = 'ft_session';

const b64url = (s) => Buffer.from(s).toString('base64url');
const hmac = (s) => crypto.createHmac('sha256', cfg.SESSION_SECRET).update(s).digest('base64url');

function makeToken(room) {
  const payload = b64url(JSON.stringify({ room, exp: Date.now() + cfg.SESSION_HOURS * 3600e3 }));
  return `${payload}.${hmac(payload)}`;
}

function parseToken(token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const payload = token.slice(0, i);
  const got = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(hmac(payload));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (obj.room !== cfg.ROOM_CODE || !Number.isFinite(obj.exp) || obj.exp < Date.now()) return null;
    return obj;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
      catch { /* 忽略畸形 cookie */ }
    }
  }
  return out;
}

const session = (req) => parseToken(cookies(req)[COOKIE]);

function requireAuth(req, res, next) {
  if (!session(req)) return res.status(401).json({ error: '未登录或登录已过期，请重新输入房间口令' });
  next();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------------- 局域网地址 ---------------- */

function rank(ip) {
  if (ip.startsWith('192.168.')) return 3;
  if (ip.startsWith('10.')) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  return 0;
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vmware|virtualbox|vethernet|wsl|loopback|bluetooth|docker|hyper-v|tap|tun/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254')) continue;
      out.push({ name, address: a.address });
    }
  }
  return out.sort((x, y) => rank(y.address) - rank(x.address));
}

const LAN = lanAddresses();
const LAN_IP = LAN.length ? LAN[0].address : '127.0.0.1';
const BASE = `http://${LAN_IP}:${cfg.PORT}`;

/* ---------------- SSE：新文件实时提醒 ---------------- */

const clients = new Set();
function broadcast(evt) {
  const chunk = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try { res.write(chunk); } catch { clients.delete(res); }
  }
}

/* ---------------- 工具 ---------------- */

const EXTRA_MIME = {
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.pdf': 'application/pdf', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.heic': 'image/heic', '.json': 'application/json',
};
const BLOCKED_INLINE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript)/i;
const BLOCKED_EXT = /\.(html?|svg|xml|js|mjs|xhtml|hta)$/i;

function mimeOf(row) {
  return EXTRA_MIME[path.extname(row.name).toLowerCase()] || String(row.mime || 'application/octet-stream').split(';')[0];
}

function sanitizeName(name) {
  const s = String(name || '').replace(/[\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 200);
  return s || '未命名文件';
}

// busboy 默认按 latin1 解析 filename，中文需回转；前端同时提交 UTF-8 名称清单时以清单为准
function decodeName(raw) {
  const fixed = Buffer.from(raw, 'latin1').toString('utf8');
  return fixed.includes('\uFFFD') ? raw : fixed;
}

function contentDisposition(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function safeDiskPath(diskName) {
  const root = path.resolve(cfg.STORAGE_DIR);
  const full = path.resolve(root, path.basename(String(diskName)));
  return full.startsWith(root + path.sep) ? full : null;
}

function unlinkQuiet(diskName) {
  const p = safeDiskPath(diskName);
  if (p) fs.promises.unlink(p).catch(() => {});
}

function cleanupExpired() {
  if (!cfg.RETAIN_DAYS) return;
  for (const row of store.expiredFiles(cfg.ROOM_CODE, cfg.RETAIN_DAYS)) {
    store.deleteFile(row.id, cfg.ROOM_CODE);
    unlinkQuiet(row.disk_name);
  }
}

/* ---------------- 上传 ---------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, cfg.STORAGE_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: {
    fileSize: cfg.MAX_FILE_MB > 0 ? cfg.MAX_FILE_MB * 1024 * 1024 : Infinity,
    files: 20,
    fields: 5,
  },
});

/* ---------------- 路由：会话与配置 ---------------- */

app.post('/api/login', (req, res) => {
  const { code, pin } = req.body || {};
  if (!safeEqual(code, cfg.ROOM_CODE) || !safeEqual(pin, cfg.ROOM_PIN)) {
    return res.status(401).json({ error: '房间码或口令不正确' });
  }
  const token = encodeURIComponent(makeToken(cfg.ROOM_CODE));
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.SESSION_HOURS * 3600}`);
  res.json({ ok: true, room: cfg.ROOM_CODE });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const s = session(req);
  res.json({ authed: !!s, room: s ? s.room : null });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', async (req, res) => {
  try {
    // 多网卡时前端可切换二维码指向的 IP；仅接受本机真实网卡地址，防参数注入
    const wanted = String(req.query.ip || '');
    const picked = LAN.find((x) => x.address === wanted);
    const ip = picked ? picked.address : LAN_IP;
    const lanUrl = `http://${ip}:${cfg.PORT}/upload`;
    const qr = await QRCode.toDataURL(lanUrl, {
      width: 280, margin: 1, errorCorrectionLevel: 'M',
      color: { dark: '#111827', light: '#ffffff' },
    });
    res.json({
      roomCode: cfg.ROOM_CODE,
      maxFileMB: cfg.MAX_FILE_MB,
      retainDays: cfg.RETAIN_DAYS,
      lanUrl,
      localUrl: `http://127.0.0.1:${cfg.PORT}`,
      currentIp: ip,
      qr,
      authed: !!session(req),
      candidates: LAN.map((x) => x.address),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(': connected\n\n');
  clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已断开 */ } }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

/* ---------------- 路由：文件 ---------------- */

app.get('/api/files', requireAuth, (req, res) => {
  const q = String(req.query.q || '').slice(0, 100);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json(store.listFiles({ q, limit, offset, roomCode: cfg.ROOM_CODE }));
});

app.post('/api/files', requireAuth, (req, res) => {
  upload.array('files', 20)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `单个文件超过 ${cfg.MAX_FILE_MB} MB 上限`
        : err.code === 'LIMIT_FILE_COUNT' ? '一次最多上传 20 个文件' : err.message;
      return res.status(400).json({ error: msg });
    }

    const incoming = req.files || [];
    if (!incoming.length) return res.status(400).json({ error: '没有选择任何文件' });

    let names = [];
    try { names = JSON.parse(req.body?._names || '[]'); } catch { names = []; }
    if (!Array.isArray(names)) names = [];

    const created = [];
    const written = [];
    try {
      for (let i = 0; i < incoming.length; i++) {
        const f = incoming[i];
        const diskName = path.basename(f.filename);
        written.push(diskName);
        created.push(store.insertFile({
          name: sanitizeName(names[i] || decodeName(f.originalname)),
          size: f.size,
          mime: f.mimetype || 'application/octet-stream',
          diskName,
          roomCode: cfg.ROOM_CODE,
        }));
      }
    } catch (e) {
      for (const row of created) store.deleteFile(row.id, cfg.ROOM_CODE);
      for (const d of written) unlinkQuiet(d);
      return res.status(500).json({ error: `保存失败：${e.message}` });
    }

    broadcast({ type: 'new', count: created.length });
    res.status(201).json({ files: created });
  });
});

app.get('/api/files/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '参数错误' });

  const row = store.getFile(id, cfg.ROOM_CODE);
  if (!row) return res.status(404).json({ error: '文件不存在' });

  const filePath = safeDiskPath(row.disk_name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: '文件已丢失' });

  const stat = fs.statSync(filePath);
  const blocked = BLOCKED_INLINE.test(row.mime) || BLOCKED_EXT.test(row.name);
  const inline = req.query.dl !== '1' && !blocked;

  res.setHeader('Content-Type', mimeOf(row));
  res.setHeader('Content-Disposition', contentDisposition(row.name, inline));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  let start = 0;
  let end = stat.size - 1;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    if (m[1] === '' && m[2] !== '') {
      start = Math.max(0, stat.size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), stat.size - 1);
    }
    if (!Number.isFinite(start) || start > end || start >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
  } else {
    res.setHeader('Content-Length', stat.size);
  }

  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  stream.pipe(res);
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: '参数错误' });
  const row = store.deleteFile(id, cfg.ROOM_CODE);
  if (!row) return res.status(404).json({ error: '文件不存在' });
  unlinkQuiet(row.disk_name);
  broadcast({ type: 'delete', id });
  res.json({ ok: true });
});

/* ---------------- 静态页面 ---------------- */

app.get('/upload', (req, res) => res.sendFile(path.join(cfg.PUBLIC_DIR, 'upload.html')));
app.use(express.static(cfg.PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});

/* ---------------- 启动 ---------------- */

cleanupExpired();
setInterval(cleanupExpired, 3600e3).unref();

const server = http.createServer(app);
server.requestTimeout = 0; // 大文件上传不受默认超时限制
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${cfg.PORT} 已被占用：服务很可能已经在运行。`);
    console.error(`直接打开 http://127.0.0.1:${cfg.PORT} 即可使用；如需换端口请修改 .env 里的 PORT。\n`);
  } else {
    console.error('\n启动失败:', err.message, '\n');
  }
  process.exit(1);
});
server.listen(cfg.PORT, cfg.HOST, () => {
  const line = '='.repeat(58);
  console.log(`\n${line}`);
  console.log('  文件传输应用  已启动');
  console.log(line);
  console.log(`  电脑打开 : http://127.0.0.1:${cfg.PORT}`);
  console.log(`  手机打开 : ${BASE}/upload`);
  if (LAN.length > 1) console.log(`  其他网卡 : ${LAN.slice(1).map((x) => x.address).join(', ')}`);
  console.log(`  房间码   : ${cfg.ROOM_CODE}    口令: ${cfg.ROOM_PIN}`);
  console.log(`  文件上限 : ${cfg.MAX_FILE_MB || '不限'} MB   保留: ${cfg.RETAIN_DAYS || '永久'}`);
  console.log('-'.repeat(58));
  console.log('  手机打不开时依次检查：');
  console.log('  1) Windows 防火墙弹窗勾选「专用网络」并允许');
  console.log('  2) 手机与电脑连同一 WiFi，路由器关闭「AP 隔离」');
  console.log('  3) 仍不行：电脑开「移动热点」，手机连该热点');
  console.log(`${line}\n  按 Ctrl+C 停止服务\n`);

  if (cfg.AUTO_OPEN) {
    require('node:child_process').exec(`start "" "http://127.0.0.1:${cfg.PORT}"`);
  }
});

process.on('SIGINT', () => {
  console.log('\n正在停止服务...');
  server.close(() => { store.db.close(); process.exit(0); });
});
