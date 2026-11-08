'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
fs.mkdirSync(cfg.STORAGE_DIR, { recursive: true });

const db = new DatabaseSync(path.join(cfg.DATA_DIR, 'files.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    mime        TEXT    NOT NULL DEFAULT 'application/octet-stream',
    disk_name   TEXT    NOT NULL UNIQUE,
    room_code   TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at DESC, id DESC);
`);

const S_INSERT = db.prepare(
  'INSERT INTO files (name, size, mime, disk_name, room_code) VALUES (?, ?, ?, ?, ?)'
);
const S_GET = db.prepare('SELECT * FROM files WHERE id = ? AND room_code = ?');
const S_DELETE = db.prepare('DELETE FROM files WHERE id = ? AND room_code = ?');
const S_LIST = db.prepare(`
  SELECT id, name, size, mime, created_at FROM files
  WHERE room_code = ? AND instr(lower(name), lower(?)) > 0
  ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
`);
const S_COUNT = db.prepare(
  'SELECT COUNT(*) AS n FROM files WHERE room_code = ? AND instr(lower(name), lower(?)) > 0'
);
const S_EXPIRED = db.prepare(
  "SELECT id, disk_name FROM files WHERE room_code = ? AND created_at < datetime('now','localtime', ?)"
);

function insertFile({ name, size, mime, diskName, roomCode }) {
  const r = S_INSERT.run(name, size, mime, diskName, roomCode);
  return getFile(Number(r.lastInsertRowid), roomCode);
}

function getFile(id, roomCode) {
  return S_GET.get(id, roomCode) || null;
}

function listFiles({ q = '', limit = 100, offset = 0, roomCode }) {
  const rows = S_LIST.all(roomCode, q, limit, offset);
  const total = S_COUNT.get(roomCode, q).n;
  return { rows, total };
}

function deleteFile(id, roomCode) {
  const row = getFile(id, roomCode);
  if (!row) return null;
  S_DELETE.run(id, roomCode);
  return row;
}

function expiredFiles(roomCode, days) {
  return S_EXPIRED.all(roomCode, `-${Math.trunc(days)} days`);
}

module.exports = { db, insertFile, getFile, listFiles, deleteFile, expiredFiles };
