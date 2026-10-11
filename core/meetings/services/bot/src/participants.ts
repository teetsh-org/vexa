/**
 * Meeting participants seen by the capture side: speaker label → the platform's participant id
 * (Google Meet's data-participant-id). The bot process serves ONE meeting, so the registry is
 * process-wide: the capture bridge records, the transcript egress (pipeline.ts toBotSegment)
 * stamps `speaker_id` from it.
 */
const idByLabel = new Map<string, string>();

export function recordParticipant(label: string, participantId: string): void {
  if (label && participantId) idByLabel.set(label, participantId);
}

export function participantIdFor(label: string | undefined): string | undefined {
  return label ? idByLabel.get(label) : undefined;
}
