import readline from 'node:readline';
import { createHerdrReporter } from '../../lib/herdr-reporter.mjs';
const reporter = createHerdrReporter({ env: process.env });
const session = 'fixture-session-' + process.pid;
reporter.report('idle', 'Reporter fixture ready', session);
console.log('REPORTER_READY');
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (line.trim() === 'quit') break;
  if (['idle', 'working', 'blocked', 'unknown'].includes(line.trim())) {
    reporter.report(line.trim(), 'Reporter fixture ' + line.trim(), session);
    console.log('REPORTER_STATE=' + line.trim());
  }
}
await reporter.close();
process.stdin.pause();
console.log('REPORTER_RELEASED');
