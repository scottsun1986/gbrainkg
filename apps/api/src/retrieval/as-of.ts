import { BadRequestException } from '@nestjs/common';
export function parseAsOf(value: unknown): number {
  if (value === undefined || value === null) return Date.now();
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new BadRequestException('asOf must be an ISO-8601 timestamp with timezone');
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.map(Number);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 || (offsetHour || 0) > 23 || (offsetMinute || 0) > 59) {
    throw new BadRequestException('Invalid asOf timestamp');
  }
  const time = Date.parse(value as string);
  if (!Number.isFinite(time)) throw new BadRequestException('Invalid asOf timestamp');
  return time;
}
