// Day 05 - 练习 3：阻塞检测器

function createBlockDetector(thresholdMs = 100) {
  let lastTick = Date.now();
  let maxBlock = 0;
  let blockCount = 0;

  const interval = setInterval(() => {
    const now = Date.now();
    const delta = now - lastTick;
    const blocked = delta - 10; // setInterval 本身有约 10ms 的间隔

    if (blocked > thresholdMs) {
      blockCount++;
      if (blocked > maxBlock) maxBlock = blocked;
      console.warn(
        `⚠️  [阻塞检测] 事件循环被阻塞 ${blocked}ms（阈值: ${thresholdMs}ms，累计第 ${blockCount} 次）`
      );
    }

    lastTick = now;
  }, 10);

  // 防止 interval 阻止进程退出
  interval.unref();

  return {
    stop() {
      clearInterval(interval);
      console.log(`\n📊 阻塞检测报告:`);
      console.log(`   阻塞次数: ${blockCount}`);
      console.log(`   最长阻塞: ${maxBlock}ms`);
    },
  };
}

// ── 演示 ─────────────────────────────────────────────────────

const detector = createBlockDetector(100);

console.log('阻塞检测器已启动（阈值 100ms）\n');

// 正常异步任务 — 不会触发阻塞警告
setTimeout(() => {
  console.log('[500ms] 正常异步任务，不会阻塞');
}, 500);

// 模拟阻塞 — 200ms 的同步死循环
setTimeout(() => {
  console.log('\n[1000ms] 开始模拟 200ms 同步阻塞...');
  const start = Date.now();
  while (Date.now() - start < 200) {} // CPU 密集型操作
  console.log('[1000ms] 同步阻塞结束');
}, 1000);

// 模拟阻塞 — 350ms
setTimeout(() => {
  console.log('\n[2000ms] 开始模拟 350ms 同步阻塞...');
  const start = Date.now();
  while (Date.now() - start < 350) {}
  console.log('[2000ms] 同步阻塞结束');
}, 2000);

// 3.5 秒后停止检测并打印报告
setTimeout(() => {
  detector.stop();
}, 3500);
