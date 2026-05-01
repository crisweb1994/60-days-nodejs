// Day 13 - 练习 1：多线程密码哈希

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const os = require('os');

// ─── Worker 线程逻辑（当文件作为 Worker 运行时执行此分支）────────────────────
if (!isMainThread) {
  const { password, salt } = workerData;
  // pbkdf2Sync 是 CPU 密集型操作，适合放入 Worker 线程
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512');
  parentPort.postMessage(hash.toString('hex'));
  return;
}

// ─── 主线程逻辑 ──────────────────────────────────────────────────────────────

const USER_COUNT = 20;        // 测试用户数量
const CONCURRENCY = os.cpus().length; // 并发 Worker 数等于 CPU 核心数

// 生成测试用户列表（每个用户预先分配随机 salt）
function generateUsers(count) {
  const users = [];
  for (let i = 0; i < count; i++) {
    users.push({
      id: i + 1,
      username: `user_${String(i + 1).padStart(3, '0')}`,
      password: `p@ss_${crypto.randomBytes(6).toString('hex')}`,
      salt: crypto.randomBytes(16).toString('hex'),
    });
  }
  return users;
}

// ─── 方案一：单线程哈希（阻塞事件循环）─────────────────────────────────────
function hashSingleThread(users) {
  return users.map(user => {
    const hash = crypto.pbkdf2Sync(user.password, user.salt, 100_000, 64, 'sha512');
    return { ...user, hash: hash.toString('hex') };
  });
}

// ─── 方案二：多线程哈希（Worker Threads）────────────────────────────────────

// 创建单个 Worker，将当前文件作为 Worker 脚本（利用 isMainThread 判断分支）
function hashWithWorker(user) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { password: user.password, salt: user.salt },
    });
    worker.once('message', hash => resolve({ ...user, hash }));
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`Worker 异常退出，退出码: ${code}`));
    });
  });
}

// 并发控制：限制同时运行的 Worker 数量，避免创建过多线程
async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let index = 0;

  async function runner() {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  }

  // 同时启动 concurrency 个 runner，共同消费任务队列
  await Promise.all(Array.from({ length: concurrency }, runner));
  return results;
}

async function hashMultiThread(users, concurrency) {
  const tasks = users.map(user => () => hashWithWorker(user));
  return runWithConcurrency(tasks, concurrency);
}

// ─── 主函数 ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║        多线程密码哈希工具 v1.0             ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log();
  console.log(`🖥️  CPU 核心数: ${os.cpus().length}`);
  console.log(`👥 测试用户数: ${USER_COUNT}`);
  console.log(`⚡ 最大并发数: ${CONCURRENCY}`);
  console.log(`🔐 哈希算法:  PBKDF2-SHA512 (iterations=100,000)`);
  console.log();

  const users = generateUsers(USER_COUNT);

  // ── 单线程测试 ──
  console.log('⏳ 单线程哈希中...');
  const t1 = Date.now();
  const singleResults = hashSingleThread(users);
  const singleTime = Date.now() - t1;
  console.log(`✅ 单线程完成: ${singleTime}ms（${singleResults.length} 个用户）`);
  console.log();

  // ── 多线程测试 ──
  console.log('⏳ 多线程哈希中...');
  const t2 = Date.now();
  const multiResults = await hashMultiThread(users, CONCURRENCY);
  const multiTime = Date.now() - t2;
  console.log(`✅ 多线程完成: ${multiTime}ms（${multiResults.length} 个用户）`);
  console.log();

  // ── 性能对比 ──
  const speedup = (singleTime / multiTime).toFixed(2);
  const faster = singleTime > multiTime ? '多线程更快' : '单线程更快';
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 性能对比');
  console.log(`   单线程耗时: ${singleTime}ms`);
  console.log(`   多线程耗时: ${multiTime}ms`);
  console.log(`   加速比:     ${speedup}x  ← ${faster}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();

  // ── 展示部分结果 ──
  console.log('🔑 哈希结果样例（前 3 个）:');
  multiResults.slice(0, 3).forEach(user => {
    console.log(`   ${user.username}: ${user.hash.slice(0, 20)}...`);
  });
}

main().catch(err => {
  console.error('❌ 发生错误:', err.message);
  process.exit(1);
});
