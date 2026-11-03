import { invoke } from '@tauri-apps/api/core';

// While a track is cast to a network renderer the local audio engine must stay
// silent: `playTrack` still runs (queue, history, UI state), but `audio_play`
// would start the PC's own output. The cast session controller
// (`src/app/castSession.ts`) flips this flag; the playback engine only asks.
// Lives in `store/` (imports nothing from features) so playback can read it
// without depending on the cast feature.
let castGateActive = false;

export function setCastGateActive(active: boolean): void {
  castGateActive = active;
}

export function isCastGateActive(): boolean {
  return castGateActive;
}

/** `invoke('audio_play', args)` unless a cast session owns playback. */
export function invokeAudioPlayUnlessCasting(args: Record<string, unknown>): Promise<unknown> {
  return castGateActive ? Promise.resolve() : invoke('audio_play', args);
}
