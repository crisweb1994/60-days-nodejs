import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

// Day 40：注册期密码强度策略。和 IsSlug 一个套路——class-validator 的自定义约束。

// 泄露过的「常见密码」黑名单（节选，生产应用完整版如 SecLists / HaveIBeenPwned 的 k-anonymity 查询）。
// 命中即拒：这类密码即便满足复杂度规则，也在全网泄露库里，撞库首选目标。
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789',
  '1234567890', '11111111', '00000000', 'qwerty123', 'qwertyui', 'abc12345',
  'iloveyou', 'letmein', 'letmein1', 'welcome', 'welcome1', 'admin', 'admin123',
  'administrator', 'root', 'toor', 'superman', 'dragon', 'monkey', 'football',
  'baseball', 'master', 'login', 'princess', 'sunshine', 'michael', 'ninja',
]);

@ValidatorConstraint({ name: 'IsStrongPassword', async: false })
export class IsStrongPasswordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (value.length < 8 || value.length > 100) return false;

    // 统计命中的「字符类别」数：小写 / 大写 / 数字 / 符号，至少 3 种。
    // 单一类别（纯小写、纯数字）的密码经不起字典爆破；要求多种类别是拉高熵的最低门槛。
    let classes = 0;
    if (/[a-z]/.test(value)) classes++;
    if (/[A-Z]/.test(value)) classes++;
    if (/[0-9]/.test(value)) classes++;
    if (/[^a-zA-Z0-9]/.test(value)) classes++;
    if (classes < 3) return false;

    // 命中常见密码黑名单直接拒——即便它「看起来」够复杂（如 Passw0rd!）。
    if (COMMON_PASSWORDS.has(value.toLowerCase())) return false;

    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} 强度不足：需 8–100 位、含大小写/数字/符号中的至少 3 种，且不能是常见密码`;
  }
}

/** 注册期校验密码强度（仅作用于注册——登录不做此校验，见 LoginDto 注释）。 */
export function IsStrongPassword(options?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: IsStrongPasswordConstraint,
    });
  };
}
