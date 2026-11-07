import { useEffect, useState } from 'react';
import { formatManilaClock } from './time.js';

/** Own state so the per-second tick never re-renders the rest of the screen. */
export function PhtClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="nx-clock">
      <span className="nx-label">PHT</span>
      <time dateTime={now.toISOString()}>{formatManilaClock(now)}</time>
    </span>
  );
}
