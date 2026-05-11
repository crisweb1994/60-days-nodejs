// Day 15 - 挑战 1：HTTP 文件服务器
// 原生 Node.js 实现文件浏览与下载，支持子目录、正确的 Content-Type、防目录穿越

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const url = require('url');

// ─── 配置 ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
// 服务根目录：默认当前工作目录，可通过命令行参数 / 环境变量覆盖
const ROOT = path.resolve(process.argv[2] || process.env.ROOT || process.cwd());

// ─── MIME 类型表 ──────────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// 字节数格式化
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// HTML 转义，防止文件名中含有特殊字符导致 XSS
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── 安全路径解析：防止目录穿越（path traversal）─────────────────────────────
// 将 URL 路径映射到磁盘路径，并确保结果仍在 ROOT 之内
function resolveSafePath(urlPath) {
  // decodeURIComponent 处理中文 / 空格等
  const decoded = decodeURIComponent(urlPath);
  // path.resolve 自动处理 .. 跳级；之后用 ROOT 前缀校验
  const target = path.resolve(ROOT, '.' + decoded);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return null;
  }
  return target;
}

// ─── 渲染目录列表 HTML ────────────────────────────────────────────────────────
async function renderDirectory(diskPath, urlPath) {
  const entries = await fsp.readdir(diskPath, { withFileTypes: true });

  // 排序：目录在前，名称字母序
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const rows = await Promise.all(entries.map(async entry => {
    const fullPath = path.join(diskPath, entry.name);
    const stat = await fsp.stat(fullPath).catch(() => null);
    const isDir = entry.isDirectory();
    const href = path.posix.join(urlPath, encodeURIComponent(entry.name)) + (isDir ? '/' : '');
    const icon = isDir ? '📁' : '📄';
    const size = isDir ? '—' : (stat ? formatSize(stat.size) : '?');
    const mtime = stat ? stat.mtime.toISOString().slice(0, 19).replace('T', ' ') : '';
    return `      <tr>
        <td><a href="${escapeHtml(href)}">${icon} ${escapeHtml(entry.name)}${isDir ? '/' : ''}</a></td>
        <td class="size">${size}</td>
        <td class="time">${mtime}</td>
      </tr>`;
  }));

  // 父目录链接（根目录除外）
  const parentRow = urlPath !== '/'
    ? `      <tr><td><a href="../">📁 ../</a></td><td class="size">—</td><td class="time"></td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Index of ${escapeHtml(urlPath)}</title>
  <style>
    body { font-family: -apple-system, "Segoe UI", monospace; max-width: 960px; margin: 2em auto; padding: 0 1em; color: #333; }
    h1 { font-size: 1.2em; border-bottom: 1px solid #ddd; padding-bottom: .5em; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: .4em .6em; text-align: left; }
    tr:hover { background: #f6f8fa; }
    a { color: #0366d6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .size, .time { color: #6a737d; font-variant-numeric: tabular-nums; }
    .size { width: 100px; text-align: right; }
    .time { width: 180px; }
    .crumb { color: #6a737d; font-size: .9em; }
  </style>
</head>
<body>
  <h1>📂 Index of ${escapeHtml(urlPath)}</h1>
  <div class="crumb">服务根目录: ${escapeHtml(ROOT)}</div>
  <table>
    <thead>
      <tr><th>名称</th><th class="size">大小</th><th class="time">修改时间</th></tr>
    </thead>
    <tbody>
${parentRow}
${rows.join('\n')}
    </tbody>
  </table>
</body>
</html>`;
}

// ─── 发送文件（流式，支持下载） ───────────────────────────────────────────────
function sendFile(req, res, filePath, stat) {
  const mime = getMimeType(filePath);
  // 通过 ?download=1 强制下载；否则浏览器可识别的类型默认 inline 预览
  const parsed = url.parse(req.url, true);
  const forceDownload = parsed.query.download === '1';

  res.statusCode = 200;
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());

  if (forceDownload) {
    const filename = encodeURIComponent(path.basename(filePath));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  }

  // HEAD 请求只返回头
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', err => {
    console.error(`读取文件失败 ${filePath}:`, err.message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

// ─── 错误响应 ─────────────────────────────────────────────────────────────────
function sendError(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html><html><body><h1>${status}</h1><p>${escapeHtml(message)}</p></body></html>`);
}

// ─── 请求处理 ─────────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendError(res, 405, '只支持 GET / HEAD');
  }

  const parsed = url.parse(req.url);
  const safePath = resolveSafePath(parsed.pathname);

  if (safePath === null) {
    console.warn(`⚠️  阻止目录穿越: ${parsed.pathname}`);
    return sendError(res, 403, '禁止访问');
  }

  let stat;
  try {
    stat = await fsp.stat(safePath);
  } catch {
    return sendError(res, 404, `未找到: ${parsed.pathname}`);
  }

  if (stat.isDirectory()) {
    // 目录访问必须以 / 结尾，否则相对链接会错位
    if (!parsed.pathname.endsWith('/')) {
      res.statusCode = 301;
      res.setHeader('Location', parsed.pathname + '/');
      return res.end();
    }
    const html = await renderDirectory(safePath, parsed.pathname);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }

  if (stat.isFile()) {
    return sendFile(req, res, safePath, stat);
  }

  return sendError(res, 400, '不支持的文件类型');
}

// ─── 启动服务器 ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.url} → ${res.statusCode} (${ms}ms)`);
  });

  handleRequest(req, res).catch(err => {
    console.error('请求处理异常:', err);
    if (!res.headersSent) sendError(res, 500, '服务器内部错误');
  });
});

server.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║          HTTP 文件服务器 v1.0              ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`📁 根目录: ${ROOT}`);
  console.log(`🌐 地址:   http://localhost:${PORT}/`);
  console.log(`💡 下载:   在文件链接后加 ?download=1 强制下载`);
  console.log(`⏹  停止:   Ctrl+C`);
});

process.on('SIGINT', () => {
  console.log('\n👋 收到 SIGINT，正在关闭服务器...');
  server.close(() => process.exit(0));
});
