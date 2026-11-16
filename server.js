// Trợ Lý Slide Mr Quân — máy chủ Render (Node 18+, không cần npm install).
//
// Việc làm duy nhất của máy chủ này:
//  1. Phục vụ trang web tĩnh trong thư mục public/.
//  2. Nhận ảnh trang sách từ trình duyệt (POST /api/read-pages, multipart/form-data),
//     chuyển tiếp nguyên vẹn sang OCR.space bằng mạng của máy chủ, rồi trả JSON
//     của OCR.space về trình duyệt y nguyên. Trình duyệt của thầy cô không gọi
//     thẳng api.ocr.space nữa nên không bị chặn/chậm ở mạng nhà trường.
//
// Khóa OCR.space: lấy từ biến môi trường OCR_SPACE_API_KEY. Nếu biến này được
// đặt thành một khóa thật (khác "helloworld") thì máy chủ thay khóa đó vào
// form trước khi gửi đi; nếu không đặt (mặc định "helloworld") thì giữ nguyên
// khóa mà trình duyệt gửi lên (mặc định cũng là "helloworld", hoặc khóa riêng
// mà thầy cô đã dán trong app).

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '10000', 10);
const OCR_URL = 'https://api.ocr.space/parse/image';
const OCR_TIMEOUT_MS = 60000; // 60 giây cho mỗi trang
const MAX_BODY_BYTES = 5 * 1024 * 1024; // ảnh đã nén < 1MB ở phía trình duyệt

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendErrorVn(res, status, message) {
  sendJson(res, status, { error: message });
}

// ---- Phục vụ file tĩnh ----
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Chặn đi ngược thư mục: chỉ cho phép file nằm trong public/
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- Thay khóa OCR.space trong body multipart (nếu máy chủ có khóa riêng) ----
// Body được xử lý ở dạng chuỗi latin1 để dữ liệu nhị phân của ảnh JPEG không
// bị hỏng khi thay chuỗi. Nếu không cần thay khóa thì trả lại buffer gốc.
function withServerApiKey(bodyBuffer, contentType) {
  const envKey = (process.env.OCR_SPACE_API_KEY || '').trim();
  if (!envKey || envKey === 'helloworld') return bodyBuffer; // giữ khóa trình duyệt gửi lên
  const text = bodyBuffer.toString('latin1');
  // Dạng một phần multipart: name="apikey"\r\n\r\n<giá trị>\r\n
  const re = /(name="apikey"\r\n\r\n)[^\r\n]*(\r\n)/;
  if (re.test(text)) {
    return Buffer.from(text.replace(re, '$1' + envKey + '$2'), 'latin1');
  }
  // Không có phần apikey: chèn thêm một phần trước boundary kết thúc.
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!boundaryMatch) return bodyBuffer;
  const boundary = (boundaryMatch[1] || boundaryMatch[2] || '').trim();
  if (!boundary) return bodyBuffer;
  const endMarker = '--' + boundary + '--';
  const idx = text.lastIndexOf(endMarker);
  if (idx < 0) return bodyBuffer;
  const part = '--' + boundary + '\r\nContent-Disposition: form-data; name="apikey"\r\n\r\n' + envKey + '\r\n';
  return Buffer.from(text.slice(0, idx) + part + text.slice(idx), 'latin1');
}

// ---- Proxy OCR: POST /api/read-pages ----
function handleReadPages(req, res) {
  const contentType = req.headers['content-type'] || '';
  if (!/multipart\/form-data/i.test(contentType)) {
    sendErrorVn(res, 400, 'Yêu cầu đọc trang sách phải gửi dạng multipart/form-data.');
    return;
  }

  const chunks = [];
  let total = 0;
  let tooBig = false;

  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      tooBig = true;
      return; // vẫn đọc hết để đóng kết nối gọn, nhưng không lưu thêm
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (tooBig) {
      sendErrorVn(res, 413, 'Ảnh trang sách quá lớn (tối đa 5MB). Hãy chụp lại hoặc nén nhỏ hơn rồi thử lại.');
      return;
    }
    const body = withServerApiKey(Buffer.concat(chunks), contentType);

    const upstream = https.request(OCR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'User-Agent': 'tro-ly-slide-mr-quan-render/1.0',
      },
    });

    let finished = false;
    const fail = (status, message) => {
      if (finished) return;
      finished = true;
      clearTimeout(wallTimer);
      sendErrorVn(res, status, message);
    };

    // Đồng hồ tổng 60 giây: chặn cả trường hợp DNS/kết nối bị treo mà
    // sự kiện 'timeout' của socket không kịp kích hoạt.
    const wallTimer = setTimeout(() => {
      upstream.destroy(new Error('upstream timeout'));
      fail(502, 'Máy chủ OCR.space trả lời quá chậm (quá 60 giây). Thầy cô thử lại trang này nhé.');
    }, OCR_TIMEOUT_MS);
    if (typeof wallTimer.unref === 'function') wallTimer.unref();

    upstream.on('timeout', () => {
      upstream.destroy(new Error('timeout'));
      fail(502, 'Máy chủ OCR.space trả lời quá chậm (quá 60 giây). Thầy cô thử lại trang này nhé.');
    });
    upstream.on('error', (err) => {
      fail(502, 'Không nối được tới máy chủ OCR.space từ máy chủ Render (' + (err.message || 'lỗi mạng') + '). Thầy cô thử lại sau ít phút nhé.');
    });
    upstream.on('response', (upRes) => {
      const upChunks = [];
      upRes.on('data', (c) => upChunks.push(c));
      upRes.on('end', () => {
        if (finished) return;
        finished = true;
        clearTimeout(wallTimer);
        // Trả JSON của OCR.space y nguyên, kể cả khi là lỗi 4xx/5xx để
        // trình duyệt tự phân loại (hết lượt 429, lỗi API...).
        const upBody = Buffer.concat(upChunks);
        res.writeHead(upRes.statusCode || 502, {
          'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
        });
        res.end(upBody);
      });
      upRes.on('error', () => {
        fail(502, 'Đọc kết quả từ máy chủ OCR.space bị ngắt giữa chừng. Thầy cô thử lại trang này nhé.');
      });
    });

    upstream.end(body);
  });

  req.on('error', () => {
    sendErrorVn(res, 502, 'Nhận ảnh từ trình duyệt bị lỗi. Thầy cô thử tải lại trang và gửi lại nhé.');
  });
}

// ---- Máy chủ ----
const server = http.createServer((req, res) => {
  try {
    const urlPath = req.url.split('?')[0];
    if (req.method === 'GET' && urlPath === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/read-pages') {
      handleReadPages(req, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res);
      return;
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  } catch (err) {
    // Không bao giờ để một yêu cầu lỗi làm sập máy chủ.
    console.error('Request error:', err && err.message);
    try { sendErrorVn(res, 500, 'Máy chủ gặp lỗi không mong muốn. Thầy cô thử lại nhé.'); } catch (_) { /* kết nối đã đóng */ }
  }
});

server.on('error', (err) => {
  console.error('Server error:', err && err.message);
});

server.listen(PORT, () => {
  console.log('Tro Ly Slide Mr Quan dang chay tren cong ' + PORT);
});
