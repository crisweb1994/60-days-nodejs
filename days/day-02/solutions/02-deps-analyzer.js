// Day 02 - 练习 2：依赖分析器

const fs = require('fs');
const path = require('path');

const targetDir = process.argv[2] || process.cwd();
const pkgPath = path.join(targetDir, 'package.json');

// 1. 读取 package.json
if (!fs.existsSync(pkgPath)) {
  console.error(`错误: 未找到 ${pkgPath}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

console.log('╔══════════════════════════════════════╗');
console.log('║          依赖分析器 v1.0             ║');
console.log('╚══════════════════════════════════════╝');
console.log();
console.log(`📦 项目: ${pkg.name || '(未命名)'} v${pkg.version || '0.0.0'}`);
console.log();

// 2. 列出 dependencies
const deps = pkg.dependencies || {};
const depKeys = Object.keys(deps).sort();

console.log(`🔗 生产依赖 (${depKeys.length}):`);
if (depKeys.length === 0) {
  console.log('   (无)');
} else {
  depKeys.forEach((name) => {
    console.log(`   ${name.padEnd(30)} ${deps[name]}`);
  });
}
console.log();

// 3. 列出 devDependencies
const devDeps = pkg.devDependencies || {};
const devDepKeys = Object.keys(devDeps).sort();

console.log(`🛠️  开发依赖 (${devDepKeys.length}):`);
if (devDepKeys.length === 0) {
  console.log('   (无)');
} else {
  devDepKeys.forEach((name) => {
    console.log(`   ${name.padEnd(30)} ${devDeps[name]}`);
  });
}
console.log();

// 4. 检查锁文件
console.log('🔒 锁文件:');
const lockFiles = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];
let foundLock = false;
lockFiles.forEach((file) => {
  const exists = fs.existsSync(path.join(targetDir, file));
  if (exists) foundLock = true;
  console.log(`   ${exists ? '✅' : '❌'} ${file}`);
});
if (!foundLock) {
  console.log('   ⚠️  未找到任何锁文件，建议运行 pnpm install');
}
console.log();

// 5. 输出统计信息
const total = depKeys.length + devDepKeys.length;
console.log('📊 统计:');
console.log(`   总依赖数量:   ${total}`);
console.log(`   生产依赖:     ${depKeys.length}`);
console.log(`   开发依赖:     ${devDepKeys.length}`);
console.log(`   模块类型:     ${pkg.type || 'commonjs (默认)'}`);
