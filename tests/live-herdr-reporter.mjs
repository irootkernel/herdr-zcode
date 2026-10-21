import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { testHerdrSession } from './helpers/herdr-session.mjs';
if (!process.argv.includes('--authorize-herdr')) throw new Error('Pass --authorize-herdr for a disposable Herdr session');
const test = await testHerdrSession();
const fixture = resolve('tests/fixtures/reporter-herdr-live.mjs');
try {
  const panes = [];
  for (let i = 0; i < 4; i++) {
    const pane = await test.pane(test.directory, 'reporter-' + i); panes.push(pane);
    await test.run(pane, [process.execPath, fixture]);
  }
  const agent = async pane => (await test.agents()).find(item => item.pane_id === pane && item.agent === 'zcode');
  for (const pane of panes) await test.until(async () => ['idle', 'done'].includes((await agent(pane))?.agent_status), 15000, 'reported ready');
  await test.send(panes[0], 'blocked');
  await test.send(panes[1], 'working');
  await test.until(async () => (await agent(panes[0]))?.agent_status === 'blocked', 10000, 'blocked state');
  await test.until(async () => (await agent(panes[1]))?.agent_status === 'working', 10000, 'working state');
  await test.send(panes[1], 'quit');
  await test.until(async () => !(await agent(panes[1])), 10000, 'release');
  assert.equal((await agent(panes[0])).agent_status, 'blocked');
  assert.ok(await agent(panes[2]));
  try {
    await test.until(async () => {
      const info = (await test.call('pane', 'process-info', '--pane', panes[1])).process_info;
      return info.foreground_processes?.some(process => /(^|\/)(sh|zsh|bash)$/.test(process.name));
    }, 10000, 'old reporter returned to shell');
  } catch (error) {
    console.error(JSON.stringify(await test.call('pane', 'process-info', '--pane', panes[1])));
    console.error(await test.screen(panes[1])); throw error;
  }
  await test.run(panes[1], [process.execPath, fixture]);
  try {
    await test.until(async () => ['idle', 'done'].includes((await agent(panes[1]))?.agent_status), 10000, 'same-pane reporter restart');
  } catch (error) { console.error(await test.screen(panes[1])); console.error(JSON.stringify(await agent(panes[1]))); throw error; }
  for (const pane of panes) await test.send(pane, 'quit');
  await test.until(async () => (await test.agents()).every(item => !panes.includes(item.pane_id) || item.agent !== 'zcode'), 10000, 'all releases');
  console.log(JSON.stringify({ test: 'live-herdr-reporter', passed: true, actualHerdr: true, actualModel: false, concurrentReporters: panes.length, independentStates: true, samePaneRestart: true, releases: true, ownedTestSession: test.name }, null, 2));
} finally { await test.close(); }
