// Day 15 - 挑战 3：实时日志监控（类 tail -f）
// 监听文件 append，按行解析，高亮各级别，实时统计

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

// ─── 配置 ─────────────────────────────────────────────────────────────────────
const DEFAULT_LOG = path.join(__dirname, 'demo.log');
const LOG_FILE = path.resolve(process.argv[2] || DEFAULT_LOG);

// ─── ANSI 颜色 ────────────────────────────────────────────────────────────────
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
};

const LEVEL_STYLE = {
  ERROR: COLORS.bold + COLORS.red,
  WARN: COLORS.yellow,
  INFO: COLORS.green,
  DEBUG: COLORS.cyan,
  TRACE: COLORS.gray,
};

// ─── 级别识别（兼容多种常见日志格式）─────────────────────────────────────────
// 匹配大小写均可的级别词；同时识别 [LEVEL] / level=LEVEL 等形式
const LEVEL_RE = /\b(ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\b/i;

function detectLevel(line) {
  const m = LEVEL_RE.exec(line);
  if (!m) return 'INFO'; // 默认归为 INFO
  const raw = m[1].toUpperCase();
  if (raw === 'ERR' || raw === 'FATAL') return 'ERROR';
  if (raw === 'WARNING') return 'WARN';
  return raw;
}

// ─── 统计 ─────────────────────────────────────────────────────────────────────
const stats = {
  ERROR: 0,
  WARN: 0,
  INFO: 0,
  DEBUG: 0,
  TRACE: 0,
  total: 0,
  startedAt: Date.now(),
};

function printLine(line) {
  if (!line) return;
  const level = detectLevel(line);
  stats[level] = (stats[level] || 0) + 1;
  stats.total++;

  const style = LEVEL_STYLE[level] || '';
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  // ERROR 行整行高亮以突出告警
  if (level === 'ERROR') {
    process.stdout.write(`${COLORS.gray}${ts}${COLORS.reset} ${COLORS.bgRed}${COLORS.bold} ERROR ${COLORS.reset} ${style}${line}${COLORS.reset}\n`);
  } else {
    const tag = `[${level.padEnd(5)}]`;
    process.stdout.write(`${COLORS.gray}${ts}${COLORS.reset} ${style}${tag}${COLORS.reset} ${line}\n`);
  }
}

// ─── 状态栏（定时刷新统计）───────────────────────────────────────────────────
function printStats() {
  const elapsedSec = Math.floor((Date.now() - stats.startedAt) / 1000);
  const rate = elapsedSec > 0 ? (stats.total / elapsedSec).toFixed(2) : '0.00';
  console.log(
    `${COLORS.dim}─── 统计 [运行 ${elapsedSec}s | ${rate} 行/s] ` +
    `total=${stats.total} ` +
    `${COLORS.red}ERROR=${stats.ERROR}${COLORS.reset}${COLORS.dim} ` +
    `${COLORS.yellow}WARN=${stats.WARN}${COLORS.reset}${COLORS.dim} ` +
    `${COLORS.green}INFO=${stats.INFO}${COLORS.reset}${COLORS.dim} ` +
    `${COLORS.cyan}DEBUG=${stats.DEBUG}${COLORS.reset}${COLORS.dim} ` +
    `TRACE=${stats.TRACE}${COLORS.reset}`
  );
}

// ─── 核心：监听文件追加（类 tail -f）─────────────────────────────────────────
// 思路：
//   1. 启动时记录当前文件大小 (offset)，不读取历史内容
//   2. fs.watch 监听文件变更，每次变更后从 offset 读到新的 EOF，按行输出
//   3. 用 readline 处理跨 chunk 的半行问题
async function tailFile(filePath) {
  // 文件不存在则等待 / 提示
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    console.error(`${COLORS.red}❌ 文件不存在: ${filePath}${COLORS.reset}`);
    console.error(`${COLORS.dim}   提示: 可先运行 demo 模式: node 03-log-tail.js --demo${COLORS.reset}`);
    process.exit(1);
  }

  let offset = stat.size;
  let reading = false;
  let pending = false;

  async function readNew() {
    // 简单的可重入保护：若正在读取，标记 pending，结束后再读一次
    if (reading) {
      pending = true;
      return;
    }
    reading = true;
    try {
      const current = await fsp.stat(filePath);
      // 文件被截断（如日志轮转），从头读
      if (current.size < offset) {
        console.log(`${COLORS.yellow}⚠️  检测到文件被截断，重置 offset${COLORS.reset}`);
        offset = 0;
      }
      if (current.size === offset) return;

      const stream = fs.createReadStream(filePath, { start: offset, end: current.size - 1 });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        printLine(line);
      }
      offset = current.size;
    } finally {
      reading = false;
      if (pending) {
        pending = false;
        readNew();
      }
    }
  }

  // fs.watch 在不同平台行为有差异，事件可能触发多次或不触发；做去抖更稳
  let debounceTimer = null;
  const watcher = fs.watch(filePath, () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(readNew, 50);
  });

  // 周期性输出统计（每 5 秒一次）
  const statsTimer = setInterval(printStats, 5_000);

  // 退出处理
  function shutdown() {
    clearInterval(statsTimer);
    clearTimeout(debounceTimer);
    watcher.close();
    console.log();
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 最终统计');
    printStats();
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ─── Demo 模式：自动生成日志，便于直接演示 ───────────────────────────────────
// 用法：node 03-log-tail.js --demo
async function runDemo() {
  const demoPath = DEFAULT_LOG;
  // 清空旧的 demo 日志
  await fsp.writeFile(demoPath, '');
  console.log(`${COLORS.cyan}🎬 Demo 模式：将向 ${demoPath} 不断写入日志${COLORS.reset}`);
  console.log(`${COLORS.dim}   另开一个终端执行: node ${path.basename(__filename)} ${demoPath}${COLORS.reset}`);
  console.log();

  const levels = [
    { tag: 'INFO',  weight: 6, msgs: ['用户登录成功', '请求完成 GET /api/users', '缓存命中', '健康检查通过'] },
    { tag: 'DEBUG', weight: 3, msgs: ['SQL: SELECT * FROM users LIMIT 10', 'cache key=u:42', 'middleware authMiddleware ok'] },
    { tag: 'WARN',  weight: 2, msgs: ['响应时间超过 500ms', '连接池接近上限', 'API 调用即将达到限流'] },
    { tag: 'ERROR', weight: 1, msgs: ['数据库连接失败: ECONNREFUSED', '未捕获异常: TypeError', '支付回调签名校验失败'] },
  ];

  // 加权随机选择级别
  const pool = levels.flatMap(l => Array(l.weight).fill(l));

  let count = 0;
  const timer = setInterval(async () => {
    const lvl = pool[Math.floor(Math.random() * pool.length)];
    const msg = lvl.msgs[Math.floor(Math.random() * lvl.msgs.length)];
    const line = `${new Date().toISOString()} [${lvl.tag}] ${msg} (#${++count})\n`;
    await fsp.appendFile(demoPath, line);
  }, 300);

  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log(`\n${COLORS.dim}Demo 写入已停止，共写入 ${count} 行${COLORS.reset}`);
    process.exit(0);
  });
}

// ─── 入口 ────────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--demo')) {
    return runDemo();
  }

  console.log('╔════════════════════════════════════════════╗');
  console.log('║         实时日志监控工具 v1.0              ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`📄 监控文件: ${LOG_FILE}`);
  console.log(`💡 用法:     node 03-log-tail.js [logfile]`);
  console.log(`💡 演示:     node 03-log-tail.js --demo  (另开一个终端跑 tail)`);
  console.log(`⏹  停止:     Ctrl+C`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  await tailFile(LOG_FILE);
}

main().catch(err => {
  console.error('❌ 发生错误:', err);
  process.exit(1);
});
