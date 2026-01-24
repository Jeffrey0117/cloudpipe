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

  // 執行資料庫遷移（新增狀態欄位等）
  runMigrations();

  // 檢查是否有記錄需要狀態遷移
  checkStatusMigrationNeeded();

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

  // Collections 表（收藏夾）
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT DEFAULT '預設收藏',
      isPrivate INTEGER DEFAULT 1,
      createdAt TEXT
    )
  `);

  // Collection Items 表（收藏項目）
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_items (
      id TEXT PRIMARY KEY,
      collectionId TEXT NOT NULL,
      recordId TEXT NOT NULL,
      addedAt TEXT,
      UNIQUE(collectionId, recordId)
    )
  `);

  // Hidden Records 表（隱藏內容）
  db.exec(`
    CREATE TABLE IF NOT EXISTS hidden_records (
      userId TEXT NOT NULL,
      recordId TEXT NOT NULL,
      hiddenAt TEXT,
      PRIMARY KEY(userId, recordId)
    )
  `);

  // Tag Subscriptions 表（標籤訂閱）
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_subscriptions (
      userId TEXT NOT NULL,
      tag TEXT NOT NULL,
      subscribedAt TEXT,
      PRIMARY KEY(userId, tag)
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
    CREATE INDEX IF NOT EXISTS idx_collections_userId ON collections(userId);
    CREATE INDEX IF NOT EXISTS idx_collection_items_collectionId ON collection_items(collectionId);
    CREATE INDEX IF NOT EXISTS idx_collection_items_recordId ON collection_items(recordId);
    CREATE INDEX IF NOT EXISTS idx_hidden_records_userId ON hidden_records(userId);
    CREATE INDEX IF NOT EXISTS idx_tag_subscriptions_userId ON tag_subscriptions(userId);
  `);

  // Recoveries 表（復原歷史）
  db.exec(`
    CREATE TABLE IF NOT EXISTS recoveries (
      id TEXT PRIMARY KEY,
      visitorId TEXT NOT NULL,
      recordId TEXT NOT NULL,
      recoveredAt TEXT,
      UNIQUE(visitorId, recordId)
    );
    CREATE INDEX IF NOT EXISTS idx_recoveries_visitorId ON recoveries(visitorId);
    CREATE INDEX IF NOT EXISTS idx_recoveries_recordId ON recoveries(recordId);
  `);
}

// 資料庫遷移（新增欄位）
function runMigrations() {
  const migrations = [
    // Records 表狀態欄位
    { table: 'records', column: 'sourceStatus', type: "TEXT DEFAULT 'unknown'" },
    { table: 'records', column: 'sourceCheckedAt', type: 'TEXT' },
    { table: 'records', column: 'downloadStatus', type: "TEXT DEFAULT 'pending'" },
    { table: 'records', column: 'downloadRetries', type: 'INTEGER DEFAULT 0' },
    { table: 'records', column: 'downloadError', type: 'TEXT' },
    { table: 'records', column: 'thumbnailStatus', type: "TEXT DEFAULT 'pending'" },
    { table: 'records', column: 'previewStatus', type: "TEXT DEFAULT 'pending'" },
    { table: 'records', column: 'hlsStatus', type: "TEXT DEFAULT 'pending'" },
    { table: 'records', column: 'originalStatus', type: "TEXT DEFAULT 'missing'" },
    { table: 'records', column: 'lastProcessedAt', type: 'TEXT' },
    { table: 'records', column: 'lastErrorAt', type: 'TEXT' },
    // Quotas 表新增欄位
    { table: 'quotas', column: 'totalRecoveries', type: 'INTEGER DEFAULT 0' },
    { table: 'quotas', column: 'lastRecoveryAt', type: 'TEXT' },
  ];

  for (const { table, column, type } of migrations) {
    try {
      // 檢查欄位是否存在
      const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all();
      const columnExists = tableInfo.some((col) => col.name === column);

      if (!columnExists) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        console.log(`[lurl-db] 新增欄位: ${table}.${column}`);
      }
    } catch (err) {
      // 忽略已存在的欄位錯誤
      if (!err.message.includes('duplicate column')) {
        console.error(`[lurl-db] 遷移失敗 ${table}.${column}:`, err.message);
      }
    }
  }

  // 新增狀態相關索引
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_records_downloadStatus ON records(downloadStatus)',
    'CREATE INDEX IF NOT EXISTS idx_records_hlsStatus ON records(hlsStatus)',
    'CREATE INDEX IF NOT EXISTS idx_records_sourceStatus ON records(sourceStatus)',
    'CREATE INDEX IF NOT EXISTS idx_records_thumbnailStatus ON records(thumbnailStatus)',
    'CREATE INDEX IF NOT EXISTS idx_records_previewStatus ON records(previewStatus)',
    'CREATE INDEX IF NOT EXISTS idx_records_originalStatus ON records(originalStatus)',
  ];

  for (const sql of indexes) {
    try {
      db.exec(sql);
    } catch (err) {
      // 索引可能已存在，忽略
    }
  }
}

// 檢查是否有記錄需要狀態遷移
function checkStatusMigrationNeeded() {
  try {
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM records
      WHERE downloadStatus IS NULL OR downloadStatus = 'pending'
    `).get();

    if (result.count > 0) {
      // 檢查是否有已完成但狀態未設定的記錄
      const completedWithoutStatus = db.prepare(`
        SELECT COUNT(*) as count FROM records
        WHERE downloadStatus IS NULL
          AND (backupPath IS NOT NULL OR hlsReady = 1)
      `).get();

      if (completedWithoutStatus.count > 0) {
        console.warn(`[lurl-db] ⚠️ 發現 ${completedWithoutStatus.count} 筆記錄需要狀態遷移`);
        console.warn('[lurl-db] 請執行 POST /lurl/api/maintenance/migrate 來設定初始狀態');
      }
    }
  } catch (err) {
    // 可能是欄位尚未建立，忽略
  }
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
      tags = ?, hlsReady = ?, hlsPath = ?, metadata = ?,
      sourceStatus = ?, sourceCheckedAt = ?,
      downloadStatus = ?, downloadRetries = ?, downloadError = ?,
      thumbnailStatus = ?, previewStatus = ?, hlsStatus = ?, originalStatus = ?,
      lastProcessedAt = ?, lastErrorAt = ?
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
    JSON.stringify({ votes: merged.votes }),
    merged.sourceStatus || 'unknown',
    merged.sourceCheckedAt || null,
    merged.downloadStatus || 'pending',
    merged.downloadRetries || 0,
    merged.downloadError || null,
    merged.thumbnailStatus || 'pending',
    merged.previewStatus || 'pending',
    merged.hlsStatus || 'pending',
    merged.originalStatus || 'missing',
    merged.lastProcessedAt || null,
    merged.lastErrorAt || null,
    id
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

