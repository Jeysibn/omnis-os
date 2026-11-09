import { useEffect, useState } from 'react';
import { formatManilaClock, msUntilNextMinute } from './time.js';

/**
 * Asia/Manila clock. It owns its own state and re-renders once a minute, aligned to the minute
 * boundary (not per second), so it never re-renders the rest of the screen. It re-syncs when the
 * tab becomes visible again, and clears its timer on unmount.
 */
export function PhtClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, msUntilNextMinute(Date.now()));
    };
    const resync = () => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(timer);
      setNow(new Date());
      schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', resync);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', resync);
    };
  }, []);
  return (
    <span className="ccx-clock">
      <time dateTime={now.toISOString()}>{formatManilaClock(now)}</time>{' '}
      <abbr title="Philippine Standard Time, Asia/Manila (UTC+8)">PHT</abbr>
    </span>
  );
}
