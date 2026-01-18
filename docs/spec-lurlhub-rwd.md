# LurlHub RWD 響應式設計規格

## 概述
為 LurlHub 的所有頁面實作響應式設計，確保在手機、平板、桌面都有良好體驗。

## 斷點定義
| 名稱 | 寬度範圍 | 目標裝置 |
|------|----------|----------|
| Mobile | < 480px | 手機直立 |
| Mobile Landscape | 480px - 767px | 手機橫向 |
| Tablet | 768px - 1023px | 平板 |
| Desktop | >= 1024px | 桌電/筆電 |

---

## 頁面清單

### 1. Browse 頁面 (`/lurl/browse`)

#### Header
| 元素 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| Logo | 36px | 32px | 28px |
| 標題字體 | 1.3em | 1.2em | 1em |
| Nav 連結 | 水平排列 | 水平排列 | 隱藏或漢堡選單 |
| Header padding | 15px 20px | 12px 16px | 10px 12px |

#### Search Bar
| 元素 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| 寬度 | 100% (max 600px) | 100% | 100% |
| 高度 | auto | auto | 44px (觸控友善) |
| 字體大小 | 1em | 1em | 16px (防止 iOS 縮放) |

#### Filter Bar (Tabs)
| 元素 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| 排列 | 水平 + result-count 靠右 | 水平 | 水平捲動 |
| Tab padding | 8px 16px | 8px 12px | 6px 10px |
| Result count | 同行靠右 | 同行靠右 | 換行置中 |

#### Grid 卡片
| 元素 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| 欄數 | 4 欄 | 3 欄 | 2 欄 |
| 最小卡片寬 | 280px | 220px | 150px |
| Gap | 20px | 16px | 12px |
| 卡片圓角 | 12px | 10px | 8px |

#### Pagination
| 元素 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| 按鈕大小 | 40px | 40px | 36px |
| 顯示頁碼數 | 5 | 5 | 3 |
| 上/下一頁文字 | 顯示 | 顯示 | 只顯示 ‹ › |

---

### 2. View 頁面 (`/lurl/view/:id`)

#### Video/Image Container
| 元素 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| 最大高度 | 70vh | 60vh | 50vh |
| 圓角 | 12px | 10px | 8px |
| Margin | 20px | 16px | 12px |

#### Info Section
| 元素 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| 標題字體 | 1.5em | 1.3em | 1.1em |
| 按鈕排列 | 水平 | 水平 | 垂直堆疊或換行 |
| 詳細資訊 | 兩欄 grid | 單欄 | 單欄 |

---

### 3. Login 頁面 (`/lurl/admin`)

#### Login Box
| 元素 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| 寬度 | 360px | 360px | 90% (max 360px) |
| Padding | 40px | 32px | 24px |
| 標題字體 | 1.5em | 1.4em | 1.3em |

---

### 4. Admin 頁面 (`/lurl/admin` 登入後)

#### Stats Cards
| 元素 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| 欄數 | 3 欄 | 2 欄 | 1 欄 |
| 數字字體 | 2em | 1.8em | 1.5em |

#### Records List
| 元素 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| 縮圖大小 | 80x60px | 60x45px | 隱藏 |
| 操作按鈕 | 全部顯示 | 全部顯示 | 下拉選單或圖示 |

---

## 通用規則

### Touch 友善
- 所有可點擊元素最小 44x44px (Apple HIG)
- 按鈕之間有足夠間距防止誤觸

### 字體
- Mobile 輸入框最小 16px (防止 iOS 自動縮放)
- 使用 rem/em 相對單位

### 圖片
- 使用 `object-fit: cover` 或 `contain`
- 考慮 lazy loading

### 捲動
- 水平捲動區域加 `-webkit-overflow-scrolling: touch`
- 隱藏捲動條但保持功能

---

## 實作優先順序
1. **Browse 頁面** - 最常用
2. **View 頁面** - 觀看內容
3. **Login 頁面** - 簡單
4. **Admin 頁面** - 管理者使用

---

## CSS 結構建議

```css
/* Mobile First 基礎樣式 */
.grid {
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

/* Tablet */
@media (min-width: 768px) {
  .grid {
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }
}

/* Desktop */
@media (min-width: 1024px) {
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 20px;
  }
}
```

---

## 測試清單
- [ ] iPhone SE (375px)
- [ ] iPhone 14 (390px)
- [ ] iPhone 14 Pro Max (430px)
- [ ] iPad (768px)
- [ ] iPad Pro (1024px)
- [ ] Desktop (1440px+)
