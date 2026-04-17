// Day 06 - 练习 3：重试机制

/**
 * 带退避策略的重试函数
 * @param {Function} fn 返回 Promise 的函数
 * @param {object} options
 * @param {number}   options.maxRetries     最大重试次数（默认 3）
 * @param {number}   options.delay          初始延迟毫秒（默认 1000）
 * @param {'fixed'|'linear'|'exponential'} options.backoff 退避策略（默认 'exponential'）
 * @param {number}   options.maxDelay       最大延迟上限（默认 30000ms）
 * @param {Function} options.onRetry        重试钩子 (error, attempt) => void
 * @param {Function} options.shouldRetry    自定义是否重试 (error) => boolean
 */
async function retry(fn, options = {}) {
  const {
    maxRetries = 3,
    delay = 1000,
    backoff = 'exponential',
    maxDelay = 30_000,
    onRetry = null,
    shouldRetry = () => true,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt || !shouldRetry(error)) {
        throw error;
      }

      // 计算下次延迟
      let waitMs;
      switch (backoff) {
        case 'fixed':
          waitMs = delay;
          break;
        case 'linear':
          waitMs = delay * (attempt + 1);
          break;
        case 'exponential':
        default:
          waitMs = delay * Math.pow(2, attempt);
          break;
      }
      waitMs = Math.min(waitMs, maxDelay);

      onRetry?.(error, attempt + 1);

      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  throw lastError;
}

// ── 演示 ─────────────────────────────────────────────────────

let callCount = 0;

function fetchUnstableAPI() {
  callCount++;
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      // 前 3 次调用模拟失败，第 4 次成功
      if (callCount < 4) {
        reject(new Error(`服务暂时不可用（第 ${callCount} 次调用）`));
      } else {
        resolve({ data: '成功获取数据', callCount });
      }
    }, 50);
  });
}

console.log('─── 场景 1：指数退避，最终成功 ───');
try {
  const data = await retry(fetchUnstableAPI, {
    maxRetries: 3,
    delay: 100,
    backoff: 'exponential',
    onRetry: (error, attempt) => {
      console.log(`  第 ${attempt} 次重试，错误: ${error.message}`);
    },
  });
  console.log('最终结果:', data);
} catch (e) {
  console.error('全部重试失败:', e.message);
}

console.log('\n─── 场景 2：超过最大重试次数，抛出错误 ───');
callCount = 0; // 重置，让它一直失败

function alwaysFail() {
  return Promise.reject(new Error('持续失败'));
}

try {
  await retry(alwaysFail, {
    maxRetries: 2,
    delay: 50,
    backoff: 'fixed',
    onRetry: (error, attempt) => {
      console.log(`  第 ${attempt} 次重试，错误: ${error.message}`);
    },
  });
} catch (e) {
  console.error('已达最大重试次数，最终错误:', e.message);
}

console.log('\n─── 场景 3：shouldRetry 控制只重试特定错误 ───');

class NetworkError extends Error {}

let n = 0;
function mixedErrors() {
  n++;
  if (n === 1) return Promise.reject(new NetworkError('网络超时'));
  if (n === 2) return Promise.reject(new TypeError('数据格式错误'));
  return Promise.resolve('ok');
}

try {
  await retry(mixedErrors, {
    maxRetries: 3,
    delay: 50,
    shouldRetry: (err) => err instanceof NetworkError,
    onRetry: (err, attempt) => console.log(`  重试 #${attempt}: ${err.message}`),
  });
} catch (e) {
  console.error(`非网络错误，立即停止重试: [${e.constructor.name}] ${e.message}`);
}