// 安全的 JSON 解析
function safeJsonParse(str, defaultValue = {}) {
  if (!str) return defaultValue;
  try {
    return JSON.parse(str);
  } catch (e) {
    console.error('[lurl-db] JSON 解析錯誤:', e.message);
    return defaultValue;
  }
}

// Row to Record 轉換
function rowToRecord(row) {
  const metadata = safeJsonParse(row.metadata, {});
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
    tags: safeJsonParse(row.tags, []),
    hlsReady: !!row.hlsReady,
    hlsPath: row.hlsPath,
    votes: metadata.votes || {},
    // 狀態欄位
    sourceStatus: row.sourceStatus || 'unknown',
    sourceCheckedAt: row.sourceCheckedAt,
    downloadStatus: row.downloadStatus || 'pending',
    downloadRetries: row.downloadRetries || 0,
    downloadError: row.downloadError,
    thumbnailStatus: row.thumbnailStatus || 'pending',
    previewStatus: row.previewStatus || 'pending',
    hlsStatus: row.hlsStatus || 'pending',
    originalStatus: row.originalStatus || 'missing',
    lastProcessedAt: row.lastProcessedAt,
    lastErrorAt: row.lastErrorAt,
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
    createdAt: row.createdAt,
    // 新增欄位
    totalRecoveries: row.totalRecoveries || 0,
    lastRecoveryAt: row.lastRecoveryAt,
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

// ==================== Collections CRUD ====================

function getCollections(userId) {
  return db.prepare('SELECT * FROM collections WHERE userId = ? ORDER BY createdAt DESC').all(userId);
}

function getCollection(id) {
  return db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
}

function createCollection(userId, name = '預設收藏', isPrivate = true) {
  const id = require('crypto').randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO collections (id, userId, name, isPrivate, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, name, isPrivate ? 1 : 0, now);
  return { id, userId, name, isPrivate, createdAt: now };
}

function updateCollection(id, updates) {
  const collection = getCollection(id);
  if (!collection) return null;

  const merged = { ...collection, ...updates };
  db.prepare(`
    UPDATE collections SET name = ?, isPrivate = ? WHERE id = ?
  `).run(merged.name, merged.isPrivate ? 1 : 0, id);
  return merged;
}

function deleteCollection(id) {
  // 先刪除收藏項目
  db.prepare('DELETE FROM collection_items WHERE collectionId = ?').run(id);
  // 再刪除收藏夾
  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
}

function getCollectionItems(collectionId, limit = 50, offset = 0) {
  return db.prepare(`
    SELECT ci.*, r.title, r.type, r.thumbnailPath, r.pageUrl
    FROM collection_items ci
    LEFT JOIN records r ON ci.recordId = r.id
    WHERE ci.collectionId = ?
    ORDER BY ci.addedAt DESC
    LIMIT ? OFFSET ?
  `).all(collectionId, limit, offset);
}

function getCollectionItemCount(collectionId) {
  const result = db.prepare('SELECT COUNT(*) as count FROM collection_items WHERE collectionId = ?').get(collectionId);
  return result.count;
}

function addToCollection(collectionId, recordId) {
  const id = `${collectionId}_${recordId}`;
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO collection_items (id, collectionId, recordId, addedAt)
      VALUES (?, ?, ?, ?)
    `).run(id, collectionId, recordId, now);
    return { id, collectionId, recordId, addedAt: now };
  } catch (err) {
    // UNIQUE constraint violation - already exists
    return null;
  }
}

function removeFromCollection(collectionId, recordId) {
  db.prepare('DELETE FROM collection_items WHERE collectionId = ? AND recordId = ?').run(collectionId, recordId);
}

function isInCollection(collectionId, recordId) {
  const item = db.prepare('SELECT 1 FROM collection_items WHERE collectionId = ? AND recordId = ?').get(collectionId, recordId);
  return !!item;
}

function getRecordCollections(userId, recordId) {
  return db.prepare(`
    SELECT c.*,
      CASE WHEN ci.recordId IS NOT NULL THEN 1 ELSE 0 END as hasRecord
    FROM collections c
    LEFT JOIN collection_items ci ON c.id = ci.collectionId AND ci.recordId = ?
    WHERE c.userId = ?
    ORDER BY c.createdAt DESC
  `).all(recordId, userId);
}

// ==================== Hidden Records CRUD ====================

function getHiddenRecords(userId) {
  return db.prepare('SELECT recordId FROM hidden_records WHERE userId = ?').all(userId).map(r => r.recordId);
}

function hideRecord(userId, recordId) {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO hidden_records (userId, recordId, hiddenAt)
      VALUES (?, ?, ?)
    `).run(userId, recordId, now);
    return true;
  } catch (err) {
    return false; // Already hidden
  }
}

