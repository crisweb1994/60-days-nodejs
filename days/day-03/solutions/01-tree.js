// Day 03 - 练习 1：目录树生成器

import fs from 'node:fs/promises';
import path from 'node:path';

const IGNORE = new Set(['node_modules', '.git']);

// 解析参数
const args = process.argv.slice(2);
const targetDir = args.find((a) => !a.startsWith('--')) || '.';
const depthArg = args.find((a) => a.startsWith('--depth='));
const maxDepth = depthArg ? parseInt(depthArg.split('=')[1], 10) : Infinity;

let fileCount = 0;
let dirCount = 0;

async function printTree(dir, prefix = '', depth = 0) {
  if (depth > maxDepth) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    console.error(`无法读取目录: ${dir}`);
    return;
  }

  entries = entries.filter((e) => !IGNORE.has(e.name));
  entries.sort((a, b) => {
    // 目录排在文件前面，同类按名称排序
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└──' : '├──';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');

    console.log(`${prefix}${connector} ${entry.name}`);

    if (entry.isDirectory()) {
      dirCount++;
      if (depth < maxDepth) {
        await printTree(path.join(dir, entry.name), childPrefix, depth + 1);
      }
    } else {
      fileCount++;
    }
  }
}

const resolved = path.resolve(targetDir);
console.log(`${path.basename(resolved)}/`);

await printTree(resolved);

console.log();
console.log(`${dirCount} directories, ${fileCount} files`);
