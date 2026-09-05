'use strict';

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Current weekday + minutes-since-midnight, in the configured IANA timezone
// (empty timezone means "use whatever this machine is set to").
function localNow(timezone) {
  const now = new Date();
  if (!timezone) {
    return { day: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = Number(get('hour')) % 24;
  return { day: DAY_INDEX[get('weekday')] ?? now.getDay(), minutes: hour * 60 + Number(get('minute')) };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isWithinBusinessHours(businessHours) {
  const { day, minutes } = localNow(businessHours.timezone);
  if (!businessHours.days.includes(day)) return false;
  const start = toMinutes(businessHours.start);
  const end = toMinutes(businessHours.end);
  // An end time earlier than the start means the window runs past midnight.
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

module.exports = { isWithinBusinessHours, localNow };