function unhideRecord(userId, recordId) {
  db.prepare('DELETE FROM hidden_records WHERE userId = ? AND recordId = ?').run(userId, recordId);
}

function isRecordHidden(userId, recordId) {
  const item = db.prepare('SELECT 1 FROM hidden_records WHERE userId = ? AND recordId = ?').get(userId, recordId);
  return !!item;
}

function clearHiddenRecords(userId) {
  db.prepare('DELETE FROM hidden_records WHERE userId = ?').run(userId);
}

// ==================== Tag Subscriptions CRUD ====================

function getSubscribedTags(userId) {
  return db.prepare('SELECT tag, subscribedAt FROM tag_subscriptions WHERE userId = ? ORDER BY subscribedAt DESC').all(userId);
}

function subscribeTag(userId, tag) {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO tag_subscriptions (userId, tag, subscribedAt)
      VALUES (?, ?, ?)
    `).run(userId, tag, now);
    return true;
  } catch (err) {
    return false; // Already subscribed
  }
}

function unsubscribeTag(userId, tag) {
  db.prepare('DELETE FROM tag_subscriptions WHERE userId = ? AND tag = ?').run(userId, tag);
}

function isTagSubscribed(userId, tag) {
  const item = db.prepare('SELECT 1 FROM tag_subscriptions WHERE userId = ? AND tag = ?').get(userId, tag);
  return !!item;
}

function clearTagSubscriptions(userId) {
  db.prepare('DELETE FROM tag_subscriptions WHERE userId = ?').run(userId);
}

// ==================== Recoveries CRUD ====================

function getRecovery(visitorId, recordId) {
  return db.prepare('SELECT * FROM recoveries WHERE visitorId = ? AND recordId = ?').get(visitorId, recordId);
}

function getRecoveriesByVisitor(visitorId) {
  return db.prepare('SELECT * FROM recoveries WHERE visitorId = ? ORDER BY recoveredAt DESC').all(visitorId);
}

function getRecoveriesByRecord(recordId) {
  return db.prepare('SELECT * FROM recoveries WHERE recordId = ? ORDER BY recoveredAt DESC').all(recordId);
}

function createRecovery(visitorId, recordId) {
  const id = `${visitorId}_${recordId}`;
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO recoveries (id, visitorId, recordId, recoveredAt)
      VALUES (?, ?, ?, ?)
    `).run(id, visitorId, recordId, now);
    return { id, visitorId, recordId, recoveredAt: now };
  } catch (err) {
    // UNIQUE constraint violation - already exists
    return null;
  }
}

