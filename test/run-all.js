// Runs every engine test in sequence (UI tests need a display: see test/ui/).
import { execFileSync } from 'node:child_process';
const tests = ['slice-basic', 'slice-goo', 'goo-reencode', 'repair', 'hollow', 'analysis', 'supports', 'orient'];
for (const t of tests) {
  process.stdout.write(`- ${t} ... `);
  execFileSync(process.execPath, [`test/${t}.test.js`], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log('ok');
}
console.log('all engine tests passed');
