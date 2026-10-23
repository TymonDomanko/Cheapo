// A tiny cron scheduler, so the home collector needs no npm packages (it can
// then run from a single executable). Supports the usual five fields —
// minute hour day-of-month month day-of-week — with *, numbers, lists (1,15),
// ranges (1-5) and steps (*/15), in a given IANA time zone.

const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function parseField(text, [min, max]) {
  const out = new Set();
  for (const part of String(text).split(',')) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) throw new Error(`Bad cron field "${text}"`);
    const start = m[1] === '*' ? min : Number(m[1]);
    const end = m[2] != null ? Number(m[2]) : m[1] === '*' || m[3] ? max : start;
    const step = m[3] ? Number(m[3]) : 1;
    if (start < min || end > max || start > end || step < 1) throw new Error(`Bad cron field "${text}"`);
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron needs 5 fields (minute hour day month weekday): "${expr}"`);
  const fields = parts.map((p, i) => parseField(p, i === 4 ? [0, 7] : FIELDS[i]));
  if (fields[4].delete(7)) fields[4].add(0); // Sunday can be 0 or 7
  return fields;
}

const formatters = new Map();

/** Calendar parts of a moment in a time zone. */
function partsIn(date, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-AU', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), weekday };
}

const hourMatches = (fields, t) => fields[1].has(t.hour) && fields[2].has(t.day) && fields[3].has(t.month) && fields[4].has(t.weekday);

export function matches(fields, date, timeZone) {
  const t = partsIn(date, timeZone);
  return fields[0].has(t.minute) && hourMatches(fields, t);
}

/** The next minute (after `from`) the schedule fires. */
export function nextRun(expr, from = new Date(), timeZone = undefined) {
  const fields = parseCron(expr);
  let ms = Math.floor(from.getTime() / 60000) * 60000 + 60000;
  const limit = ms + 4 * 366 * 24 * 3600000;
  while (ms < limit) {
    const t = partsIn(new Date(ms), timeZone);
    if (!hourMatches(fields, t)) ms += (60 - t.minute) * 60000; // skip to the next hour
    else if (fields[0].has(t.minute)) return new Date(ms);
    else ms += 60000;
  }
  throw new Error(`Cron "${expr}" never fires`);
}

/** Run `fn` on the schedule. Returns a stop() function. */
export function schedule(expr, fn, { timezone } = {}) {
  let timer;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const wait = Math.max(1000, nextRun(expr, new Date(), timezone).getTime() - Date.now());
    // Long waits are re-checked hourly so sleep/clock changes don't throw them off.
    timer = setTimeout(() => {
      if (matches(parseCron(expr), new Date(Math.round(Date.now() / 60000) * 60000), timezone)) {
        Promise.resolve().then(fn).catch(() => {});
        setTimeout(arm, 61000);
      } else arm();
    }, Math.min(wait, 3600000));
  };
  arm();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
