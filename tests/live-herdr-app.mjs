import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { testHerdrSession, quote } from './helpers/herdr-session.mjs';

if (!process.argv.includes('--authorize-live')) throw new Error('Pass --authorize-live for real ZCode calls in a disposable Herdr session');
const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : 'basic';
if (!['basic', 'permissions', 'subagent', 'question', 'cancel', 'multiline', 'resume', 'coding'].includes(scenario)) throw new Error('Unknown live scenario');
const entryIndex = process.argv.indexOf('--entry');
const entry = entryIndex >= 0 ? resolve(process.argv[entryIndex + 1]) : resolve('bin/herdr-zcode-app.mjs');
const test = await testHerdrSession();
const panes = [], checks = [], started = performance.now();
const mark = 'HZ_READ_' + randomUUID().replaceAll('-', '').slice(0, 12);
const agent = async pane => (await test.agents()).find(value => value.pane_id === pane && value.agent === 'zcode');
const count = (screen, marker) => screen.split(marker).length - 1;
async function boot(label, mode = 'build') {
  const cwd = join(test.directory, label); await mkdir(cwd);
  await writeFile(join(cwd, 'input.txt'), mark + '\n');
  const pane = await test.pane(cwd, label); panes.push(pane);
  await test.run(pane, [process.execPath, entry, '--cwd', cwd, '--mode', mode]);
  await test.until(async () => ['idle', 'done'].includes((await agent(pane))?.agent_status) && (await test.screen(pane)).includes('ZCode session:'), 30000, 'app ready');
  return { pane, cwd };
}
async function submit(pane, prompt) {
  const before = await test.screen(pane);
  await test.send(pane, prompt);
  return { completed: count(before, '[turn completed'), failed: count(before, '[turn failed]') };
}
async function completed(pane, before, timeout = 150000) {
  return test.until(async () => {
    const screen = await test.screen(pane);
    if (count(screen, '[turn failed]') > before.failed) throw Object.assign(new Error('Actual provider/runtime turn failed: ' + screen.slice(-1200)), { fatal: true });
    if (count(screen, '[turn completed') <= before.completed) return false;
    if (!['idle', 'done'].includes((await agent(pane))?.agent_status)) return false;
    return screen;
  }, timeout, 'actual model turn completion');
}
async function permission(pane) {
  await test.until(async () => (await agent(pane))?.agent_status === 'blocked', 90000, 'permission blocked');
  return test.until(async () => {
    const screen = await test.screen(pane);
    const start = screen.lastIndexOf('[permission] ');
    if (start < 0) return false;
    const area = screen.slice(start);
    const match = /^\[permission\] ([^\s:]+):\s+(\S+)/.exec(area);
    if (!match) return false;
    const begin = area.indexOf('{');
    if (begin < 0) return false;
    let depth = 0, quoted = false, escaped = false;
    for (let i = begin; i < area.length; i++) {
      const char = area[i];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) return { id: match[1], tool: match[2], input: JSON.parse(area.slice(begin, i + 1)) };
    }
    return false;
  }, 10000, 'permission input rendered');
}
async function quit(pane) {
  await test.send(pane, '/exit');
  await test.until(async () => {
    if (await agent(pane)) return false;
    const info = (await test.call('pane', 'process-info', '--pane', pane)).process_info;
    return info.foreground_processes?.some(process => /(^|\/)(sh|zsh|bash)$/.test(process.name));
  }, 20000, 'app/server exit and reporter release');
}
try {
  if (scenario === 'basic') {
    const a = await boot('coordinator-a-executor');
    const b = await boot('coordinator-b-executor');
    const beforeA = await submit(a.pane, 'Calculate 17 times 19. Reply with the integer only. Do not use tools.');
    const beforeB = await submit(b.pane, 'Calculate 8 times 13. Reply with the integer only. Do not use tools.');
    await test.until(async () => (await agent(a.pane))?.agent_status === 'working' && (await agent(b.pane))?.agent_status === 'working', 10000, 'simultaneously working executors');
    const [screenA, screenB] = await Promise.all([completed(a.pane, beforeA), completed(b.pane, beforeB)]);
    assert.match(screenA, /(?:^|\n)323(?:\n|$)/); assert.match(screenB, /(?:^|\n)104(?:\n|$)/);
    const sessionA = /ZCode session: (\S+)/.exec(screenA)?.[1], sessionB = /ZCode session: (\S+)/.exec(screenB)?.[1];
    assert.ok(sessionA && sessionB); assert.notEqual(sessionA, sessionB);
    checks.push('two independent live app-server sessions', 'concurrent working/idle state and real generated answers');
    const followup = await submit(a.pane, 'Calculate your previous answer plus 8. Reply with the integer only. Do not use tools.');
    assert.match(await completed(a.pane, followup), /(?:^|\n)331(?:\n|$)/);
    checks.push('same-session follow-up context');
    await quit(a.pane); assert.ok(await agent(b.pane)); await quit(b.pane);
    checks.push('independent release and both foreground shells restored');
  } else if (scenario === 'multiline') {
    const { pane } = await boot('multiline');
    const prompt = 'First number: 17\nSecond number: 19\nMultiply the two numbers above. Reply with the integer only. Do not use tools.';
    const screenBefore = await test.screen(pane);
    // Herdr 0.9.5 reports custom agents but rejects agent.prompt for them.
    // Use the verified pane input surface with one explicit paste boundary.
    await test.raw(['pane', 'send-text', pane, '\x1b[200~' + prompt + '\x1b[201~']);
    await test.raw(['pane', 'send-keys', pane, 'enter']);
    const screen = await completed(pane, { completed: count(screenBefore, '[turn completed'), failed: count(screenBefore, '[turn failed]') });
    assert.match(screen, /(?:^|\n)323(?:\n|$)/);
    assert.equal(count(screen, '[turn completed') - count(screenBefore, '[turn completed'), 1);
    checks.push('Herdr pane input with one bracketed multiline prompt', 'exactly one completed turn and actual answer 323');
    await quit(pane);
  } else if (scenario === 'resume') {
    const { pane, cwd } = await boot('resume');
    const before = await submit(pane, 'Calculate 23 times 29. Reply with the integer only. Do not use tools.');
    const first = await completed(pane, before);
    assert.match(first, /(?:^|\n)667(?:\n|$)/);
    const sessionId = /ZCode session: (\S+)/.exec(first)?.[1];
    assert.ok(sessionId);
    await quit(pane);
    await test.run(pane, [process.execPath, entry, '--cwd', cwd, '--resume', sessionId]);
    await test.until(async () => ['idle', 'done'].includes((await agent(pane))?.agent_status) && count(await test.screen(pane), 'ZCode session: ' + sessionId) >= 2, 30000, 'resumed app ready');
    const resumed = await submit(pane, 'Calculate your last answer plus 4. Reply with the integer only. Do not use tools.');
    const second = await completed(pane, resumed);
    assert.match(second, /(?:^|\n)671(?:\n|$)/);
    checks.push('explicit resume uses the same persisted native session', 'model context survived app-server and wrapper restart');
    await quit(pane);
  } else if (scenario === 'coding') {
    const { pane, cwd } = await boot('coding');
    const code = join(cwd, 'sample.mjs');
    const initial = 'export const double = n => n * 3;\n';
    const expected = 'export const double = n => n * 2;\n';
    const testCommand = quote(process.execPath) + ' --test sample.test.mjs';
    await writeFile(code, initial);
    await writeFile(join(cwd, 'sample.test.mjs'), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { double } from "./sample.mjs";\ntest("double", () => { assert.equal(double(4), 8); assert.equal(double(-3), -6); });\n');
    const before = await submit(pane, 'Fix sample.mjs so double multiplies by two, not three. Read the file, then use Edit to replace only 3 with 2 while preserving every other character. Do not modify sample.test.mjs or other files. Then use Bash exactly once with command ' + testCommand + ', from this working directory, to run the existing test. Do not invoke additional commands, network, or subagents. Wait for required approvals, then report the actual test result.');
    const approved = new Set();
    let sawCode = false, sawBash = false;
    const end = performance.now() + 180000;
    while (performance.now() < end) {
      const screen = await test.screen(pane);
      if (count(screen, '[turn failed]') > before.failed) throw new Error('Actual coding turn failed');
      if (count(screen, '[turn completed') > before.completed && ['idle', 'done'].includes((await agent(pane))?.agent_status)) break;
      if ((await agent(pane))?.agent_status === 'blocked') {
        const item = await permission(pane);
        if (!approved.has(item.id)) {
          if (item.tool === 'Edit') {
            assert.equal(resolve(cwd, item.input.file_path || item.input.path), code);
            const current = await readFile(code, 'utf8');
            assert.equal(typeof item.input.old_string, 'string');
            assert.equal(typeof item.input.new_string, 'string');
            assert.equal(current.replace(item.input.old_string, item.input.new_string), expected);
            sawCode = true;
          } else if (item.tool === 'Write') {
            assert.equal(resolve(cwd, item.input.file_path || item.input.path), code);
            assert.equal(item.input.content, expected); sawCode = true;
          } else if (item.tool === 'Bash') {
            assert.equal(item.input.command?.trim(), testCommand); sawBash = true;
          } else throw new Error('Unexpected requested tool: ' + item.tool);
          approved.add(item.id);
          await test.send(pane, '/allow ' + item.id);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await completed(pane, before, 10000);
    assert.equal(await readFile(code, 'utf8'), expected);
    const run = await promisify(execFile)(process.execPath, ['--test', 'sample.test.mjs'], { cwd, timeout: 15000 });
    assert.match(run.stdout, /pass 1/);
    const screen = await test.screen(pane);
    assert.match(screen, /\[tool\] (?:Edit|Write):/);
    assert.match(screen, /\[tool\] Bash:/);
    checks.push('actual source correction through native Edit/Write', 'native Bash test invocation observed', 'independent node test and exact file-content verification');
    checks.push(`controlled approvals: ${approved.size}; edit=${sawCode}; bash=${sawBash}`);
    await quit(pane);
  } else if (scenario === 'permissions') {
    const { pane, cwd } = await boot('permissions', 'build');
    const allowed = join(cwd, 'allowed.txt'), denied = join(cwd, 'denied.txt');
    let before = await submit(pane, 'Use the Write tool exactly once to create allowed.txt in this working directory with exactly HZ_ALLOWED followed by a newline. Do not use Bash or other tools, do not edit other files. If permission is denied, stop without retrying. Afterward state whether the write succeeded.');
    const allow = await permission(pane);
    assert.equal(allow.tool, 'Write');
    assert.equal(resolve(cwd, allow.input.file_path || allow.input.path), allowed);
    assert.equal(allow.input.content, 'HZ_ALLOWED\n');
    await test.send(pane, '/allow ' + allow.id);
    await completed(pane, before); assert.equal(await readFile(allowed, 'utf8'), 'HZ_ALLOWED\n');
    checks.push('real build-mode Write request displayed and one-time approval executed');
    before = await submit(pane, 'Use the Write tool exactly once to create denied.txt in this working directory with exactly HZ_DENIED followed by a newline. Do not use Bash or other tools and do not edit other files. If permission is denied, stop immediately, do not retry, and report denial.');
    const deny = await permission(pane);
    assert.equal(deny.tool, 'Write');
    assert.equal(resolve(cwd, deny.input.file_path || deny.input.path), denied);
    await test.send(pane, '/deny ' + deny.id);
    await completed(pane, before);
    await assert.rejects(access(denied));
    checks.push('real denial prevented the requested file write');
    await quit(pane);
  } else if (scenario === 'subagent') {
    const { pane } = await boot('native-subagent');
    const before = await submit(pane, 'Use the native Agent tool to launch exactly one Explore subagent. Ask that subagent to use Read to read input.txt in this working directory and return its content. Do not read the file yourself, do not invoke any external CLI, Herdr, or additional agents, and do not modify any files. Wait for the subagent, then return its file content.');
    const screen = await completed(pane, before, 220000);
    assert.match(screen, /\[(?:subagent )?tool\] Agent:/);
    assert.match(screen, /\[subagent\]/);
    assert.ok(screen.includes(mark));
    checks.push('native Agent and child lifecycle events observed', 'child read unknown fixture content and parent returned it');
    await quit(pane);
  } else if (scenario === 'question') {
    const { pane } = await boot('native-question');
    const before = await submit(pane, 'Use AskUserQuestion to ask me which color to choose, with exactly two options named Blue and Red. Do not decide for me. Wait for my response, then reply with the selected color only. Do not call any other tools.');
    await test.until(async () => (await agent(pane))?.agent_status === 'blocked', 90000, 'native question blocked');
    const screen = await test.screen(pane);
    const area = screen.slice(screen.lastIndexOf('[question] '));
    const id = /^\[question\] ([^\s:]+)/.exec(area)?.[1];
    const option = /^\s+([^\s:]+):\s+Blue\b/im.exec(area)?.[1];
    assert.ok(id && option, 'native question and advertised Blue option must be visible');
    await test.send(pane, '/choose ' + id + ' ' + option);
    const answer = await completed(pane, before);
    assert.match(answer, /(?:^|\n)Blue(?:\n|$)/i);
    checks.push('native AskUserQuestion blocked, accepted option, and resumed model turn');
    await quit(pane);
  } else if (scenario === 'cancel') {
    const { pane } = await boot('cancel');
    const before = await submit(pane, 'Output the integers from 1 through 5000, one integer on each line. Start immediately and do not use tools.');
    await test.until(async () => (await agent(pane))?.agent_status === 'working' && /(?:^|\n)1\n2\n/.test(await test.screen(pane)), 60000, 'actual streaming before cancellation');
    await test.raw(['pane', 'send-keys', pane, 'ctrl+c']);
    const cancelled = await completed(pane, before, 30000);
    assert.match(cancelled, /cancelled/);
    const followup = await submit(pane, 'Calculate 9 times 7. Reply with the integer only. Do not use tools.');
    assert.match(await completed(pane, followup), /(?:^|\n)63(?:\n|$)/);
    checks.push('physical terminal Ctrl-C cancelled active generation', 'same app-server/session accepted a subsequent prompt');
    await quit(pane);
  }
  console.log(JSON.stringify({ test: 'live-herdr-app', scenario, passed: true, actualHerdr: true, actualModel: true, entry, checks, elapsedMs: Math.round(performance.now() - started), ownedTestSession: test.name }, null, 2));
} catch (error) {
  console.error('LIVE TEST FAILURE:', error.message);
  for (const pane of panes) { try { console.error(await test.screen(pane)); } catch {} }
  process.exitCode = 1;
} finally { await test.close(); }
