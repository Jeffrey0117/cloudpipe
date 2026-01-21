# 樹狀標籤系統 (Tag Tree System)

## 概述

LurlHub 使用階層式標籤系統，支援主標籤和子標籤的樹狀結構。這讓分類更精確，同時保持 UI 簡潔。

## 資料結構

### TAG_TREE 定義

```javascript
const TAG_TREE = {
  '奶子': ['穿衣', '裸體', '大奶', '露點'],  // 主標籤 + 4 個子標籤
  '屁股': [],                                // 只有主標籤（無子標籤）
  '鮑魚': [],
  '全身': [],
  '姿勢': ['女上', '傳教士', '背後'],        // 主標籤 + 3 個子標籤
  '口交': []
};
```

### 儲存格式

標籤以字串陣列儲存在記錄的 `tags` 欄位：

```json
{
  "id": "abc123",
  "title": "範例影片",
  "tags": ["屁股", "奶子:大奶", "姿勢:背後"]
}
```

**規則：**
- 主標籤：直接儲存標籤名稱（如 `"屁股"`）
- 子標籤：使用 `主標籤:子標籤` 格式（如 `"奶子:大奶"`）

## UI 行為

### 主標籤（無子標籤）

```
[屁股] [鮑魚] [全身] [口交]
   ↑
  點擊直接切換 active 狀態
```

### 主標籤（有子標籤）

```
[奶子 ▾]  ← 點擊展開 popover
    ┌─────────────────┐
    │ [穿衣] [裸體]   │
    │ [大奶] [露點]   │
    └─────────────────┘
         ↑
       點擊選擇子標籤
```

### 狀態判斷

```javascript
function hasMainTag(tags, mainTag) {
  // 檢查是否有該主標籤或其任何子標籤
  return tags.some(t => t === mainTag || t.startsWith(mainTag + ':'));
}
```

- `["屁股"]` → `hasMainTag(tags, "屁股")` = true
- `["奶子:大奶"]` → `hasMainTag(tags, "奶子")` = true
- `["姿勢:背後"]` → `hasMainTag(tags, "屁股")` = false

## 實作細節

### 前端渲染邏輯

```javascript
MAIN_TAGS.forEach(mainTag => {
  const isActive = hasMainTag(currentTags, mainTag);
  const subTags = TAG_TREE[mainTag];
  const hasSubTags = subTags.length > 0;

  if (hasSubTags) {
    // 有子標籤：顯示帶 ▾ 的按鈕，點擊展開 popover
    html += `<span class="tag ${isActive ? 'active' : ''}"
              onclick="togglePopover('${mainTag}')">${mainTag} ▾</span>`;

    if (isExpanded) {
      // 展開時顯示子標籤 popover
      html += '<div class="tag-popover">';
      subTags.forEach(sub => {
        const fullTag = mainTag + ':' + sub;
        const isSubActive = currentTags.includes(fullTag);
        html += `<span class="tag sub ${isSubActive ? 'active' : ''}"
                  onclick="toggleTag('${fullTag}')">${sub}</span>`;
      });
      html += '</div>';
    }
  } else {
    // 無子標籤：直接點擊切換
    html += `<span class="tag ${isActive ? 'active' : ''}"
              onclick="toggleTag('${mainTag}')">${mainTag}</span>`;
  }
});
```

### Popover 展開/收合

```javascript
let expandedTag = null;

function togglePopover(mainTag) {
  expandedTag = (expandedTag === mainTag) ? null : mainTag;
  renderTags();
}

// 點擊外部自動關閉
document.addEventListener('click', (e) => {
  if (expandedTag && !e.target.closest('.tag-group')) {
    expandedTag = null;
    renderTags();
  }
});
```

### 標籤切換 API

```javascript
async function toggleTag(tag) {
  const newTags = currentTags.includes(tag)
    ? currentTags.filter(t => t !== tag)  // 移除
    : [...currentTags, tag];               // 新增

  await fetch(`/lurl/api/records/${recordId}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: newTags })
  });
}
```

## CSS 樣式

```css
/* 主標籤 */
.tag {
  padding: 6px 14px;
  border-radius: 16px;
  background: #2a2a2a;
  color: #888;
  border: 1px solid #333;
  cursor: pointer;
}
.tag:hover { background: #333; color: #ccc; }
.tag.active { background: #ec4899; color: white; border-color: #ec4899; }

/* 子標籤 popover */
.tag-popover {
  position: absolute;
  top: 100%;
  left: 0;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  padding: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 140px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}

/* 子標籤按鈕 */
.tag-popover .tag.sub {
  font-size: 0.8em;
  padding: 6px 12px;
  background: #2a2a2a;
}
.tag-popover .tag.sub.active {
  background: #be185d;
  border-color: #be185d;
}
```

## 瀏覽頁篩選

瀏覽頁也支援樹狀標籤篩選：

```javascript
// 篩選邏輯
function filterByTag(records, selectedTags) {
  if (selectedTags.length === 0) return records;

  return records.filter(record => {
    return selectedTags.some(selectedTag => {
      // 檢查主標籤或子標籤是否匹配
      return record.tags?.some(t =>
        t === selectedTag || t.startsWith(selectedTag + ':')
      );
    });
  });
}
```

## 擴展性

### 新增主標籤

```javascript
const TAG_TREE = {
  // 現有標籤...
  '新主標籤': [],  // 無子標籤
};
```

### 新增子標籤

```javascript
const TAG_TREE = {
  // 現有標籤...
  '新主標籤': ['子項1', '子項2', '子項3'],
};
```

### API 端點

```
GET  /lurl/api/tags          → { tagTree: {...}, mainTags: [...] }
PATCH /lurl/api/records/:id/tags → { tags: [...] }
```

## 優勢

1. **UI 簡潔** - 主標籤不多，子標籤按需展開
2. **精確分類** - 子標籤提供更細的分類
3. **向後相容** - 舊資料的單一標籤仍然有效
4. **易於擴展** - 只需修改 TAG_TREE 物件
5. **一致性** - 所有頁面（view/browse/admin）使用相同結構