function countRecoveriesByVisitor(visitorId) {
  const result = db.prepare('SELECT COUNT(*) as count FROM recoveries WHERE visitorId = ?').get(visitorId);
  return result.count;
}

// ==================== 狀態遷移（從現有資料設定初始狀態） ====================

/**
 * 遷移記錄狀態（根據檔案存在性設定初始狀態）
 * @param {object} checker - RecordChecker 實例
 * @param {object} options - 選項
 * @param {boolean} options.dryRun - 只顯示不更新
 * @param {boolean} options.force - 強制重設所有狀態
 * @returns {object} 遷移統計
 */
function migrateRecordStatuses(checker, options = {}) {
  const { dryRun = false, force = false } = options;
  const records = getAllRecords();
  const stats = {
    total: records.length,
    migrated: 0,
    skipped: 0,
    errors: [],
  };

  console.log(`[lurl-db] 開始狀態遷移 (${records.length} 筆記錄, dryRun=${dryRun}, force=${force})`);

  for (const record of records) {
    try {
      // 如果已有有效狀態且不強制，跳過
      // 未設定狀態（undefined/null）或 pending 狀態都需要遷移
      const hasValidStatus = record.downloadStatus &&
        ['completed', 'failed', 'skipped'].includes(record.downloadStatus);
      if (!force && hasValidStatus) {
        stats.skipped++;
        continue;
      }

      const updates = {};

      // === 下載狀態 ===
      if (checker.hasLocalVideo(record) || checker.hasLocalImage(record)) {
        updates.downloadStatus = 'completed';
        updates.originalStatus = 'exists';
      } else if (record.hlsReady && checker.hasHLS(record)) {
        updates.downloadStatus = 'completed';
        updates.originalStatus = 'cleaned';
      } else if (record.fileUrl) {
        updates.downloadStatus = 'pending';
        updates.originalStatus = 'missing';
      } else {
        // 無 fileUrl，不需要下載
        updates.downloadStatus = 'completed';
        updates.originalStatus = 'missing';
      }

      // === 縮圖狀態 ===
      if (record.type === 'video') {
        if (checker.hasThumbnail(record)) {
          updates.thumbnailStatus = 'completed';
        } else if (updates.downloadStatus === 'completed') {
          updates.thumbnailStatus = 'pending';
        } else {
          updates.thumbnailStatus = 'pending';
        }
      } else {
        updates.thumbnailStatus = 'skipped'; // 圖片不需要縮圖
      }

      // === 預覽狀態 ===
      if (record.type !== 'video') {
        updates.previewStatus = 'skipped';
      } else if (record.isShortVideo || (record.duration && record.duration < 10)) {
        updates.previewStatus = 'skipped';
      } else if (checker.hasPreview(record)) {
        updates.previewStatus = 'completed';
      } else {
        updates.previewStatus = 'pending';
      }

      // === HLS 狀態 ===
      if (record.type !== 'video') {
        updates.hlsStatus = 'skipped';
      } else if (record.isShortVideo || (record.duration && record.duration < 10)) {
        updates.hlsStatus = 'skipped';
      } else if (record.hlsReady && checker.hasHLS(record)) {
        updates.hlsStatus = 'completed';
      } else {
        updates.hlsStatus = 'pending';
      }

      // === 來源狀態 ===
      updates.sourceStatus = 'unknown';

      if (!dryRun) {
        updateRecord(record.id, updates);
      }

      stats.migrated++;

      if (stats.migrated % 100 === 0) {
        console.log(`[lurl-db] 已處理 ${stats.migrated}/${records.length} 筆`);
      }
    } catch (err) {
      stats.errors.push({ id: record.id, error: err.message });
    }
  }

  console.log(`[lurl-db] 狀態遷移完成: 遷移 ${stats.migrated}, 跳過 ${stats.skipped}, 錯誤 ${stats.errors.length}`);
  return stats;
}

