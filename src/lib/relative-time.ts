// One shared relative-time formatter for all board timestamps.
// House rule: <60s "now"; <60m "Nm"; <24h "Nh"; <7d "Nd"; else short date
// ("Jul 9", + year if not current year). See docs/FRONTEND.md house rule 5.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function relativeTime(epochMs: number, now: number = Date.now()): string {
  const delta = now - epochMs;

  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d`;

  const date = new Date(epochMs);
  const nowDate = new Date(now);
  const month = MONTHS[date.getMonth()];
  const day = date.getDate();
  const short = `${month} ${day}`;

  return date.getFullYear() === nowDate.getFullYear()
    ? short
    : `${short}, ${date.getFullYear()}`;
}
