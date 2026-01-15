/**
 * 範例路由模組
 * 複製此檔案並修改來新增你的 API
 *
 * 導出格式：
 *   match(req)  - 判斷是否處理此請求
 *   handle(req, res) - 處理請求
 */

module.exports = {
  // 匹配 /hello 路徑
  match(req) {
    return req.url === '/hello';
  },

  // 處理請求
  handle(req, res) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Hello World!' }));
  }
};
