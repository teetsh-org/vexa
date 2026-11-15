/**
 * L3 boundary — the filmed Google Meet stage shows the participant grid and nothing else, in a real
 * headless Chromium over the real `stageMeetingForVideo`.
 *
 * A Meet-shaped fixture: a top bar, a grid with two participants and the bot's own tile, a control
 * bar with the leave button, and a toast at body level. After staging:
 *   1. the other participants' tiles stay visible, the bot's own tile is hidden;
 *   2. the top bar, the control bar and the toast are invisible, yet the leave button still
 *      takes a click (hiding is visual only);
 *   3. a participant whose tile lands outside the grid (a filmstrip beside it) widens the stage,
 *      and the filmstrip, hidden until then, is shown again.
 *
 * Where headless Chromium cannot launch the test SKIPS LOUDLY with exit 0 — the same green-or-skip
 * shape as the other boundary tests.
 * Run: npx tsx src/video-stage.boundary.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPersistentBrowser, type BrowserContext } from '@vexa/remote-browser';
import { stageMeetingForVideo } from './video.js';
import type { Invocation } from './config.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const FIXTURE = `<!doctype html><html><body>
  <div id="call">
    <header id="topbar">8:49 AM | ucb-yafq-whf</header>
    <main id="layout">
      <div id="grid">
        <div data-participant-id="p/alice" id="alice">Alice</div>
        <div data-participant-id="p/bob" id="bob">Bob</div>
        <div data-participant-id="p/bot" id="self">Teetsh Notes</div>
      </div>
      <aside id="filmstrip"></aside>
    </main>
    <footer id="controls"><button id="leave" onclick="window.__left = true">Leave call</button></footer>
  </div>
  <div id="toast" style="position:fixed;bottom:80px;left:40%">Microphone muted by system</div>
</body></html>`;

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'vexa-video-stage-'));
  let context: BrowserContext;
  let page;
  try {
    ({ context, page } = await launchPersistentBrowser({ dataDir, args: ['--no-sandbox', '--mute-audio'], headless: true }));
  } catch (e) {
    console.log(`  ⚠️ SKIP — headless Chromium unavailable in this environment: ${(e as Error).message?.split('\n')[0]}`);
    process.exit(0);
  }
  try {
    await page.setContent(FIXTURE);
    // tsx's keepNames `__name` helper leaks into page.evaluate-serialized functions; shim it.
    await page.evaluate('globalThis.__name = globalThis.__name || ((t, v) => t);');
    const inv: Invocation = {
      platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Teetsh Notes',
      redisUrl: 'redis://localhost:6379',
    };
    await stageMeetingForVideo(page, inv, () => { /* full-screen may fail headless */ });
    await sleep(1300);

    const shown = async (id: string): Promise<boolean> => page.evaluate(`(() => {
      for (let el = document.getElementById(${JSON.stringify(id)}); el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.opacity === '0' || cs.visibility === 'hidden') return false;
      }
      return true;
    })()`) as Promise<boolean>;

    check('the other participants stay visible', (await shown('alice')) && (await shown('bob')));
    check('the bot\'s own tile is hidden', !(await shown('self')));
    check('the top bar is hidden', !(await shown('topbar')));
    check('the control bar is hidden', !(await shown('controls')));
    check('a body-level toast is hidden', !(await shown('toast')));
    check('the filmstrip beside the grid is hidden while empty', !(await shown('filmstrip')));
    await page.click('#leave');
    check('the hidden leave button still takes a click', (await page.evaluate('window.__left === true')) as boolean);

    await page.evaluate(`(() => {
      const t = document.createElement('div');
      t.setAttribute('data-participant-id', 'p/carol'); t.id = 'carol'; t.textContent = 'Carol';
      document.getElementById('filmstrip').appendChild(t);
    })()`);
    await sleep(1300);
    check('a tile outside the grid widens the stage: it is shown', await shown('carol'));
    check('…and the grid stays shown', (await shown('alice')) && (await shown('bob')));
    check('…while the chrome stays hidden', !(await shown('topbar')) && !(await shown('controls')) && !(await shown('toast')));
  } finally {
    await context.close().catch(() => { /* already closed */ });
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (failed) { console.error(`\n❌ video stage (L3): ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ video stage (L3): only the participant grid is filmed; Meet\'s chrome, toasts and the bot\'s own tile are hidden, the leave button still works.');
}

void main();
