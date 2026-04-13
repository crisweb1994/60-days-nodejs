// Day 01 - 练习 2：命令行计算器

const args = process.argv.slice(2);
const operation = args[0];
const num1 = parseFloat(args[1]);
const num2 = parseFloat(args[2]);

// 参数验证
if (!operation || isNaN(num1) || isNaN(num2)) {
  console.error('用法: node calc.js <operation> <num1> <num2>');
  console.error('操作: add, subtract, multiply, divide');
  console.error('示例: node calc.js add 3 5');
  process.exit(1);
}

let result;

switch (operation) {
  case 'add':
    result = num1 + num2;
    break;
  case 'subtract':
    result = num1 - num2;
    break;
  case 'multiply':
    result = num1 * num2;
    break;
  case 'divide':
    if (num2 === 0) {
      console.error('错误: 除数不能为零');
      process.exit(1);
    }
    result = num1 / num2;
    break;
  default:
    console.error(`错误: 不支持的操作 "${operation}"`);
    console.error('支持的操作: add, subtract, multiply, divide');
    process.exit(1);
}

console.log(result);
process.exit(0);
