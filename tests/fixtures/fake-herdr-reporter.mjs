#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const command = args[1];
const config = JSON.parse(readFileSync(process.env.REPORTER_CONTROL, 'utf8'));
const record = phase => appendFileSync(process.env.REPORTER_TRACE, `${JSON.stringify({
  phase, pid: process.pid, args, socket: process.env.HERDR_SOCKET_PATH,
})}\n`);
record('start');
if (command === 'release-agent') {
  const allowed = new Set(['--source', '--agent', '--seq']);
  for (let i = 3; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || args[i + 1] === undefined) {
      record('invalid-release');
      process.exit(64);
    }
  }
}
// Deliberately hostile output must never reach the wrapper's protocol/logs.
process.stdout.write('fixture-secret-token\n');
process.stderr.write('fixture-secret-cookie\n');
const behavior = command === 'release-agent' ? (config.release || {}) : config;
if (behavior.hang) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else {
  const finish = () => {
    record('finish');
    process.exitCode = behavior.fail ? 42 : 0;
  };
  if (behavior.gate && !existsSync(behavior.gate)) {
    const timer = setInterval(() => {
      if (existsSync(behavior.gate)) { clearInterval(timer); finish(); }
    }, 10);
  } else finish();
}