// ==================== Records 狀態查詢 ====================

function getRecordsByStatus(statusField, statusValue, limit = 100) {
  const validFields = [
    'downloadStatus', 'thumbnailStatus', 'previewStatus',
    'hlsStatus', 'originalStatus', 'sourceStatus'
  ];
  if (!validFields.includes(statusField)) {
    throw new Error(`Invalid status field: ${statusField}`);
  }
  // Validate and clamp limit
  limit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 100));
  const rows = db.prepare(`
    SELECT * FROM records WHERE ${statusField} = ? ORDER BY capturedAt DESC LIMIT ?
  `).all(statusValue, limit);
  return rows.map(rowToRecord);
}

function getStatusCounts() {
  const downloadCounts = db.prepare(`
    SELECT downloadStatus as status, COUNT(*) as count FROM records GROUP BY downloadStatus
  `).all();

  const thumbnailCounts = db.prepare(`
    SELECT thumbnailStatus as status, COUNT(*) as count FROM records GROUP BY thumbnailStatus
  `).all();

  const previewCounts = db.prepare(`
    SELECT previewStatus as status, COUNT(*) as count FROM records GROUP BY previewStatus
  `).all();

  const hlsCounts = db.prepare(`
    SELECT hlsStatus as status, COUNT(*) as count FROM records GROUP BY hlsStatus
  `).all();

  const originalCounts = db.prepare(`
    SELECT originalStatus as status, COUNT(*) as count FROM records GROUP BY originalStatus
  `).all();

  const sourceCounts = db.prepare(`
    SELECT sourceStatus as status, COUNT(*) as count FROM records GROUP BY sourceStatus
  `).all();

  const toObject = (arr) => arr.reduce((acc, { status, count }) => {
    acc[status || 'null'] = count;
    return acc;
  }, {});

  return {
    download: toObject(downloadCounts),
    thumbnail: toObject(thumbnailCounts),
    preview: toObject(previewCounts),
    hls: toObject(hlsCounts),
    original: toObject(originalCounts),
    source: toObject(sourceCounts),
  };
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
  // Records 狀態查詢
  getRecordsByStatus,
  getStatusCounts,
  migrateRecordStatuses,
  // Quotas
  getAllQuotas,
  getQuota,
  upsertQuota,
  deleteQuota,
  // Recoveries
  getRecovery,
  getRecoveriesByVisitor,
  getRecoveriesByRecord,
  createRecovery,
  countRecoveriesByVisitor,
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
  clearWatchHistory,
  // Collections
  getCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  getCollectionItems,
  getCollectionItemCount,
  addToCollection,
  removeFromCollection,
  isInCollection,
  getRecordCollections,
  // Hidden Records
  getHiddenRecords,
  hideRecord,
  unhideRecord,
  isRecordHidden,
  clearHiddenRecords,
  // Tag Subscriptions
  getSubscribedTags,
  subscribeTag,
  unsubscribeTag,
  isTagSubscribed,
  clearTagSubscriptions
};
