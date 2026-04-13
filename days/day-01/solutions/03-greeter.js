// Day 01 - 练习 3：交互式问候程序

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║         欢迎使用问候程序 👋          ║');
  console.log('╚══════════════════════════════════════╝');
  console.log();

  const name = await ask('请输入你的名字: ');
  const age = await ask('请输入你的年龄: ');
  const ageNum = parseInt(age, 10);

  if (!name) {
    console.log('❌ 名字不能为空！');
    rl.close();
    process.exit(1);
  }

  if (isNaN(ageNum) || ageNum <= 0) {
    console.log('❌ 请输入有效的年龄！');
    rl.close();
    process.exit(1);
  }

  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`👋 你好, ${name}!`);
  console.log(`🎂 你今年 ${ageNum} 岁了`);

  if (ageNum < 18) {
    console.log('🌱 年轻就是资本，加油学习！');
  } else if (ageNum < 30) {
    console.log('🚀 正是最好的年纪，大胆追梦！');
  } else if (ageNum < 40) {
    console.log('💪 经验与活力并存，未来可期！');
  } else {
    console.log('🌟 阅历丰富，正是发光的时候！');
  }

  const birthYear = new Date().getFullYear() - ageNum;
  console.log(`📅 你大约出生于 ${birthYear} 年`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  rl.close();
}

main();
