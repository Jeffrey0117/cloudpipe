/**
 * LurlHub SQLite Database Module
 *
 * 用 better-sqlite3 取代 JSONL 檔案儲存
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 資料庫路徑
const DATA_DIR = path.join(__dirname, '../data/lurl');
const DB_PATH = path.join(DATA_DIR, 'lurl.db');

// 舊的 JSONL 檔案路徑（用於遷移）
const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl');
const QUOTAS_FILE = path.join(DATA_DIR, 'quotas.jsonl');

let db = null;

// 初始化資料庫
function init() {
  if (db) return db;

  // 確保目錄存在
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);

  // 啟用 WAL 模式（更好的並發性能）
  db.pragma('journal_mode = WAL');

  // 建立表格
  createTables();

  // 檢查是否需要遷移
  migrateFromJsonl();

  console.log('[lurl-db] SQLite 資料庫已初始化');
  return db;
}

// 建立表格
function createTables() {
  // Records 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      pageUrl TEXT,
      fileUrl TEXT,
      backupPath TEXT,
      thumbnailPath TEXT,
      capturedAt TEXT,
      blocked INTEGER DEFAULT 0,
      rating TEXT,
      likeCount INTEGER DEFAULT 0,
      dislikeCount INTEGER DEFAULT 0,
      tags TEXT,
      hlsReady INTEGER DEFAULT 0,
      hlsPath TEXT,
      metadata TEXT
    )
  `);

  // Quotas 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS quotas (
      visitorId TEXT PRIMARY KEY,
      usedCount INTEGER DEFAULT 0,
      freeQuota INTEGER DEFAULT 3,
      bonusQuota INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      note TEXT,
      lastUsed TEXT,
      history TEXT,
      device TEXT,
      contribution TEXT,
      createdAt TEXT
    )
  `);

  // Users 表（會員系統）
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      nickname TEXT,
      avatar TEXT,
      tier TEXT DEFAULT 'free',
      tierExpiry TEXT,
      quotaBalance INTEGER DEFAULT 0,
      createdAt TEXT,
      lastLoginAt TEXT
    )
  `);

  // Watch History 表（觀看歷史）
  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_history (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      recordId TEXT NOT NULL,
      watchedAt TEXT,
      progress INTEGER DEFAULT 0,
      UNIQUE(userId, recordId)
    )
  `);

  // 建立索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
    CREATE INDEX IF NOT EXISTS idx_records_blocked ON records(blocked);
    CREATE INDEX IF NOT EXISTS idx_records_capturedAt ON records(capturedAt);
    CREATE INDEX IF NOT EXISTS idx_quotas_status ON quotas(status);
    CREATE INDEX IF NOT EXISTS idx_quotas_lastUsed ON quotas(lastUsed);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);
    CREATE INDEX IF NOT EXISTS idx_watch_history_userId ON watch_history(userId);
    CREATE INDEX IF NOT EXISTS idx_watch_history_watchedAt ON watch_history(watchedAt);
  `);
}

// 從 JSONL 遷移資料
function migrateFromJsonl() {
  const recordCount = db.prepare('SELECT COUNT(*) as count FROM records').get().count;
  const quotaCount = db.prepare('SELECT COUNT(*) as count FROM quotas').get().count;

  // 如果資料庫已有資料，跳過遷移
  if (recordCount > 0 || quotaCount > 0) {
    return;
  }

  console.log('[lurl-db] 開始從 JSONL 遷移資料...');

  // 遷移 Records
  if (fs.existsSync(RECORDS_FILE)) {
    const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(Boolean);
    const insertRecord = db.prepare(`
      INSERT OR REPLACE INTO records
      (id, type, title, pageUrl, fileUrl, backupPath, thumbnailPath, capturedAt, blocked, rating, likeCount, dislikeCount, tags, hlsReady, hlsPath, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((records) => {
      for (const r of records) {
        insertRecord.run(
          r.id,
          r.type,
          r.title,
          r.pageUrl,
          r.fileUrl,
          r.backupPath,
          r.thumbnailPath,
          r.capturedAt,
          r.blocked ? 1 : 0,
          r.rating,
          r.likeCount || 0,
          r.dislikeCount || 0,
          JSON.stringify(r.tags || []),
          r.hlsReady ? 1 : 0,
          r.hlsPath,
          JSON.stringify({ votes: r.votes })
        );
      }
    });

    const records = lines.map(line => JSON.parse(line));
    insertMany(records);
    console.log(`[lurl-db] 遷移了 ${records.length} 筆 records`);
  }

  // 遷移 Quotas
  if (fs.existsSync(QUOTAS_FILE)) {
    const lines = fs.readFileSync(QUOTAS_FILE, 'utf8').split('\n').filter(Boolean);
    const insertQuota = db.prepare(`
      INSERT OR REPLACE INTO quotas
      (visitorId, usedCount, freeQuota, bonusQuota, status, note, lastUsed, history, device, contribution, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((quotas) => {
      for (const q of quotas) {
        insertQuota.run(
          q.visitorId,
          q.usedCount || 0,
          q.freeQuota ?? 3,
          q.bonusQuota || 0,
          q.status || 'active',
          q.note || '',
          q.lastUsed,
          JSON.stringify(q.history || []),
          JSON.stringify(q.device || null),
          JSON.stringify(q.contribution || null),
          q.createdAt
        );
      }
    });

    const quotas = lines.map(line => JSON.parse(line));
    insertMany(quotas);
    console.log(`[lurl-db] 遷移了 ${quotas.length} 筆 quotas`);
  }

  console.log('[lurl-db] 遷移完成');
}

// ==================== Records CRUD ====================

function getAllRecords() {
  const rows = db.prepare('SELECT * FROM records ORDER BY capturedAt DESC').all();
  return rows.map(rowToRecord);
}

function getRecord(id) {
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  return row ? rowToRecord(row) : null;
}

function insertRecord(record) {
  const stmt = db.prepare(`
    INSERT INTO records
    (id, type, title, pageUrl, fileUrl, backupPath, thumbnailPath, capturedAt, blocked, rating, likeCount, dislikeCount, tags, hlsReady, hlsPath, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.id,
    record.type,
    record.title,
    record.pageUrl,
    record.fileUrl,
    record.backupPath,
    record.thumbnailPath,
    record.capturedAt,
    record.blocked ? 1 : 0,
    record.rating,
    record.likeCount || 0,
    record.dislikeCount || 0,
    JSON.stringify(record.tags || []),
    record.hlsReady ? 1 : 0,
    record.hlsPath,
    JSON.stringify({ votes: record.votes })
  );
  return record;
}

function updateRecord(id, updates) {
  const record = getRecord(id);
  if (!record) return null;

  const merged = { ...record, ...updates };
  const stmt = db.prepare(`
    UPDATE records SET
      type = ?, title = ?, pageUrl = ?, fileUrl = ?, backupPath = ?, thumbnailPath = ?,
      capturedAt = ?, blocked = ?, rating = ?, likeCount = ?, dislikeCount = ?,
      tags = ?, hlsReady = ?, hlsPath = ?, metadata = ?
    WHERE id = ?
  `);
  stmt.run(
    merged.type,
    merged.title,
    merged.pageUrl,
    merged.fileUrl,
    merged.backupPath,
    merged.thumbnailPath,
    merged.capturedAt,
    merged.blocked ? 1 : 0,
    merged.rating,
    merged.likeCount || 0,
    merged.dislikeCount || 0,
    JSON.stringify(merged.tags || []),
    merged.hlsReady ? 1 : 0,
    merged.hlsPath,
    JSON.stringify({ votes: merged.votes })
  );
  return merged;
}

function deleteRecord(id) {
  db.prepare('DELETE FROM records WHERE id = ?').run(id);
}

function findRecordByUrl(pageUrl) {
  const row = db.prepare('SELECT * FROM records WHERE pageUrl = ?').get(pageUrl);
  return row ? rowToRecord(row) : null;
}

function findRecordByFileUrl(fileUrl) {
  const row = db.prepare('SELECT * FROM records WHERE fileUrl = ?').get(fileUrl);
  return row ? rowToRecord(row) : null;
}

// Row to Record 轉換
function rowToRecord(row) {
  const metadata = row.metadata ? JSON.parse(row.metadata) : {};
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    pageUrl: row.pageUrl,
    fileUrl: row.fileUrl,
    backupPath: row.backupPath,
    thumbnailPath: row.thumbnailPath,
    capturedAt: row.capturedAt,
    blocked: !!row.blocked,
    rating: row.rating,
    likeCount: row.likeCount,
    dislikeCount: row.dislikeCount,
    tags: row.tags ? JSON.parse(row.tags) : [],
    hlsReady: !!row.hlsReady,
    hlsPath: row.hlsPath,
    votes: metadata.votes || {}
  };
}

// ==================== Quotas CRUD ====================

function getAllQuotas() {
  const rows = db.prepare('SELECT * FROM quotas ORDER BY lastUsed DESC').all();
  return rows.map(rowToQuota);
}

function getQuota(visitorId) {
  const row = db.prepare('SELECT * FROM quotas WHERE visitorId = ?').get(visitorId);
  return row ? rowToQuota(row) : null;
}

function upsertQuota(quota) {
  const stmt = db.prepare(`
    INSERT INTO quotas
    (visitorId, usedCount, freeQuota, bonusQuota, status, note, lastUsed, history, device, contribution, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(visitorId) DO UPDATE SET
      usedCount = excluded.usedCount,
      freeQuota = excluded.freeQuota,
      bonusQuota = excluded.bonusQuota,
      status = excluded.status,
      note = excluded.note,
      lastUsed = excluded.lastUsed,
      history = excluded.history,
      device = excluded.device,
      contribution = excluded.contribution
  `);
  stmt.run(
    quota.visitorId,
    quota.usedCount || 0,
    quota.freeQuota ?? 3,
    quota.bonusQuota || 0,
    quota.status || 'active',
    quota.note || '',
    quota.lastUsed,
    JSON.stringify(quota.history || []),
    JSON.stringify(quota.device || null),
    JSON.stringify(quota.contribution || null),
    quota.createdAt || new Date().toISOString()
  );
  return quota;
}

function deleteQuota(visitorId) {
  db.prepare('DELETE FROM quotas WHERE visitorId = ?').run(visitorId);
}

// Row to Quota 轉換
function rowToQuota(row) {
  return {
    visitorId: row.visitorId,
    usedCount: row.usedCount,
    freeQuota: row.freeQuota,
    bonusQuota: row.bonusQuota,
    status: row.status,
    note: row.note,
    lastUsed: row.lastUsed,
    history: row.history ? JSON.parse(row.history) : [],
    device: row.device ? JSON.parse(row.device) : null,
    contribution: row.contribution ? JSON.parse(row.contribution) : null,
    createdAt: row.createdAt
  };
}

// ==================== Users CRUD ====================

function getAllUsers() {
  const rows = db.prepare('SELECT * FROM users ORDER BY createdAt DESC').all();
  return rows;
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function createUser(user) {
  const stmt = db.prepare(`
    INSERT INTO users (id, email, passwordHash, nickname, avatar, tier, tierExpiry, quotaBalance, createdAt, lastLoginAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    user.id,
    user.email,
    user.passwordHash,
    user.nickname || null,
    user.avatar || null,
    user.tier || 'free',
    user.tierExpiry || null,
    user.quotaBalance || 0,
    user.createdAt || new Date().toISOString(),
    user.lastLoginAt || null
  );
  return user;
}

function updateUser(id, updates) {
  const user = getUser(id);
  if (!user) return null;

  const merged = { ...user, ...updates };
  const stmt = db.prepare(`
    UPDATE users SET
      email = ?, passwordHash = ?, nickname = ?, avatar = ?,
      tier = ?, tierExpiry = ?, quotaBalance = ?, lastLoginAt = ?
    WHERE id = ?
  `);
  stmt.run(
    merged.email,
    merged.passwordHash,
    merged.nickname,
    merged.avatar,
    merged.tier,
    merged.tierExpiry,
    merged.quotaBalance,
    merged.lastLoginAt,
    id
  );
  return merged;
}

function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ==================== Watch History CRUD ====================

function getWatchHistory(userId, limit = 50, offset = 0) {
  const rows = db.prepare(`
    SELECT wh.*, r.title, r.type, r.thumbnailPath, r.pageUrl
    FROM watch_history wh
    LEFT JOIN records r ON wh.recordId = r.id
    WHERE wh.userId = ?
    ORDER BY wh.watchedAt DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
  return rows;
}

function getWatchHistoryCount(userId) {
  const result = db.prepare('SELECT COUNT(*) as count FROM watch_history WHERE userId = ?').get(userId);
  return result.count;
}

function getWatchHistoryItem(userId, recordId) {
  return db.prepare('SELECT * FROM watch_history WHERE userId = ? AND recordId = ?').get(userId, recordId);
}

function upsertWatchHistory(userId, recordId, progress = 0) {
  const id = `${userId}_${recordId}`;
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO watch_history (id, userId, recordId, watchedAt, progress)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(userId, recordId) DO UPDATE SET
      watchedAt = excluded.watchedAt,
      progress = excluded.progress
  `);
  stmt.run(id, userId, recordId, now, progress);
  return { id, userId, recordId, watchedAt: now, progress };
}

function deleteWatchHistoryItem(userId, recordId) {
  db.prepare('DELETE FROM watch_history WHERE userId = ? AND recordId = ?').run(userId, recordId);
}

function clearWatchHistory(userId) {
  db.prepare('DELETE FROM watch_history WHERE userId = ?').run(userId);
}

// ==================== 關閉資料庫 ====================

function close() {
  if (db) {
    db.close();
    db = null;
    console.log('[lurl-db] 資料庫已關閉');
  }
}

// 確保程序退出時關閉資料庫
process.on('exit', close);
process.on('SIGINT', () => { close(); process.exit(); });
process.on('SIGTERM', () => { close(); process.exit(); });

module.exports = {
  init,
  close,
  // Records
  getAllRecords,
  getRecord,
  insertRecord,
  updateRecord,
  deleteRecord,
  findRecordByUrl,
  findRecordByFileUrl,
  // Quotas
  getAllQuotas,
  getQuota,
  upsertQuota,
  deleteQuota,
  // Users
  getAllUsers,
  getUser,
  getUserByEmail,
  createUser,
  updateUser,
  deleteUser,
  // Watch History
  getWatchHistory,
  getWatchHistoryCount,
  getWatchHistoryItem,
  upsertWatchHistory,
  deleteWatchHistoryItem,
  clearWatchHistory
};
