// Day 13 - 练习 2：图片缩略图生成器
// 使用 child_process 调用 ImageMagick 批量处理图片，支持并行处理与进度显示

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);

// ─── 配置 ─────────────────────────────────────────────────────────────────────
const INPUT_DIR = path.join(__dirname, 'images');       // 原图目录
const OUTPUT_DIR = path.join(__dirname, 'thumbnails');  // 缩略图输出目录
const THUMB_SIZE = '200x200';                           // 缩略图尺寸（等比缩放）
const MAX_CONCURRENCY = 4;                              // 最大并行处理数

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

// 检查 ImageMagick 是否已安装
async function checkImageMagick() {
  try {
    await execAsync('convert --version');
    return true;
  } catch {
    return false;
  }
}

// 获取目录中所有图片文件
function getImageFiles(dir) {
  const exts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
  return fs.readdirSync(dir)
    .filter(file => exts.includes(path.extname(file).toLowerCase()))
    .map(file => path.join(dir, file));
}

// ─── 核心逻辑 ─────────────────────────────────────────────────────────────────

// 使用 spawn 调用 ImageMagick convert 生成单张缩略图
// spawn 相比 exec 更适合处理大文件（流式，无缓冲区限制）
function generateThumbnail(inputPath, outputPath, size) {
  return new Promise((resolve, reject) => {
    const filename = path.basename(inputPath);

    // ImageMagick convert 命令：-thumbnail 等比缩放，^ 裁剪填满，+repage 重置画布
    const child = spawn('convert', [
      inputPath,
      '-thumbnail', `${size}^`,
      '-gravity', 'center',
      '-extent', size,
      '+repage',
      outputPath,
    ]);

    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });

    child.on('close', code => {
      if (code === 0) {
        resolve({ success: true, file: filename, output: outputPath });
      } else {
        reject(new Error(`处理 ${filename} 失败: ${stderr.trim()}`));
      }
    });

    child.on('error', err => {
      reject(new Error(`无法启动 convert 进程: ${err.message}`));
    });
  });
}

// 并发控制：限制同时运行的子进程数量
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let index = 0;
  let completed = 0;
  const total = tasks.length;

  async function runner() {
    while (index < total) {
      const current = index++;
      try {
        const result = await tasks[current]();
        results[current] = result;
        completed++;
        // 显示进度
        const pct = Math.round((completed / total) * 100);
        process.stdout.write(`\r   进度: [${
          '█'.repeat(Math.floor(pct / 5)).padEnd(20, '░')
        }] ${pct}% (${completed}/${total})`);
      } catch (err) {
        results[current] = { success: false, error: err.message };
        completed++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, runner));
  process.stdout.write('\n');
  return results;
}

// ─── 模拟演示（ImageMagick 未安装时）────────────────────────────────────────
// 通过 spawn 调用 node 子进程模拟图片处理过程，演示 child_process 的用法
function simulateThumbnail(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const filename = path.basename(inputPath);

    // 使用 node -e 执行内联脚本，模拟一段耗时处理
    const script = `
      setTimeout(() => {
        process.stdout.write('processed');
        process.exit(0);
      }, Math.random() * 300 + 100);
    `;

    const child = spawn(process.execPath, ['-e', script]);

    let output = '';
    child.stdout.on('data', data => { output += data.toString(); });

    child.on('close', code => {
      if (code === 0 && output.includes('processed')) {
        // 实际演示中写入一个占位文件
        fs.writeFileSync(outputPath, `[模拟缩略图] 原图: ${filename}, 尺寸: ${THUMB_SIZE}`);
        resolve({ success: true, file: filename, output: outputPath, simulated: true });
      } else {
        reject(new Error(`模拟处理 ${filename} 失败`));
      }
    });

    child.on('error', reject);
  });
}

// ─── 准备测试文件（演示模式） ─────────────────────────────────────────────────
function prepareSimulatedImages(dir, count) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const created = [];
  for (let i = 1; i <= count; i++) {
    const filePath = path.join(dir, `sample_${String(i).padStart(2, '0')}.jpg`);
    if (!fs.existsSync(filePath)) {
      // 写入最小合法 JPEG 文件头（仅用于演示，非真实图片）
      fs.writeFileSync(filePath, `[占位图片 ${i}]`);
      created.push(filePath);
    }
  }
  return created;
}

// ─── 主函数 ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║      图片缩略图生成器 v1.0                 ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log();

  // 检查 ImageMagick 是否可用
  const hasImageMagick = await checkImageMagick();

  if (hasImageMagick) {
    console.log('✅ 检测到 ImageMagick，使用真实处理模式');
  } else {
    console.log('⚠️  未检测到 ImageMagick，进入演示模式');
    console.log('   安装方式: brew install imagemagick (macOS)');
    console.log('             apt install imagemagick (Ubuntu)');
    console.log();
  }

  // 准备输入输出目录
  if (!fs.existsSync(INPUT_DIR) || getImageFiles(INPUT_DIR).length === 0) {
    console.log('📂 未找到图片，创建演示用占位图片...');
    prepareSimulatedImages(INPUT_DIR, 8);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const images = getImageFiles(INPUT_DIR);

  if (images.length === 0) {
    console.error('❌ images 目录中没有图片文件');
    process.exit(1);
  }

  console.log(`📁 输入目录:  ${INPUT_DIR}`);
  console.log(`📁 输出目录:  ${OUTPUT_DIR}`);
  console.log(`🖼️  图片数量:  ${images.length} 张`);
  console.log(`📐 缩略图尺寸: ${THUMB_SIZE}`);
  console.log(`⚡ 最大并发:  ${MAX_CONCURRENCY}`);
  console.log();

  // 构建任务列表
  const tasks = images.map(inputPath => {
    const basename = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(OUTPUT_DIR, `${basename}_thumb.jpg`);

    return () => hasImageMagick
      ? generateThumbnail(inputPath, outputPath, THUMB_SIZE)
      : simulateThumbnail(inputPath, outputPath);
  });

  // 并行处理，带进度显示
  console.log('⏳ 开始处理...');
  const startTime = Date.now();
  const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);
  const elapsed = Date.now() - startTime;

  // 统计结果
  const succeeded = results.filter(r => r && r.success);
  const failed = results.filter(r => r && !r.success);

  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 处理结果');
  console.log(`   总数:     ${results.length} 张`);
  console.log(`   成功:     ${succeeded.length} 张`);
  console.log(`   失败:     ${failed.length} 张`);
  console.log(`   耗时:     ${elapsed}ms`);
  console.log(`   平均:     ${(elapsed / results.length).toFixed(0)}ms / 张`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (failed.length > 0) {
    console.log();
    console.log('❌ 失败详情:');
    failed.forEach(r => console.log(`   ${r.error}`));
    process.exit(1);
  }

  console.log();
  console.log('✅ 所有缩略图生成完毕！');
  if (succeeded[0] && succeeded[0].simulated) {
    console.log('   （当前为演示模式，安装 ImageMagick 后可处理真实图片）');
  }
}

main().catch(err => {
  console.error('❌ 发生错误:', err.message);
  process.exit(1);
});
