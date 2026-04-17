// Day 05 - 练习 2：事件循环可视化工具

const start = Date.now();

function ts() {
  return `+${(Date.now() - start).toString().padStart(4, ' ')}ms`;
}

function log(phase, msg) {
  console.log(`[${ts()}] [${phase.padEnd(18)}] ${msg}`);
}

// ── 同步代码（Call Stack） ──────────────────────────────────
log('同步', '开始执行');

// ── 微任务注册 ──────────────────────────────────────────────
process.nextTick(() => log('nextTick', '第 1 个 nextTick'));

Promise.resolve().then(() => {
  log('Promise.then', '第 1 个 Promise');

  // 在微任务中再注册微任务，会在当前微任务队列清空前插队
  process.nextTick(() => log('nextTick', '在 Promise.then 内注册的 nextTick'));
  Promise.resolve().then(() => log('Promise.then', '在 Promise.then 内注册的 Promise'));
});

process.nextTick(() => {
  log('nextTick', '第 2 个 nextTick（内部再注册）');
  process.nextTick(() => log('nextTick', '第 2 个 nextTick 内嵌套的 nextTick'));
});

// ── 宏任务注册 ──────────────────────────────────────────────
setTimeout(() => {
  log('Timers 阶段', 'setTimeout 0ms 回调');

  // I/O 回调内：setImmediate 先于 setTimeout
  setImmediate(() => log('Check 阶段', 'setTimeout 内的 setImmediate'));
  setTimeout(() => log('Timers 阶段', 'setTimeout 内的 setTimeout 0ms'), 0);
}, 0);

setTimeout(() => log('Timers 阶段', 'setTimeout 10ms 回调'), 10);
setTimeout(() => log('Timers 阶段', 'setTimeout 50ms 回调'), 50);

setImmediate(() => {
  log('Check 阶段', '第 1 个 setImmediate');
  Promise.resolve().then(() =>
    log('Promise.then', 'setImmediate 内注册的 Promise（在下一阶段前执行）')
  );
});

setImmediate(() => log('Check 阶段', '第 2 个 setImmediate'));

// ── 模拟 I/O（poll 阶段） ────────────────────────────────────
import fs from 'node:fs';
fs.readFile('./02-event-loop-visualizer.js', () => {
  log('Poll 阶段（I/O）', 'fs.readFile 回调');

  // 在 I/O 回调中注册，顺序确定：setImmediate 总先于 setTimeout
  setImmediate(() => log('Check 阶段', 'I/O 回调内的 setImmediate（确定先于 setTimeout）'));
  setTimeout(() => log('Timers 阶段', 'I/O 回调内的 setTimeout 0ms'), 0);
});

log('同步', '同步代码执行完毕，进入事件循环');
