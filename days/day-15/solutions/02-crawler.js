// Day 15 - 挑战 2：并发爬虫
// 抓取一组 URL，提取 <title>，最大并发 5，单请求超时 10s，结果写入 JSON

const fs = require('fs/promises');
const path = require('path');

// ─── 配置 ─────────────────────────────────────────────────────────────────────
const CONCURRENCY = 5;
const TIMEOUT_MS = 10_000;
const OUTPUT_FILE = path.join(__dirname, 'crawl-result.json');

// 默认 URL 列表（可被命令行参数覆盖：node 02-crawler.js url1 url2 ...）
const DEFAULT_URLS = [
  'https://nodejs.org/',
  'https://developer.mozilla.org/zh-CN/',
  'https://github.com/',
  'https://www.typescriptlang.org/',
  'https://nestjs.com/',
  'https://expressjs.com/',
  'https://www.npmjs.com/',
  'https://vitejs.dev/',
  'https://react.dev/',
  'https://vuejs.org/',
  'https://this-domain-does-not-exist-12345.com/',
  'https://httpstat.us/500',
];

// ─── 单个 URL 抓取（带超时控制）───────────────────────────────────────────────
// 使用 AbortController + AbortSignal.timeout 兼容性兜底
async function fetchWithTimeout(targetUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // 部分站点会拒绝无 UA 的请求
        'User-Agent': 'Mozilla/5.0 (compatible; Day15Crawler/1.0)',
      },
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 从 HTML 中提取 <title> ──────────────────────────────────────────────────
// 简单正则即可应对绝大多数页面；s 标志让 . 匹配换行
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return match[1]
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200); // 限制长度，避免离谱内容
}

// ─── 单个任务（包装错误，返回结构化结果）─────────────────────────────────────
async function crawlOne(targetUrl) {
  const startedAt = Date.now();
  try {
    const { status, text } = await fetchWithTimeout(targetUrl, TIMEOUT_MS);
    const elapsed = Date.now() - startedAt;

    if (status < 200 || status >= 400) {
      return {
        url: targetUrl,
        success: false,
        status,
        error: `HTTP ${status}`,
        elapsed,
      };
    }

    const title = extractTitle(text);
    return {
      url: targetUrl,
      success: true,
      status,
      title: title ?? '(无 title)',
      elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    const isTimeout = err.name === 'AbortError';
    return {
      url: targetUrl,
      success: false,
      status: null,
      error: isTimeout ? `超时（>${TIMEOUT_MS}ms）` : err.message,
      elapsed,
    };
  }
}

// ─── 并发控制（与 Day 13 同款 worker 池）─────────────────────────────────────
async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let index = 0;
  let done = 0;
  const total = tasks.length;

  async function runner() {
    while (index < total) {
      const current = index++;
      results[current] = await tasks[current]();
      done++;
      const r = results[current];
      const tag = r.success ? '✅' : '❌';
      const info = r.success ? r.title : r.error;
      console.log(`  ${tag} [${done}/${total}] ${r.url} → ${info} (${r.elapsed}ms)`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, runner));
  return results;
}

// ─── 主函数 ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║           并发爬虫 v1.0                    ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log();

  // 命令行参数优先；否则使用默认列表
  const cliUrls = process.argv.slice(2);
  const urls = cliUrls.length > 0 ? cliUrls : DEFAULT_URLS;

  console.log(`🌐 URL 数量:   ${urls.length}`);
  console.log(`⚡ 最大并发:   ${CONCURRENCY}`);
  console.log(`⏱  请求超时:   ${TIMEOUT_MS}ms`);
  console.log(`📄 输出文件:   ${OUTPUT_FILE}`);
  console.log();

  console.log('⏳ 开始抓取...');
  const startedAt = Date.now();
  const tasks = urls.map(u => () => crawlOne(u));
  const results = await runWithConcurrency(tasks, CONCURRENCY);
  const totalElapsed = Date.now() - startedAt;

  const succeeded = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 抓取结果');
  console.log(`   总数:   ${results.length}`);
  console.log(`   成功:   ${succeeded.length}`);
  console.log(`   失败:   ${failed.length}`);
  console.log(`   总耗时: ${totalElapsed}ms`);
  console.log(`   平均:   ${(totalElapsed / results.length).toFixed(0)}ms / URL`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 写入 JSON 结果（含元信息）
  const payload = {
    crawledAt: new Date().toISOString(),
    concurrency: CONCURRENCY,
    timeoutMs: TIMEOUT_MS,
    totalElapsed,
    summary: {
      total: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
    },
    results,
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  console.log();
  console.log(`💾 结果已保存至: ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('❌ 发生错误:', err);
  process.exit(1);
});
