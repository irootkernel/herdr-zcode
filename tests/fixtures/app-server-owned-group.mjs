// Disposable offline process tree. The descendant inherits the leader's owned
// process group, ignores SIGTERM and holds no app-server stdio pipes open.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'descendant') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  process.send({ ready: true });
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.once('message', () => {
    process.stdout.write(JSON.stringify({ method: 'fixture/ready', params: { leaderPid: process.pid, descendantPid: child.pid } }) + '\n');
  });
  process.on('SIGTERM', () => process.exit(0));
  process.stdin.resume();
  process.stdin.on('end', () => { if (process.argv[2] === 'close') process.exit(0); });
  setInterval(() => {}, 1000);
}
