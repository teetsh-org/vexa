/**
 * Video recording (VEXA_VIDEO_RECORDING=1) — films the bot's Xvfb display (the rendered meeting
 * page) for as long as the audio recording tap runs, then muxes a local copy of the audio chunks
 * into it and uploads ONE video MediaFile (media_type=video) to the same internal recordings
 * endpoint the audio parts use. The audio recording itself is unchanged: video rides beside it.
 *
 * Alignment: ffmpeg starts before the page-side MediaRecorder, and the tap reports its t=0
 * (MediaRecorder.onstart) through `audioStarted()`, so the audio is offset by exactly the gap.
 *
 * Encoding is configured by @vexa/recording's VideoRecordingService env (ENCODE_H264, VIDEO_HEIGHT,
 * VIDEO_HWACCEL). The upload happens once, at teardown, inside the bot's SIGTERM grace.
 *
 * The display is filmed as-is, so `stageMeetingForVideo` first makes it a clean stage: the browser
 * window full screen (no tab strip, address bar, infobar or WM toolbar in frame) and, on Google
 * Meet, the bot's own tile and Meet's device-warning popovers made invisible. Hiding is visual
 * only (visibility/opacity): the DOM stays intact for speaker detection and for the leave flow.
 */
import * as fs from 'fs';
import { VideoRecordingService } from '@vexa/recording';
import type { Page } from '@vexa/remote-browser';
import type { Invocation } from './config.js';

export const videoRecordingEnabled = (): boolean => process.env.VEXA_VIDEO_RECORDING === '1';

/** Full-screen the bot's browser window and keep the bot's own UI out of frame. Never throws. */
export async function stageMeetingForVideo(page: Page, inv: Invocation, log: (msg: string) => void): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
    await cdp.detach().catch(() => { /* already gone */ });
  } catch (e) {
    log(`video: full-screen failed: ${String(e)}`);
  }
  if (inv.platform !== 'google_meet') return;
  await page.evaluate((botName: string) => {
    // Runs page-side; the bot compiles without the DOM lib, hence the untyped globals.
    const g = globalThis as any;
    const doc = g.document;
    if (g.__vexaVideoStage) return;
    // Meet's device warnings ("Camera not found", "Microphone not found"): the bot has no devices
    // by design, so the warning is noise in every frame it covers.
    const DEVICE_WARNING = /(camera|microphone|caméra|micro)[^.]{0,40}(not found|introuvable|aucun)|(no|aucune?) (camera|microphone|caméra|micro)/i;
    // The bot's tile: Meet's self marker when it renders inside the tile, else the tile that
    // carries the bot's display name (a guest bot's tile has no self marker).
    const selfTiles = (): any[] => {
      const marked = doc.querySelector('[data-self-name]')?.closest('[data-participant-id]');
      const named = botName
        ? Array.from(doc.querySelectorAll('[data-participant-id]')).filter((t: any) => {
          const id = t.getAttribute('data-participant-id');
          // A tile, not a container of other participants' tiles.
          const nestsOthers = Array.from(t.querySelectorAll('[data-participant-id]')).some((d: any) => d.getAttribute('data-participant-id') !== id);
          return !nestsOthers && (t.textContent || '').includes(botName);
        })
        : [];
      return marked ? [marked, ...named] : named;
    };
    const hideSelf = (): void => {
      for (const tile of selfTiles()) {
        if (tile.style.visibility === 'hidden') continue;
        tile.style.setProperty('visibility', 'hidden', 'important');
        console.log(`[video-stage] hid own tile ${tile.getAttribute('data-participant-id')}`);
      }
    };
    const hideDeviceWarnings = (): void => {
      const walker = doc.createTreeWalker(doc.body, g.NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!DEVICE_WARNING.test(n.textContent || '')) continue;
        // The popover is the outermost floating (fixed/absolute) ancestor that is still popover-sized
        // — never the call layout, whose containers are positioned too.
        const maxArea = g.innerWidth * g.innerHeight / 4;
        let popover: any = null;
        for (let el = n.parentElement; el && el !== doc.body; el = el.parentElement) {
          const pos = g.getComputedStyle(el).position;
          const r = el.getBoundingClientRect();
          if ((pos === 'fixed' || pos === 'absolute') && r.width * r.height < maxArea) popover = el;
        }
        popover?.style.setProperty('opacity', '0', 'important');
      }
    };
    g.__vexaVideoStage = setInterval(() => { try { hideSelf(); hideDeviceWarnings(); } catch { /* next tick */ } }, 1000);
  }, inv.botName ?? '').catch((e) => log(`video: stage script failed: ${String(e)}`));
}

export interface BotVideoRecording {
  /** One audio recording chunk, in seq order — appended to the local copy muxed at the end. */
  audioChunk(bytes: Uint8Array): void;
  /** The audio master's t=0 (MediaRecorder.onstart). */
  audioStarted(): void;
  /** Stop ffmpeg, mux the audio in, upload. Never throws. */
  finish(): Promise<void>;
}

/** Starts filming when VEXA_VIDEO_RECORDING=1; returns null (no video) otherwise. */
export function startBotVideoRecording(inv: Invocation, log: (msg: string) => void): BotVideoRecording | null {
  if (!videoRecordingEnabled()) return null;
  const sessionUid = inv.connectionId ?? '';
  const video = new VideoRecordingService(inv.meeting_id ?? 0, sessionUid);
  const audioPath = `/tmp/video_audio_${sessionUid || 'session'}.webm`;
  let audioStartedAt = 0;
  let finished = false;
  fs.rmSync(audioPath, { force: true });
  video.start();

  return {
    audioChunk: (bytes) => {
      if (bytes.length) fs.appendFileSync(audioPath, bytes);
    },
    audioStarted: () => {
      if (!audioStartedAt) audioStartedAt = Date.now();
    },
    async finish() {
      if (finished) return;
      finished = true;
      try {
        await video.stop();
        if (fs.existsSync(audioPath)) {
          const delayMs = audioStartedAt ? audioStartedAt - video.getStartTime() : 0;
          await video.muxAudio(audioPath, delayMs);
        }
        if (inv.recordingUploadUrl) await video.upload(inv.recordingUploadUrl, inv.internalSecret ?? '');
        else log('video: no recordingUploadUrl — video NOT uploaded');
      } catch (e) {
        log(`video: finish failed: ${String(e)}`);
      } finally {
        await video.cleanup();
        fs.rmSync(audioPath, { force: true });
      }
    },
  };
}
