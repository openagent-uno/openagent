import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { _electron as electron, expect, test } from '@playwright/test';
import { ProvidersGateway } from './provider-fixtures.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('profile opening and streaming a long recovered session without losing history', async ({}, info) => {
  const temporary = await mkdtemp(join(tmpdir(), 'openagent-session-profile-'));
  const userData = join(temporary, 'profile'); await mkdir(userData);
  const gateway = await new ProvidersGateway({ webRoot: resolve(ROOT, '../universal/dist'), accountId: 'session-test', networkId: 'session-network', deviceId: 'fixture-device', agentNodeId: 'fixture-agent' }).start();
  gateway.setRunMessages(Array.from({ length: 6000 }, (_, index) => ({
    id: `history-${index}`, role: index % 2 ? 'assistant' : 'user', text: `History ${index % 2 ? 'assistant' : 'prompt'} ${index}`,
    timestamp: 1700000000000 + index * 1000, author: index % 2 ? undefined : { kind: 'human', handle: 'e2e-user' },
  })));
  let app;
  try {
    app = await electron.launch({ args: [ROOT, `--user-data-dir=${userData}`], cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', OPENAGENT_DESKTOP_E2E: '1', OPENAGENT_DESKTOP_E2E_RENDERER_URL: `${gateway.baseUrl}/`, OPENAGENT_DESKTOP_E2E_LOOPBACK: JSON.stringify(gateway.loopbackConfig()), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.evaluate(async ({ port }) => {
      const account = { id:'session-test', name:'Session Fixture', network:'session-network', handle:'e2e-user', agentHandle:'agent', isLocal:true, createdAt:Date.now() };
      await window.desktop.setItem('openagent:accounts', JSON.stringify([account]));
      await window.desktop.setItem('openagent:activeConnection', JSON.stringify({ accountId:account.id, sidecarPort:port }));
    }, { port:Number(new URL(gateway.baseUrl).port) });
    await page.reload();
    await page.getByText('Local capability E2E', { exact:true }).first().click();
    await expect(page.getByText('History assistant 5999', { exact:true })).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    await page.evaluate(() => {
      window.__sessionProfile = { frames:[], longTasks:[], last:performance.now(), stopped:false };
      const state = window.__sessionProfile;
      state.observer = new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(entry => entry.duration)));
      state.observer.observe({ type:'longtask', buffered:false });
      const tick = now => { state.frames.push(now - state.last); state.last = now; if (!state.stopped) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const started = performance.now();
    for (let index=0;index<120;index++) {
      gateway.sendChatFrame({ type:'delta', session_id:'e2e-session', text:` token${index}` });
      await new Promise(done => setTimeout(done, 30));
    }
    await expect(page.getByText(/token119/).last()).toBeVisible();
    const responsiveness = await page.evaluate(() => {
      const state=window.__sessionProfile; state.stopped=true; state.observer.disconnect();
      const frames=[...state.frames].sort((a,b)=>a-b);
      return { frame_count:frames.length, frame_gap_p95_ms:frames[Math.floor(frames.length*.95)], max_frame_gap_ms:Math.max(...frames), long_tasks:state.longTasks };
    });
    const { profile } = await cdp.send('Profiler.stop');
    const label=process.env.OPENAGENT_PERF_LABEL || 'baseline';
    const artifact=join(temporary, `session-${label}.cpuprofile`); await writeFile(artifact,JSON.stringify(profile));
    const result={ benchmark:'long-session-streaming', label, recovered_messages:6000, deltas:120, wall_ms:performance.now()-started, ...responsiveness, page_errors:errors };
    await info.attach('session-profile', { path:artifact, contentType:'application/json' });
    await info.attach('session-performance', { body:Buffer.from(JSON.stringify(result,null,2)), contentType:'application/json' });
    console.log('OPENAGENT_SESSION_PERFORMANCE '+JSON.stringify(result));
    console.log('Session profile:',artifact); expect(errors).toEqual([]);
  } finally { await app?.close(); await gateway.close(); }
});
