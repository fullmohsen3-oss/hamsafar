'use strict';
/** اجرای کل تست‌ها: node test/run.js */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

let failed = 0;
for (const suite of ['unit.js', 'e2e-federation.js']) {
  console.log(`\n━━━━━━━━ ${suite} ━━━━━━━━`);
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit', timeout: 120000 });
  if (r.status !== 0) failed++;
}
console.log(`\n${failed === 0 ? '✅ همه تست‌ها پاس شدند' : '❌ ' + failed + ' مجموعه شکست خورد'}`);
process.exit(failed ? 1 : 0);
