// Day 06 - 练习 2：Promise 超时包装器

const TIMEOUT_SENTINEL = Symbol('timeout');

class TimeoutError extends Error {
  constructor(ms) {
    super(`操作超时（${ms}ms）`);
    this.name = 'TimeoutError';
    this.timeout = ms;
  }
}

/**
 * 为 Promise 添加超时控制
 * @param {Promise} promise 原始 Promise
 * @param {number} ms 超时毫秒数
 * @param {*} [defaultValue] 超时时的默认返回值（不传则抛出 TimeoutError）
 */
async function withTimeout(promise, ms, ...rest) {
  const hasDefault = rest.length > 0;
  const defaultValue = rest[0];

  let timer;
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (hasDefault) {
        resolve(TIMEOUT_SENTINEL);
      } else {
        reject(new TimeoutError(ms));
      }
    }, ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    if (result === TIMEOUT_SENTINEL) return defaultValue;
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// ── 演示 ─────────────────────────────────────────────────────

function delay(ms, value) {
  return new Promise((r) => setTimeout(() => r(value), ms));
}

function delayReject(ms, msg) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

console.log('─── 场景 1：正常完成（200ms < 超时 500ms） ───');
try {
  const result = await withTimeout(delay(200, '成功数据'), 500);
  console.log('结果:', result);
} catch (e) {
  console.error('错误:', e.message);
}

console.log('\n─── 场景 2：超时后抛出 TimeoutError ───');
try {
  await withTimeout(delay(1000, '慢数据'), 300);
} catch (e) {
  console.error(`${e.name}: ${e.message}`);
}

console.log('\n─── 场景 3：超时后返回默认值 ───');
const result = await withTimeout(delay(1000, '慢数据'), 300, '默认值');
console.log('结果:', result);

console.log('\n─── 场景 4：Promise 本身 reject ───');
try {
  await withTimeout(delayReject(100, '网络错误'), 500);
} catch (e) {
  console.error(`捕获到原始错误: ${e.message}`);
}
