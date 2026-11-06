/**
 * NTD Agency - Web Server (server.js)
 * Máy chủ phục vụ Website công khai (Node.js Native HTTP - Không cần cài thêm npm package nào).
 * Chạy lệnh: node server.js
 * Hoặc deploy lên Vercel, Render, Railway, VPS Ubuntu/Windows.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  // CORS Headers cho mọi request
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Parse URL
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  // API Health Check
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      app: 'NTD Agency Web Platform',
      version: '0.4.4',
      uptime: process.uptime(),
      time: new Date().toISOString()
    }));
    return;
  }

  // Mặc định về index.html
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  // Ngăn Path Traversal
  const safePath = path.normalize(path.join(__dirname, pathname));
  if (!safePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  // Kiểm tra file có tồn tại không
  fs.stat(safePath, (err, stats) => {
    if (err) {
      // Thử tìm thêm đuôi .html nếu truy cập /panel -> /panel.html
      const htmlCandidate = safePath + '.html';
      if (fs.existsSync(htmlCandidate)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(htmlCandidate).pipe(res);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!doctype html>
        <html lang="vi">
        <head><meta charset="utf-8"><title>404 - Không tìm thấy trang</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:50px;background:#070b14;color:#f8fafc">
          <h1 style="color:#ed6b22">404 - Không tìm thấy trang</h1>
          <p>Đường dẫn <code>${pathname}</code> không tồn tại trên hệ thống.</p>
          <p><a href="/index.html" style="color:#ed6b22;text-decoration:none;font-weight:bold">← Quay lại Trang Chủ</a></p>
        </body>
        </html>
      `);
      return;
    }

    // Nếu là thư mục, thử tìm index.html
    let filePathToRead = safePath;
    if (stats.isDirectory()) {
      filePathToRead = path.join(safePath, 'index.html');
      if (!fs.existsSync(filePathToRead)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
      }
    }

    const ext = path.extname(filePathToRead).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });

    const stream = fs.createReadStream(filePathToRead);
    stream.pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 NTD Agency Web Platform đang chạy tại:`);
  console.log(`   👉 http://localhost:${PORT}`);
  console.log(`   👉 Trang chủ:   http://localhost:${PORT}/index.html`);
  console.log(`   👉 Đăng nhập:   http://localhost:${PORT}/activate.html`);
  console.log(`   👉 Bảng điều khiển: http://localhost:${PORT}/panel.html`);
  console.log(`====================================================`);
});

