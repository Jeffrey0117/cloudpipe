# 會員系統規格

## 現狀總覽

### 已實作功能

| 功能 | 路由 | 狀態 |
|------|------|------|
| 登入頁面 | `/lurl/member/login` | ✅ |
| 註冊頁面 | `/lurl/member/register` | ✅ |
| 觀看歷史 | `/lurl/member/history` | ✅ |
| 額度查看 | `/lurl/member/quota` | ✅ |
| 個人資料 | `/lurl/member/profile` | ✅ |
| 收藏夾管理 | `/lurl/member/collections` | ✅ |
| 收藏夾詳情 | `/lurl/member/collections/:id` | ✅ |

### 導航入口
- Browse 頁面導航：⭐ 收藏
- View 頁面導航：⭐ 收藏
- View 頁面：收藏按鈕（actions 區）

## 會員等級

| 等級 | 代碼 | 說明 |
|------|------|------|
| 免費會員 | `free` | 基本功能，收藏功能鎖定 |
| 老司機 | `premium` | 完整功能，收藏功能解鎖 |
| 管理員 | `admin` | 完整功能 + 管理後台 |

## 認證系統

### 雙認證機制
1. **管理員認證** (`lurl_session` cookie)
   - 用管理員密碼登入
   - 可訪問 Browse、View、Admin 頁面
   - 自動獲得 admin 等級的會員權限

2. **會員認證** (`lurl_member_token` JWT)
   - 用 email/密碼登入
   - 訪問會員專區功能

### 權限對照
| 功能 | 未登入 | 免費會員 | 老司機 | 管理員密碼 |
|------|--------|----------|--------|-----------|
| 瀏覽影片 | ❌ | ❌ | ❌ | ✅ |
| 收藏功能 | ❌ | ❌ | ✅ | ✅ |
| 觀看歷史 | ❌ | ✅ | ✅ | ✅ |
| 管理後台 | ❌ | ❌ | ❌ | ✅ |

## 資料結構

### users 表
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  passwordHash TEXT NOT NULL,
  nickname TEXT,
  avatar TEXT,
  tier TEXT DEFAULT 'free',      -- 會員等級
  tierExpiry TEXT,               -- 會員到期時間
  quotaBalance INTEGER DEFAULT 0, -- 額度餘額
  createdAt TEXT,
  lastLoginAt TEXT
)
```

### collections 表（收藏夾）
```sql
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  name TEXT DEFAULT '預設收藏',
  isPrivate INTEGER DEFAULT 1,
  createdAt TEXT
)
```

### collection_items 表（收藏項目）
```sql
CREATE TABLE collection_items (
  id TEXT PRIMARY KEY,
  collectionId TEXT NOT NULL,
  recordId TEXT NOT NULL,
  addedAt TEXT,
  UNIQUE(collectionId, recordId)
)
```

### watch_history 表（觀看歷史）
```sql
CREATE TABLE watch_history (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  recordId TEXT NOT NULL,
  watchedAt TEXT,
  progress INTEGER DEFAULT 0,
  UNIQUE(userId, recordId)
)
```

## 待實作功能

### P0 - 核心功能
- [x] 收藏按鈕（View 頁面）
- [x] 收藏入口（導航欄）
- [x] Admin 認證支援收藏功能

### P1 - 體驗優化
- [ ] Browse 頁面快捷收藏（卡片右上角）
- [ ] 收藏狀態顯示（已收藏標記）
- [ ] 收藏夾封面預覽

### P2 - 社群功能
- [ ] 收藏夾分享（公開/私密）
- [ ] 熱門收藏排行
- [ ] 標籤訂閱通知

## API 端點

### 收藏相關
| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/collections` | 取得收藏夾列表 |
| POST | `/api/collections` | 建立收藏夾 |
| PUT | `/api/collections/:id` | 更新收藏夾 |
| DELETE | `/api/collections/:id` | 刪除收藏夾 |
| GET | `/api/collections/:id/items` | 取得收藏項目 |
| POST | `/api/collections/:id/items` | 加入收藏 |
| DELETE | `/api/collections/:id/items/:recordId` | 移除收藏 |

### 會員相關
| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/auth/register` | 註冊 |
| POST | `/api/auth/login` | 登入 |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 取得當前會員資訊 |
| GET | `/api/member/history` | 觀看歷史 |
| DELETE | `/api/member/history/:id` | 刪除歷史 |
| PATCH | `/api/member/profile` | 更新個人資料 |
| POST | `/api/member/password` | 變更密碼 |
