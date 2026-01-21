# HLS 串流架構 (HTTP Live Streaming)

## 為什麼需要 HLS？

### 傳統大檔案傳輸的問題
- 192MB 影片透過 Cloudflare Tunnel 容易斷線、超時
- 斷線後需要重新下載整個檔案
- 網路慢的用戶體驗差
- 快轉時需要等待整個檔案下載

### HLS 的解決方案
將影片切成小片段（通常 6 秒，約 2-5MB），搭配播放清單 (.m3u8) 管理。

```
原始影片 192MB
    ↓ ffmpeg 轉檔 + 切片

每個片段只有 2-5MB，請求快速完成，不會超時
```

## 架構設計

### 檔案結構
```
data/lurl/hls/
└── {record_id}/
    ├── master.m3u8           # 主播放清單（指向各畫質）
    ├── 1080p/
    │   ├── playlist.m3u8     # 1080p 播放清單
    │   ├── segment000.ts     # 6秒片段
    │   ├── segment001.ts
    │   └── ...
    ├── 720p/
    │   ├── playlist.m3u8
    │   └── segment*.ts
    └── 480p/
        ├── playlist.m3u8
        └── segment*.ts
```

### master.m3u8 範例
```m3u8
#EXTM3U
#EXT-X-VERSION:3

#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,NAME="1080p"
1080p/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,NAME="720p"
720p/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480,NAME="480p"
480p/playlist.m3u8
```

### playlist.m3u8 範例 (每個畫質一個)
```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD

#EXTINF:6.000,
segment000.ts
#EXTINF:6.000,
segment001.ts
#EXTINF:6.000,
segment002.ts
#EXTINF:4.500,
segment003.ts

#EXT-X-ENDLIST
```

## 轉檔指令

### ffmpeg 一次產生多畫質 HLS
```bash
ffmpeg -i input.mp4 \
  -filter_complex "[0:v]split=3[v1][v2][v3]; \
    [v1]scale=1920:1080[v1out]; \
    [v2]scale=1280:720[v2out]; \
    [v3]scale=854:480[v3out]" \
  -map "[v1out]" -map 0:a -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k \
    -hls_time 6 -hls_list_size 0 -hls_segment_filename "1080p/segment%03d.ts" 1080p/playlist.m3u8 \
  -map "[v2out]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k \
    -hls_time 6 -hls_list_size 0 -hls_segment_filename "720p/segment%03d.ts" 720p/playlist.m3u8 \
  -map "[v3out]" -map 0:a -c:v libx264 -preset fast -crf 24 -c:a aac -b:a 96k \
    -hls_time 6 -hls_list_size 0 -hls_segment_filename "480p/segment%03d.ts" 480p/playlist.m3u8
```

### 簡化版（分開執行）
```bash
# 1080p
ffmpeg -i input.mp4 -vf scale=1920:1080 -c:v libx264 -preset fast -crf 22 \
  -c:a aac -b:a 192k -hls_time 6 -hls_list_size 0 \
  -hls_segment_filename "1080p/segment%03d.ts" 1080p/playlist.m3u8

# 720p
ffmpeg -i input.mp4 -vf scale=1280:720 -c:v libx264 -preset fast -crf 23 \
  -c:a aac -b:a 128k -hls_time 6 -hls_list_size 0 \
  -hls_segment_filename "720p/segment%03d.ts" 720p/playlist.m3u8

# 480p
ffmpeg -i input.mp4 -vf scale=854:480 -c:v libx264 -preset fast -crf 24 \
  -c:a aac -b:a 96k -hls_time 6 -hls_list_size 0 \
  -hls_segment_filename "480p/segment%03d.ts" 480p/playlist.m3u8
```

## 前端播放

### hls.js 整合
```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<video id="player"></video>
<script>
  const video = document.getElementById('player');
  const hlsUrl = '/lurl/hls/{record_id}/master.m3u8';

  if (Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);

    // 畫質切換
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      console.log('可用畫質:', hls.levels);
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari 原生支援
    video.src = hlsUrl;
  }
</script>
```

### Plyr + hls.js 整合
```javascript
const hls = new Hls();
hls.loadSource(hlsUrl);
hls.attachMedia(video);

hls.on(Hls.Events.MANIFEST_PARSED, () => {
  const player = new Plyr(video, {
    quality: {
      default: 720,
      options: [1080, 720, 480],
      forced: true,
      onChange: (quality) => {
        hls.levels.forEach((level, index) => {
          if (level.height === quality) {
            hls.currentLevel = index;
          }
        });
      }
    }
  });
});
```

## 優勢總結

| 項目 | 傳統 MP4 | HLS 串流 |
|------|----------|----------|
| 檔案大小 | 192MB 一次傳 | 2-5MB 小片段 |
| 斷線重傳 | 整個重來 | 只重傳失敗片段 |
| 網路適應 | 固定畫質 | 自動切換畫質 |
| 快轉體驗 | 等待緩衝 | 立即跳轉 |
| Tunnel 負擔 | 長時間大連線 | 短小請求 |
| CDN 快取 | 整個檔案 | 片段級快取 |

## 安全性附加好處

- .ts 片段檔名隨機，難以直接下載
- 可加入加密 (AES-128)
- 可設定 token 驗證
- 原始檔案不直接暴露

## 實作檢查清單

- [ ] 安裝 ffmpeg
- [ ] 建立 HLS 轉檔函數
- [ ] 背景轉檔佇列
- [ ] 建立 /lurl/hls/ 路由
- [ ] 前端 hls.js 整合
- [ ] Plyr 畫質選擇器
- [ ] 轉檔進度顯示
- [ ] 舊影片批次轉檔工具
