import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

@ValidatorConstraint({ name: 'IsSlug', async: false })
export class IsSlugConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && value.length <= 80 && SLUG_RE.test(value);
  }
  defaultMessage(args: ValidationArguments): string {
    return `${args.property} 必须是小写字母、数字和连字符组成的 slug（不能以 - 开头/结尾，最长 80）`;
  }
}

export function IsSlug(options?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: IsSlugConstraint,
    });
  };
}
