// Day 03 - 练习 3：Markdown 文档索引生成器

import fs from 'node:fs/promises';
import path from 'node:path';

const docsDir = process.argv[2];

if (!docsDir) {
  console.error('用法: node md-indexer.js <文档目录>');
  process.exit(1);
}

const resolved = path.resolve(docsDir);

// 递归收集所有 .md 文件
async function collectMdFiles(dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectMdFiles(fullPath);
      results.push(...sub);
    } else if (entry.name.endsWith('.md') && entry.name !== 'INDEX.md') {
      results.push(fullPath);
    }
  }

  return results;
}

// 提取文件的一级标题
async function extractTitle(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : path.basename(filePath, '.md');
}

// 按目录结构组织文件
function groupByDir(files, baseDir) {
  const tree = {};
  for (const file of files) {
    const rel = path.relative(baseDir, file);
    const dir = path.dirname(rel);
    if (!tree[dir]) tree[dir] = [];
    tree[dir].push(rel);
  }
  return tree;
}

// 生成索引内容
async function buildIndex(files, baseDir) {
  const grouped = groupByDir(files, baseDir);
  const lines = ['# 文档索引', '', `> 自动生成于 ${new Date().toLocaleString()}`, ''];

  const dirs = Object.keys(grouped).sort();

  for (const dir of dirs) {
    if (dir !== '.') {
      lines.push(`## ${dir}`);
      lines.push('');
    }

    for (const relPath of grouped[dir].sort()) {
      const fullPath = path.join(baseDir, relPath);
      const title = await extractTitle(fullPath);
      const link = relPath.replace(/\\/g, '/');
      lines.push(`- [${title}](./${link})`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

const files = await collectMdFiles(resolved);

if (files.length === 0) {
  console.log('未找到任何 .md 文件。');
  process.exit(0);
}

console.log(`找到 ${files.length} 个 Markdown 文件，正在生成索引...`);

const content = await buildIndex(files, resolved);
const outputPath = path.join(resolved, 'INDEX.md');
await fs.writeFile(outputPath, content, 'utf-8');

console.log(`✅ 索引已生成: ${outputPath}`);
