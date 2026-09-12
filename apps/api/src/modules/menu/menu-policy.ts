import { BadRequestException, ConflictException } from '@nestjs/common';
export function menuError(code: string, message: string): never {
  throw new BadRequestException({ code, message });
}
export function money(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)
  )
    return menuError(
      'INVALID_MENU_PRICE',
      'Price must be a non-negative decimal string with at most 12 whole digits and 2 decimal places.',
    );
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
export function textName(value: string, max: number): string {
  const result = value.trim();
  if (!result || result.length > max)
    return menuError(
      'INVALID_MENU_NAME',
      `Name must contain 1–${max} nonblank characters.`,
    );
  return result;
}
export function optionalText(
  value: string | null | undefined,
  max: number,
): string | null {
  if (value == null || !value.trim()) return null;
  if (value.trim().length > max)
    return menuError('INVALID_MENU_TEXT', 'Text exceeds the allowed length.');
  return value.trim();
}
export function checkVersion(actual: number, expected: number): void {
  if (actual !== expected)
    throw new ConflictException({
      code: 'MENU_VERSION_CONFLICT',
      message: 'This menu entry changed. Refresh it before saving again.',
    });
}
