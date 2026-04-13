// Day 01 - 练习 1：系统信息收集器

const os = require('os');

function formatBytes(bytes) {
  const mb = (bytes / 1024 / 1024).toFixed(2);
  return `${mb} MB`;
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours}h ${minutes}m ${secs}s`;
}

console.log('╔══════════════════════════════════════╗');
console.log('║        系统信息收集器 v1.0           ║');
console.log('╚══════════════════════════════════════╝');
console.log();
console.log('📦 Node.js');
console.log(`   版本:       ${process.version}`);
console.log(`   V8 引擎:    ${process.versions.v8}`);
console.log();
console.log('💻 操作系统');
console.log(`   类型:       ${os.type()} (${os.platform()})`);
console.log(`   版本:       ${os.release()}`);
console.log(`   架构:       ${os.arch()}`);
console.log(`   主机名:     ${os.hostname()}`);
console.log();
console.log('👤 用户');
console.log(`   主目录:     ${os.homedir()}`);
console.log(`   工作目录:   ${process.cwd()}`);
console.log(`   临时目录:   ${os.tmpdir()}`);
console.log();
console.log('🧠 内存');
const totalMem = os.totalmem();
const freeMem = os.freemem();
const usedMem = totalMem - freeMem;
console.log(`   总内存:     ${formatBytes(totalMem)}`);
console.log(`   已使用:     ${formatBytes(usedMem)}`);
console.log(`   空闲:       ${formatBytes(freeMem)}`);
console.log(`   使用率:     ${((usedMem / totalMem) * 100).toFixed(1)}%`);
console.log();

const memUsage = process.memoryUsage();
console.log('📊 进程内存');
console.log(`   RSS:        ${formatBytes(memUsage.rss)}`);
console.log(`   堆总量:     ${formatBytes(memUsage.heapTotal)}`);
console.log(`   堆已用:     ${formatBytes(memUsage.heapUsed)}`);
console.log(`   外部:       ${formatBytes(memUsage.external)}`);
console.log();
console.log('⏱️  运行时间');
console.log(`   系统:       ${formatUptime(os.uptime())}`);
console.log(`   进程:       ${formatUptime(process.uptime())}`);
console.log();
console.log('🔧 CPU');
const cpus = os.cpus();
console.log(`   型号:       ${cpus[0].model}`);
console.log(`   核心数:     ${cpus.length}`);
console.log(`   速度:       ${cpus[0].speed} MHz`);
