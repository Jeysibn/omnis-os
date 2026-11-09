import { formatDate } from '../manilaTime.js';

const clockFormat = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Philippine wall-clock reading to the minute, e.g. `Mon, Nov 09, 14:05`. */
export const formatManilaClock = (date: Date): string => clockFormat.format(date);

/** A recorded timestamp in Asia/Manila (shares the application formatter fixed in PR #89). */
export const formatManilaStamp = (iso: string): string => formatDate(iso);

/** Milliseconds until the next whole minute, so the clock re-renders once a minute, not per second. */
export const msUntilNextMinute = (now: number): number => 60_000 - (now % 60_000) + 50;
