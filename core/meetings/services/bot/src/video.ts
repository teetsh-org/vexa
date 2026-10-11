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
 */
import * as fs from 'fs';
import { VideoRecordingService } from '@vexa/recording';
import type { Invocation } from './config.js';

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
  if (process.env.VEXA_VIDEO_RECORDING !== '1') return null;
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
