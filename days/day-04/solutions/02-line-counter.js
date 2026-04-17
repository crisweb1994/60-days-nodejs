// Day 04 - 练习 2：大文件行数统计器

import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const filePath = process.argv[2];

if (!filePath) {
  console.error('用法: node line-counter.js <文件路径>');
  process.exit(1);
}

let lineCount = 0;
let byteCount = 0;
let remainder = '';

const counter = new Transform({
  transform(chunk, _encoding, callback) {
    byteCount += chunk.length;

    // 将上一次剩余部分与当前块拼接，避免行在块边界被截断
    const text = remainder + chunk.toString('utf-8');
    const lines = text.split('\n');

    // 最后一个元素可能是不完整的行，留到下次处理
    remainder = lines.pop();
    lineCount += lines.length;

    callback();
  },
  flush(callback) {
    // 文件末尾若还有内容（无换行符结尾），也算一行
    if (remainder.length > 0) {
      lineCount++;
    }
    callback();
  },
});

const start = Date.now();

try {
  await pipeline(
    fs.createReadStream(filePath, { highWaterMark: 64 * 1024 }),
    counter,
    // 不需要写出，丢弃输出
    new Transform({ transform(_c, _e, cb) { cb(); } })
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  const sizeMB = (byteCount / 1024 / 1024).toFixed(2);

  console.log(`文件:   ${filePath}`);
  console.log(`大小:   ${sizeMB} MB`);
  console.log(`行数:   ${lineCount.toLocaleString()}`);
  console.log(`耗时:   ${elapsed}s`);
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`错误: 文件不存在 — ${filePath}`);
  } else {
    console.error(`错误: ${err.message}`);
  }
  process.exit(1);
}
