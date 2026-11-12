import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { assertNode, readToolchains } from '../lib/toolchain.mjs';
try {
  assertNode();
  const expected = readToolchains().NPM_VERSION;
  if (!process.env.npm_execpath || !process.env.npm_node_execpath ||
      realpathSync(process.env.npm_node_execpath) !== realpathSync(process.execPath)) throw new Error('Use ./dev npm to select the pinned npm runtime');
  const actual = execFileSync(process.execPath, [process.env.npm_execpath, '--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  if (actual !== expected) throw new Error('Expected npm ' + expected + '; actual ' + actual + ' at ' + process.env.npm_execpath + '. Use ./dev npm.');
} catch (error) { console.error('herdr-zcode: ' + error.message); process.exitCode = 1; }
