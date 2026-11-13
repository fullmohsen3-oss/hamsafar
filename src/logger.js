'use strict';
/** لاگ ساخت‌یافته ساده (JSON خطی) با سطح‌بندی */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = process.env.LOG_LEVEL && LEVELS[process.env.LOG_LEVEL] ? process.env.LOG_LEVEL : 'info';

function write(level, msg, fields) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const rec = { t: new Date().toISOString(), level, msg, ...fields };
  const line = JSON.stringify(rec, (k, v) => (typeof v === 'bigint' ? Number(v) : v));
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  setLevel: (l) => { if (LEVELS[l]) minLevel = l; },
  debug: (msg, fields = {}) => write('debug', msg, fields),
  info: (msg, fields = {}) => write('info', msg, fields),
  warn: (msg, fields = {}) => write('warn', msg, fields),
  error: (msg, fields = {}) => write('error', msg, fields),
};
