// Shared display formatting. All timestamps shown to Discord users are
// converted to India Standard Time (IST) with DD/MM/YYYY dates and 24-hour
// HH:mm times, per the bot's display rules.

const IST = 'Asia/Kolkata';

export function formatIST(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return String(date ?? '');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.day}/${values.month}/${values.year} ${values.hour}:${values.minute} IST`;
}

function cocStampToIso(stamp) {
  const year = stamp.slice(0, 4);
  const month = stamp.slice(4, 6);
  const day = stamp.slice(6, 8);
  const hour = stamp.slice(9, 11);
  const minute = stamp.slice(11, 13);
  const second = stamp.slice(13, 15);
  const millis = stamp.match(/\.(\d{1,3})/)?.[1] ?? '000';
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis.padEnd(3, '0')}Z`;
}

export function formatDiscordTimestamps(text) {
  let output = String(text ?? '');

  // CoC API event keys embed a timestamp, e.g. #CLANTAG:20260911T070000.000Z.
  output = output.replace(/(#[A-Z0-9]+:)(\d{8}T\d{6}(?:\.\d{1,3})?Z)/gi, (full, prefix, stamp) => {
    const iso = cocStampToIso(stamp);
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? full : `${prefix}${formatIST(date)}`;
  });

  // Full ISO timestamps returned by the API/database.
  output = output.replace(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})\b/g,
    match => {
      const date = new Date(match);
      return Number.isNaN(date.getTime()) ? match : formatIST(date);
    }
  );

  // Date-only values become Indian DD/MM/YYYY.
  return output.replace(/\b(20\d{2})-(\d{2})-(\d{2})\b/g, (_, year, month, day) => `${day}/${month}/${year}`);
}
