// Day 14 - 练习 2：错误日志文件系统
//
// 功能：
//   1. 分级别记录：debug / info / warn / error（可配置最低级别）
//   2. 按日期自动分文件：logs/2026-05-09.info.log、logs/2026-05-09.error.log ...
//   3. 跨天自动滚动（下一条日志触发文件切换）
//   4. 包含时间戳、级别、消息、错误栈、任意上下文（meta）
//   5. 可选同时输出到控制台（带颜色）
//   6. 异步写入 + 进程退出时 flush，避免日志丢失
//
// 用法：
//   const log = createLogger({ dir: './logs', level: 'info', console: true });
//   log.info('user login', { userId: 42 });
//   log.error('db failed', { error: err, query: 'SELECT ...' });
//
// 直接运行本文件可看到演示。

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ─── 级别定义 ────────────────────────────────────────────────────────────────

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = {
  debug: '\x1b[90m', // gray
  info:  '\x1b[36m', // cyan
  warn:  '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

// ─── 工具：今天的日期串（本地时区，YYYY-MM-DD）─────────────────────────────

function today() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─── 工具：把 Error / Object / 其它值序列化为可读 JSON ───────────────────────
//
// 直接 JSON.stringify(err) 会得到 "{}"，因为 message/stack 是不可枚举属性。
// 这里手动展开 Error，并对循环引用做防御。

function serializeMeta(meta) {
  if (meta === undefined || meta === null) return undefined;
  const seen = new WeakSet();
  const replacer = (_, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack, ...value };
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    if (typeof value === 'bigint') return value.toString() + 'n';
    return value;
  };
  return JSON.parse(JSON.stringify(meta, replacer));
}

// ─── 创建日志器 ──────────────────────────────────────────────────────────────

function createLogger(options = {}) {
  const {
    dir = path.join(process.cwd(), 'logs'),
    level = 'info',
    console: useConsole = true,
    // 写入策略：'per-level' 每个级别一个文件；'combined' 全部一起 + error 单独一份
    strategy = 'per-level',
  } = options;

  const minLevel = LEVELS[level];
  if (minLevel === undefined) throw new Error(`未知日志级别: ${level}`);

  fs.mkdirSync(dir, { recursive: true });

  // 缓存"日期 + 级别 → WriteStream"，跨天时关掉旧的换新的
  const streams = new Map();
  let currentDate = today();

  // 拿到 `<date>.<fileLabel>.log` 对应的 WriteStream，跨天自动滚动。
  // 注意：fileLabel 是文件名标签（'debug'|'info'|'warn'|'error'|'all'），
  // 不是日志级别 —— 由调用方根据策略决定要写哪几个文件。
  function getStream(fileLabel) {
    const date = today();
    if (date !== currentDate) {
      // 跨天：关闭所有旧 stream
      for (const s of streams.values()) s.end();
      streams.clear();
      currentDate = date;
    }

    const key = `${date}:${fileLabel}`;
    let stream = streams.get(key);
    if (!stream) {
      const file = path.join(dir, `${date}.${fileLabel}.log`);
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', err => {
        // 写日志失败时只能输出到 stderr，避免无限递归
        process.stderr.write(`[logger] 写入 ${file} 失败: ${err.message}\n`);
      });
      streams.set(key, stream);
    }
    return stream;
  }

  // 根据策略决定一条日志要落到哪几个文件。
  // - per-level: 每个级别独立一份（debug/info/warn/error）
  // - combined: 所有日志写入 all.log；error 额外再单独写一份 error.log
  function targetLabels(levelName) {
    if (strategy === 'combined') {
      return levelName === 'error' ? ['all', 'error'] : ['all'];
    }
    return [levelName];
  }

  function write(levelName, message, meta) {
    if (LEVELS[levelName] < minLevel) return;

    const entry = {
      time: new Date().toISOString(),
      level: levelName,
      pid: process.pid,
      message,
    };
    const safeMeta = serializeMeta(meta);
    if (safeMeta !== undefined) entry.meta = safeMeta;

    const line = JSON.stringify(entry) + '\n';

    for (const label of targetLabels(levelName)) {
      getStream(label).write(line);
    }

    // 同时输出到控制台（人类友好格式）
    if (useConsole) {
      const color = COLORS[levelName] ?? '';
      const tag = `[${entry.time}] ${levelName.toUpperCase().padEnd(5)}`;
      const tail = safeMeta ? ' ' + JSON.stringify(safeMeta) : '';
      const out = `${color}${tag}${RESET} ${message}${tail}`;
      (levelName === 'error' || levelName === 'warn' ? process.stderr : process.stdout).write(out + '\n');
    }
  }

  function flush() {
    return Promise.all(
      Array.from(streams.values()).map(
        s => new Promise(resolve => s.end(resolve))
      )
    );
  }

  // 进程退出前 flush 一次（兜底，可被显式 flush 替代）
  process.once('beforeExit', () => { for (const s of streams.values()) s.end(); });

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info:  (msg, meta) => write('info',  msg, meta),
    warn:  (msg, meta) => write('warn',  msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    flush,
  };
}

module.exports = { createLogger };

// ─── 直接运行时的演示 ────────────────────────────────────────────────────────

if (require.main === module) {
  const log = createLogger({
    dir: path.join(__dirname, 'logs'),
    level: 'debug',
    console: true,
  });

  log.debug('debug 级别 — 默认 info 时不会落盘');
  log.info('服务启动', { port: 3000, env: 'development' });
  log.warn('数据库连接慢', { latencyMs: 1234 });

  try {
    JSON.parse('not a json');
  } catch (err) {
    log.error('解析配置失败', {
      error: err,
      context: { file: 'config.json', requestId: 'req_abc123' },
    });
  }

  // 演示循环引用 + Error 嵌套不会炸
  const a = { name: 'a' };
  a.self = a;
  log.warn('循环引用测试', a);

  log.flush().then(() => {
    console.log('\n✅ 日志已写入', path.join(__dirname, 'logs'));
  });
}
