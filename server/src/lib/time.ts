export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function nowIso(): string {
  return new Date().toISOString();
}

export function iso(date: Date | number | string): string {
  return new Date(date).toISOString();
}

export function addMinutes(from: Date | string | number, minutes: number): string {
  return new Date(new Date(from).getTime() + minutes * MINUTE).toISOString();
}

export function addDays(from: Date | string | number, days: number): string {
  return new Date(new Date(from).getTime() + days * DAY).toISOString();
}

export function startOfDay(date: Date | string = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date: Date | string = new Date()): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function startOfWeek(date: Date | string = new Date()): Date {
  const d = startOfDay(date);
  const day = (d.getDay() + 6) % 7; // Monday-first
  d.setDate(d.getDate() - day);
  return d;
}

export function startOfMonth(date: Date | string = new Date()): Date {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

export function daysBetween(a: string | Date, b: string | Date = new Date()): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / DAY);
}

export function hoursBetween(a: string | Date, b: string | Date = new Date()): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / HOUR;
}

/** Next weekday morning slot — used when automation schedules "a task tomorrow". */
export function nextBusinessMorning(from: Date | string = new Date(), hour = 9): string {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
