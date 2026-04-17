// Day 05 - 练习 1：事件循环顺序预测
//
// 预测输出顺序：
//   start
//   end
//   nextTick1
//   nextTick2
//   nextTick3          ← nextTick2 内部嵌套的 nextTick，在当前 nextTick 队列末尾追加
//   promise1
//   nextTick inside promise   ← promise1.then 内注册的 nextTick，在下一个微任务前执行
//   promise2
//   timeout1
//   timeout2
//   immediate1
//   immediate2
//   nextTick inside immediate
//   promise inside immediate

console.log('start');

setTimeout(() => console.log('timeout1'), 0);
setTimeout(() => console.log('timeout2'), 0);

Promise.resolve()
  .then(() => {
    console.log('promise1');
    process.nextTick(() => console.log('nextTick inside promise'));
  })
  .then(() => console.log('promise2'));

process.nextTick(() => console.log('nextTick1'));
process.nextTick(() => {
  console.log('nextTick2');
  process.nextTick(() => console.log('nextTick3'));
});

setImmediate(() => console.log('immediate1'));
setImmediate(() => {
  console.log('immediate2');
  process.nextTick(() => console.log('nextTick inside immediate'));
  Promise.resolve().then(() => console.log('promise inside immediate'));
});

console.log('end');
