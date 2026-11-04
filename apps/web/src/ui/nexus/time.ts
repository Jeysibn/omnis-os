const clockFormat = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const stampFormat = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Philippine time clock, e.g. `14:05:09`. */
export const formatManilaClock = (date: Date): string => clockFormat.format(date);

/** Human-readable Asia/Manila timestamp, e.g. `05 Nov, 14:05:09`. */
export const formatManilaStamp = (iso: string): string => stampFormat.format(new Date(iso));
