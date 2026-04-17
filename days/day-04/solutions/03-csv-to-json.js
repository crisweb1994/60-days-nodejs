// Day 04 - 练习 3：CSV 转 JSON 转换器

import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [inputFile, outputFile] = process.argv.slice(2);

if (!inputFile || !outputFile) {
  console.error('用法: node csv-to-json.js <input.csv> <output.json>');
  process.exit(1);
}

// 解析 CSV 行（处理引号包裹的字段）
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // 转义引号 ""
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

let headers = null;
let isFirst = true;
let remainder = '';
let rowCount = 0;

const csvParser = new Transform({
  transform(chunk, _encoding, callback) {
    const text = remainder + chunk.toString('utf-8');
    const lines = text.split('\n');
    remainder = lines.pop(); // 保留不完整的行

    const output = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd(); // 去掉 \r（Windows 换行）
      if (!line) continue;

      if (!headers) {
        headers = parseCsvLine(line);
        // 开始 JSON 数组
        output.push('[\n');
        continue;
      }

      const values = parseCsvLine(line);
      const obj = {};
      headers.forEach((key, i) => {
        obj[key] = values[i] ?? '';
      });

      const prefix = isFirst ? '  ' : ',\n  ';
      output.push(prefix + JSON.stringify(obj));
      isFirst = false;
      rowCount++;
    }

    if (output.length > 0) {
      this.push(output.join(''));
    }
    callback();
  },
  flush(callback) {
    // 处理最后一行（文件末尾无换行）
    if (remainder.trim()) {
      const values = parseCsvLine(remainder.trimEnd());
      const obj = {};
      headers?.forEach((key, i) => {
        obj[key] = values[i] ?? '';
      });
      const prefix = isFirst ? '  ' : ',\n  ';
      this.push(prefix + JSON.stringify(obj));
      rowCount++;
    }

    // 关闭 JSON 数组
    this.push('\n]\n');
    callback();
  },
});

const start = Date.now();

try {
  await pipeline(
    fs.createReadStream(inputFile, { highWaterMark: 64 * 1024 }),
    csvParser,
    fs.createWriteStream(outputFile)
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`✅ 转换完成`);
  console.log(`   输入:   ${inputFile}`);
  console.log(`   输出:   ${outputFile}`);
  console.log(`   行数:   ${rowCount} 条记录`);
  console.log(`   耗时:   ${elapsed}s`);
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`错误: 文件不存在 — ${inputFile}`);
  } else {
    console.error(`错误: ${err.message}`);
  }
  process.exit(1);
}
