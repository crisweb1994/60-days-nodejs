// Day 03 - 练习 2：文件拷贝工具

import fs from 'node:fs/promises';
import { existsSync, createInterface } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [src, dest] = process.argv.slice(2);

if (!src || !dest) {
  console.error('用法: node file-copy.js <源路径> <目标路径>');
  process.exit(1);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function copyFile(srcPath, destPath) {
  // 如果目标已存在，询问是否覆盖
  if (existsSync(destPath)) {
    const answer = await ask(`目标文件已存在: ${destPath}\n是否覆盖? (y/n): `);
    if (answer !== 'y' && answer !== 'yes') {
      console.log('已取消。');
      return;
    }
  }

  // 确保目标目录存在
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  const start = Date.now();
  await fs.copyFile(srcPath, destPath);
  const elapsed = Date.now() - start;

  const stats = await fs.stat(destPath);
  console.log(`✅ 文件复制完成`);
  console.log(`   ${srcPath} → ${destPath}`);
  console.log(`   大小: ${stats.size} 字节  耗时: ${elapsed}ms`);
}

async function copyDir(srcDir, destDir) {
  if (existsSync(destDir)) {
    const answer = await ask(`目标目录已存在: ${destDir}\n是否覆盖其中的文件? (y/n): `);
    if (answer !== 'y' && answer !== 'yes') {
      console.log('已取消。');
      return;
    }
  }

  await fs.mkdir(destDir, { recursive: true });

  const start = Date.now();
  let fileCount = 0;

  async function walk(src, dest) {
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        await walk(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
        fileCount++;
        process.stdout.write(`\r   已复制 ${fileCount} 个文件...`);
      }
    }
  }

  await walk(srcDir, destDir);
  const elapsed = Date.now() - start;
  console.log();
  console.log(`✅ 目录复制完成`);
  console.log(`   ${srcDir} → ${destDir}`);
  console.log(`   共 ${fileCount} 个文件  耗时: ${elapsed}ms`);
}

// 主逻辑
try {
  const srcStats = await fs.stat(src);
  if (srcStats.isDirectory()) {
    await copyDir(src, dest);
  } else {
    await copyFile(src, dest);
  }
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`错误: 源路径不存在 — ${src}`);
  } else if (err.code === 'EACCES') {
    console.error(`错误: 权限不足 — ${err.path}`);
  } else {
    console.error(`错误: ${err.message}`);
  }
  process.exit(1);
}
