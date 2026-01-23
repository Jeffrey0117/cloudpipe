# Preview Optimization Spec

## Overview

實現 YouTube/Netflix 級別的影片播放體驗優化：
- 預覽片段秒開
- Hover 動態預覽
- 無縫 HLS 切換

## 1. 預覽片段 (Preview Clip)

### 規格

| 屬性 | 值 |
|------|-----|
| 解析度 | 426x240 (240p) |
| 編碼 | H.264 Baseline Profile |
| 音訊 | AAC 64kbps |
| 長度 | 3-6 秒（依影片長度） |
| 目標大小 | 100-300KB |

### 長度判斷邏輯

```javascript
function getPreviewDuration(videoDuration) {
  if (videoDuration < 10) return 0;      // 不產生預覽
  if (videoDuration < 30) return 3;      // 短影片 3 秒
  return 6;                               // 標準 6 秒
}
```

### 影片長度處理策略

| 影片長度 | 處理方式 |
|---------|---------|
| < 10 秒 | 保留 MP4，不轉 HLS，不產生預覽 |
| 10-30 秒 | 轉 HLS + 預覽 3 秒 |
| > 30 秒 | 轉 HLS + 預覽 6 秒 |

### 檔案結構

```
data/
├── videos/
│   └── {id}.mp4           ← 短影片保留 / 長影片刪除
├── thumbnails/
│   └── {id}.jpg           ← 縮圖 ~50KB
├── previews/              ← 新增
│   └── {id}.mp4           ← 預覽片段 ~200KB
└── hls/
    └── {id}/
        ├── master.m3u8
        ├── 480p/
        ├── 720p/
        └── 1080p/
```

### FFmpeg 指令

```bash
ffmpeg -i input.mp4 \
  -t 6 \                          # 前 6 秒
  -vf "scale=426:240" \           # 240p
  -c:v libx264 \
  -profile:v baseline \           # 最大相容性
  -preset fast \
  -crf 28 \                       # 較高壓縮
  -c:a aac \
  -b:a 64k \                      # 低碼率音訊
  -movflags +faststart \          # 快速啟動
  -y output.mp4
```

## 2. 播放流程

### View 頁完整流程

```
頁面載入
    │
    ▼
┌─────────────────────────────────┐
│ 1. 顯示縮圖 (poster)            │ ← 立即顯示
│    video.poster = thumbnailUrl  │
└────────────────┬────────────────┘
                 │
    ┌────────────┴────────────┐
    │ 用戶點擊播放 / autoplay │
    └────────────┬────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 2. 播放預覽片段                 │ ← 已預載，秒開
│    video.src = previewUrl       │
└────────────────┬────────────────┘
                 │ 同時背景載入 HLS
                 ▼
┌─────────────────────────────────┐
│ 3. HLS 準備好後無縫切換         │
│    - 記錄當前位置/狀態          │
│    - 切換到 HLS                 │
│    - 恢復播放位置               │
└─────────────────────────────────┘
```

### 程式碼結構

```javascript
function initPlayer() {
  const video = document.getElementById('player');

  // 1. 設定縮圖
  video.poster = thumbnailUrl;

  // 2. 預覽片段優先
  if (previewUrl) {
    video.src = previewUrl;
    initPlyr(video);

    // 3. 背景載入 HLS
    if (hlsReady) {
      const hls = new Hls({ /* optimized config */ });
      hls.loadSource(hlsUrl);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // 記錄狀態
        const state = capturePlayerState(video);

        // 切換到 HLS
        hls.attachMedia(video);

        // 恢復狀態
        restorePlayerState(video, state);
      });
    }
  }
}
```

## 3. 預載策略

### 層級

| 層級 | 時機 | 預載內容 | 大小 |
|------|------|---------|------|
| L1 | 進入視窗 | 預覽片段 .mp4 | ~200KB |
| L2 | Hover | HLS m3u8 + 首片段 | ~500KB |
| L3 | 點擊 | 完整播放 | - |

### IntersectionObserver 實作

```javascript
const preloadObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const recordId = entry.target.dataset.id;
      preloadPreview(recordId);
    }
  });
}, {
  rootMargin: '200px'  // 提前 200px 開始預載
});

function preloadPreview(recordId) {
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.href = `/lurl/preview/${recordId}.mp4`;
  document.head.appendChild(link);
}
```

## 4. Hover 動態預覽

### 列表頁行為

```
滑鼠移入卡片
    │
    ▼
┌─────────────────────────────────┐
│ 延遲 300ms 後開始播放           │ ← 避免快速滑過誤觸發
│ 播放預覽片段（無聲、循環）      │
└────────────────┬────────────────┘
                 │
    滑鼠移出
    │
    ▼
┌─────────────────────────────────┐
│ 停止播放，顯示縮圖              │
└─────────────────────────────────┘
```

### 實作

```javascript
let hoverTimeout = null;
let hoverVideo = null;

card.addEventListener('mouseenter', () => {
  hoverTimeout = setTimeout(() => {
    // 建立隱藏的 video 元素
    hoverVideo = document.createElement('video');
    hoverVideo.src = `/lurl/preview/${recordId}.mp4`;
    hoverVideo.muted = true;
    hoverVideo.loop = true;
    hoverVideo.playsInline = true;

    // 替換縮圖
    const img = card.querySelector('img');
    img.style.display = 'none';
    card.querySelector('.thumbnail-container').appendChild(hoverVideo);
    hoverVideo.play();
  }, 300);
});

card.addEventListener('mouseleave', () => {
  clearTimeout(hoverTimeout);
  if (hoverVideo) {
    hoverVideo.remove();
    card.querySelector('img').style.display = '';
    hoverVideo = null;
  }
});
```

## 5. 轉檔流程（修改）

### 流程圖

```
下載完成
    │
    ▼
┌─────────────────┐
│ 取得影片資訊    │
│ (長度、解析度)  │
└────────┬────────┘
         │
    ┌────┴────┐
    │ < 10秒? │
    └────┬────┘
      是 │ 否
    ┌────┘    └────┐
    ▼              ▼
┌─────────┐   ┌─────────────────────┐
│ 保留MP4 │   │ 1. 產生預覽片段     │
│ 標記為  │   │    (240p, 3-6秒)    │
│ 短影片  │   │ 2. 轉 HLS           │
└─────────┘   │ 3. 刪除原始 MP4     │
              └─────────────────────┘
```

### 資料庫欄位（新增）

```javascript
{
  id: 'abc123',
  // ... 現有欄位

  // 新增欄位
  previewPath: 'previews/abc123.mp4',  // 預覽片段路徑
  previewReady: true,                   // 預覽是否就緒
  isShortVideo: false,                  // 是否為短影片（<10秒）
  duration: 125.5                       // 影片長度（秒）
}
```

## 6. API 端點

### 新增端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/lurl/preview/{id}.mp4` | 取得預覽片段 |
| GET | `/lurl/api/preview/{id}` | 取得預覽資訊 |

## 7. 效能指標

### 目標

| 指標 | 目標值 |
|------|--------|
| 首幀顯示 (TTFF) | < 100ms |
| 預覽開始播放 | < 500ms |
| HLS 切換完成 | < 3s |

### 檔案大小預估

| 內容 | 大小 |
|------|------|
| 縮圖 | ~50KB |
| 預覽片段 | ~200KB |
| HLS 全部 | ~150MB |
| **額外空間佔用** | **~0.15%** |
