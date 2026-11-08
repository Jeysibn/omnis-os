/** Operational timestamps are always presented in Philippine time (Asia/Manila), never browser-local. */
export function formatDate(value: string, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  }).format(new Date(value));
}

/** Same instant as `formatDate`, with seconds and an explicit PHT label for expiry-style values. */
export function formatManilaWithZone(value: string) {
  return `${formatDate(value, { timeStyle: 'medium' })} PHT`;
}
