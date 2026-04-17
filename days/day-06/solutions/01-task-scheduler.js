// Day 06 - 练习 1：并发任务调度器

import { EventEmitter } from 'node:events';

class TaskScheduler extends EventEmitter {
  /**
   * @param {number} concurrency 最大并发数
   */
  constructor(concurrency = 3) {
    super();
    this.concurrency = concurrency;
    this.queue = []; // { fn, priority, index }
    this.results = [];
    this.completed = 0;
    this.total = 0;
  }

  /**
   * 添加任务
   * @param {Function} fn 异步任务函数
   * @param {number} priority 优先级，数字越大越先执行（默认 0）
   */
  addTask(fn, priority = 0) {
    const index = this.total++;
    this.queue.push({ fn, priority, index });
    this.results.push(undefined);
  }

  async run() {
    // 按优先级降序排列
    this.queue.sort((a, b) => b.priority - a.priority);

    this.emit('start', { total: this.total });

    const executing = new Set();

    for (const task of this.queue) {
      const promise = this._runTask(task).then((result) => {
        executing.delete(promise);
        return result;
      });

      executing.add(promise);

      if (executing.size >= this.concurrency) {
        await Promise.race(executing);
      }
    }

    // 等待剩余任务完成
    await Promise.all(executing);

    this.emit('finish', { total: this.total, results: this.results });
    return this.results;
  }

  async _runTask({ fn, index }) {
    this.emit('taskStart', { index, running: 0 });

    try {
      const value = await fn();
      this.results[index] = { status: 'fulfilled', value };
      this.completed++;
      this.emit('taskComplete', {
        index,
        value,
        completed: this.completed,
        total: this.total,
        percent: ((this.completed / this.total) * 100).toFixed(1),
      });
    } catch (reason) {
      this.results[index] = { status: 'rejected', reason };
      this.completed++;
      this.emit('taskError', {
        index,
        reason,
        completed: this.completed,
        total: this.total,
      });
    }
  }
}

// ── 演示 ─────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const scheduler = new TaskScheduler(3);

// 添加 10 个任务，部分设置优先级
for (let i = 1; i <= 10; i++) {
  const durationMs = 200 + Math.random() * 300;
  const priority = i <= 3 ? 10 : 0; // 前 3 个任务优先级高

  scheduler.addTask(async () => {
    await delay(durationMs);
    if (i === 7) throw new Error(`任务 ${i} 模拟失败`);
    return `任务 ${i} 结果`;
  }, priority);
}

scheduler.on('start', ({ total }) => console.log(`▶ 开始调度 ${total} 个任务（并发: 3）\n`));
scheduler.on('taskComplete', ({ index, percent }) => {
  console.log(`  ✅ 任务 #${index + 1} 完成  进度: ${percent}%`);
});
scheduler.on('taskError', ({ index, reason }) => {
  console.log(`  ❌ 任务 #${index + 1} 失败  ${reason.message}`);
});
scheduler.on('finish', ({ results }) => {
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;
  console.log(`\n🎉 全部完成：成功 ${fulfilled}，失败 ${rejected}`);
});

await scheduler.run();
