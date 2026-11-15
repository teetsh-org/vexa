/**
 * Regression — a confirm whose every segment is filtered withdraws the draft it supersedes.
 *
 * A backend answering with one segment per word (Mistral Voxtral at word granularity) makes the
 * prefix confirm map each word to its own segment; the hallucination filter drops every one-word
 * segment, so nothing is confirmed under the draft's id. The window still advances, and the draft
 * published for the old window must be withdrawn: a consumer keys drafts by id, so the next draft
 * never replaces it, and the durable store would keep it as a zero-length row.
 *
 * Model-free and timer-free: requests go through the manager's own submit path, answered by hand,
 * and the consumer is modelled as an upsert-by-id store.
 *
 *   tsx src/filtered-confirm-draft.test.ts
 */
import { SpeakerStreamManager } from './speaker-streams.js';
import { setLogger } from './log.js';

let checks = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✅ ${msg}`);
  checks++;
}
setLogger(() => {});

const SR = 16000, FRAME = 4096, FRAME_MS = (FRAME / SR) * 1000;
const speech = (): Float32Array => { const f = new Float32Array(FRAME); for (let i = 0; i < FRAME; i++) f[i] = 0.1 * Math.sin(i / 7); return f; };
/** One segment per word, 0.4 s apart — the shape of a word-granularity answer. */
const perWord = (text: string) => text.split(' ').map((w, i) => ({ start: i * 0.4, end: i * 0.4 + 0.3, text: ` ${w}` }));

const mgr = new SpeakerStreamManager();
const store = new Map<string, { text: string; completed: boolean }>();
mgr.onSegmentReady = () => {};
mgr.onSegmentPending = (id, _n, text, startMs) => {
  const key = `${id}:${Math.round(startMs)}`;
  if (!text.trim()) store.delete(key); else store.set(key, { text, completed: false });
};
mgr.onSegmentConfirmed = (id, _n, text, startMs) => { store.set(`${id}:${Math.round(startMs)}`, { text, completed: true }); };
const submit = (sid: string) => (mgr as unknown as { trySubmit(id: string): Promise<void> }).trySubmit(sid);
let t = 1_800_000_000_000;
const feed = (sid: string, n: number) => { for (let k = 0; k < n; k++) { mgr.feedAudio(sid, speech(), t); t += FRAME_MS; } };
const drafts = () => [...store.values()].filter((r) => !r.completed);

const SID = 'ch-0:12';
mgr.addSpeaker(SID, 'Speaker');
feed(SID, 12);
await submit(SID);
mgr.handleTranscriptionResult(SID, 'Une sentence. Du coup', 1.5, perWord('Une sentence. Du coup'), 'fr');
ok(drafts().length === 1, 'the first answer goes out as a draft');

feed(SID, 4);
await submit(SID);
const second = 'Une sentence. Du coup moi';
mgr.handleTranscriptionResult(SID, second, 1.9, perWord(second), 'fr');
ok(![...store.values()].some((r) => r.completed), 'every one-word segment of the confirmed prefix is filtered');
ok(drafts().length === 0, `the superseded draft is withdrawn, not left as a row (drafts: ${JSON.stringify(drafts())})`);

mgr.removeAll();
console.log(`\n✅ filtered-confirm-draft: ${checks} checks — a fully filtered confirm leaves no dangling draft.`);
