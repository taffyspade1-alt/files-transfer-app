'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STORAGE_DIR = path.join(ROOT, 'storage');
const PUBLIC_DIR = path.join(ROOT, 'public');

function readEnv() {
  const file = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.endsWith(q)) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

// 配置一律以 .env 为准，避免同名系统环境变量意外覆盖房间口令等关键项。
// 仅启动开关与会话密钥允许进程环境覆盖：start.bat 用 AUTO_OPEN=1 自动打开浏览器。
const env = readEnv();
for (const k of ['AUTO_OPEN', 'SESSION_SECRET']) {
  if (process.env[k] !== undefined) env[k] = process.env[k];
}

function loadSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const keyFile = path.join(DATA_DIR, 'session.key');
  if (fs.existsSync(keyFile)) {
    const saved = fs.readFileSync(keyFile, 'utf8').trim();
    if (saved) return saved;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, secret, { mode: 0o600 });
  return secret;
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

module.exports = {
  ROOT,
  DATA_DIR,
  STORAGE_DIR,
  PUBLIC_DIR,
  HOST: env.HOST || '0.0.0.0',
  PORT: num(env.PORT, 8787) || 8787,
  ROOM_CODE: env.ROOM_CODE || 'home',
  ROOM_PIN: env.ROOM_PIN || '123456',
  MAX_FILE_MB: num(env.MAX_FILE_MB, 2048),
  RETAIN_DAYS: num(env.RETAIN_DAYS, 0),
  SESSION_HOURS: num(env.SESSION_HOURS, 168) || 168,
  AUTO_OPEN: env.AUTO_OPEN === '1',
  SESSION_SECRET: loadSecret(),
};
