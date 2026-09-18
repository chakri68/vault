const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Every date and time the family sees is in IST, whatever the device thinks.
 * The documents are Indian, the deadlines are Indian, and a laptop abroad
 * shouldn't move a passport's expiry to the day before. India has no daylight
 * saving, so UTC+5:30 is exact and plain arithmetic is enough.
 */
const IST_OFFSET = 330 * 60_000;

export interface IstParts { year: number; month: number; day: number; hour: number; minute: number }

export function istParts(d: Date): IstParts {
  const s = new Date(d.getTime() + IST_OFFSET);
  return { year: s.getUTCFullYear(), month: s.getUTCMonth(), day: s.getUTCDate(), hour: s.getUTCHours(), minute: s.getUTCMinutes() };
}

/** The instant at which the clock in India reads this. `month` is 0-based, like Date's. */
export function istDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute, second) - IST_OFFSET);
}

/** "2026-09-19", in IST. For filenames and <input type="date">. */
export function istDateStamp(d = new Date()): string {
  const p = istParts(d);
  return `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

const deviceIsOnIst = () => new Date().getTimezoneOffset() === -330;

/** which IST calendar day an instant falls on, as a day number */
const istDayNumber = (d: Date) => Math.floor((d.getTime() + IST_OFFSET) / DAY);

/** Whole calendar days from today. Negative is the past. */
export function daysFromToday(iso: string, now = new Date()): number {
  return istDayNumber(new Date(iso)) - istDayNumber(now);
}

/** Day-month-year, the way the family writes it: "12 Mar 2031". */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = istParts(d);
  return `${p.day} ${MONTHS[p.month]} ${p.year}`;
}

export function formatMonthYear(d = new Date()): string {
  const p = istParts(d);
  return `${MONTHS[p.month]} ${p.year}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "00:14", 24-hour, IST. */
export function formatTime(iso: string): string {
  const p = istParts(new Date(iso));
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Near dates are relative: "today, 00:14", "yesterday", "in 21 days". Far ones are dates. */
export function formatRelative(iso: string, now = new Date()): string {
  const days = daysFromToday(iso, now);
  // On a device that isn't on India's clock, a bare "00:15" would read as local time. Say which clock it is.
  if (days === 0) return `today, ${formatTime(iso)}${deviceIsOnIst() ? "" : " IST"}`;
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  if (days < 0 && days >= -30) return `${-days} days ago`;
  if (days > 0 && days <= 60) return `in ${days} days`;
  return formatDate(iso);
}

/** The small grey bit after an expiry date: "in 4 yrs", "in 3 months", "expired 12 days ago". */
export function formatDistance(iso: string, now = new Date()): string {
  const days = daysFromToday(iso, now);
  const abs = Math.abs(days);
  const unit = abs >= 365 ? `${Math.round(abs / 365)} ${Math.round(abs / 365) === 1 ? "yr" : "yrs"}`
    : abs >= 60 ? `${Math.round(abs / 30)} months`
    : `${abs} ${abs === 1 ? "day" : "days"}`;
  if (days === 0) return "today";
  return days > 0 ? `in ${unit}` : `expired ${unit} ago`;
}

/** "14h 32m", "3 days": for temporary files counting down. */
export function formatCountdown(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return `${h}h ${pad(Math.floor((ms % 3_600_000) / 60_000))}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Document numbers show their first three characters until someone taps Show: "Z12•••••". */
export function maskNumber(value: string): string {
  const compact = value.replace(/\s/g, "");
  if (compact.length <= 3) return "•".repeat(compact.length);
  return compact.slice(0, 3) + "•".repeat(Math.min(compact.length - 3, 8));
}

/** Grouped the way the physical card prints it. Aadhaar in fours; everything else as typed. */
export function formatDocumentNumber(value: string): string {
  const compact = value.replace(/\s/g, "");
  if (/^\d{12}$/.test(compact)) return compact.replace(/(\d{4})(?=\d)/g, "$1 ");
  return value.trim();
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}
