// Cast session controller: drives a UPnP renderer from the normal player.
//
// While a session is active the local audio engine stays silent (`castGate`) and
// the usual transport actions (play/pause/seek/volume/stop/next/previous and
// playing a new track) are re-pointed at the renderer by wrapping them on the
// player store. Because the wrappers sit on the store, the player bar, the
// fullscreen player, the mini player, media keys and shortcuts all follow without
// any per-component change. Queue logic (shuffle, repeat, infinite queue) is
// untouched: advancing still goes through the real `next()`, which ends in
// `playTrack`, which this module turns into a renderer load.
//
// Side-effect module: `MainApp` imports it once at boot.
import { emitPlaybackProgress, emitPlaybackSeek } from '@/features/playback/store/playbackProgress';
import { playbackProfileIdForTrack, usePlayerStore } from '@/features/playback';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import { registerCastController, useCastStore } from '@/features/cast';
import {
  castPause,
  castPlay,
  castSeek,
  castSetVolume,
  castStatus,
  castStop,
  type CastRenderer,
  type CastStatus,
  type CastTrack,
} from '@/lib/api/cast';
import { buildCoverArtUrlForServer, buildStreamUrlForServer } from '@/lib/api/subsonicStreamUrl';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import type { Track } from '@/lib/media/trackTypes';
import { setCastGateActive } from '@/store/castGate';

const POLL_MS = 1000;
/** A renderer track that stopped this close to its end finished naturally. */
const END_TOLERANCE_SECS = 4;
/** After sending a track, the renderer reports stale/STOPPED states while it loads. */
const LOAD_GRACE_MS = 8000;
const MAX_POLL_FAILURES = 6;
/** Ignore the renderer's volume right after the user touched ours, or the slider jumps back. */
const VOLUME_ECHO_GUARD_MS = 2500;
const VOLUME_SEND_DEBOUNCE_MS = 120;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function buildCastTrack(track: Track): CastTrack {
  const profileId = playbackProfileIdForTrack(track);
  const server = findServerByIdOrIndexKey(profileId);
  const art = server && track.coverArt
    ? buildCoverArtUrlForServer(connectBaseUrlForServer(server), server.username, server.password, track.coverArt, 600)
    : null;
  return {
    // Plain server stream, never a `psysonic-local://` or cache URL: the renderer
    // fetches this itself, so it has to be reachable from the LAN.
    url: buildStreamUrlForServer(profileId, track.id),
    title: track.title,
    artist: track.artist || null,
    album: track.album || null,
    artUrl: art,
    mime: track.suffix ?? null,
  };
}

export interface EndDetectionInput {
  /** What we were doing last tick: the last PLAYING sample for the loaded track. */
  lastLive: { position: number; duration: number | null } | null;
  status: CastStatus;
  /** We paused/stopped on purpose, so a STOPPED state is not a finished track. */
  idleExpected: boolean;
  /** Inside the grace window after a track was sent to the renderer. */
  loading: boolean;
}

/**
 * True when the renderer left PLAYING because the track ran out. Renderers differ
 * in how they say so (the Eversolo goes via NO_MEDIA_PRESENT then STOPPED), so
 * accept either, but only when the last position was at the end of the track.
 */
export function isNaturalTrackEnd({ lastLive, status, idleExpected, loading }: EndDetectionInput): boolean {
  if (idleExpected || loading || !lastLive) return false;
  if (status.state !== 'STOPPED' && status.state !== 'NO_MEDIA_PRESENT') return false;
  const duration = lastLive.duration;
  if (duration == null || duration <= 0) return false;
  return lastLive.position >= duration - END_TOLERANCE_SECS;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

type Originals = Pick<
  PlayerState,
  'togglePlay' | 'pause' | 'resume' | 'stop' | 'seek' | 'setVolume' | 'playTrack'
>;

let originals: Originals | null = null;
/** The wrapper functions currently installed on the store, to detect a store reset. */
let installed: Originals | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let failures = 0;
/** We paused or stopped the renderer ourselves. */
let idleExpected = false;
/** Bumped for every track load and on session end; stale async results are dropped. */
let generation = 0;
let loadGraceUntil = 0;
let lastLive: { position: number; duration: number | null } | null = null;
let endHandled = false;
let lastLocalVolumeAt = 0;
let volumeTimer: ReturnType<typeof setTimeout> | null = null;

function session() {
  return useCastStore.getState().session;
}

function active(): boolean {
  return session() !== null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function currentDuration(status?: CastStatus | null): number | null {
  const fromTrack = usePlayerStore.getState().currentTrack?.duration;
  if (fromTrack && fromTrack > 0) return fromTrack;
  return status?.durationSecs && status.durationSecs > 0 ? status.durationSecs : null;
}

function publishPosition(seconds: number, duration: number | null, buffering = false): void {
  const progress = duration ? Math.max(0, Math.min(1, seconds / duration)) : 0;
  emitPlaybackProgress({ currentTime: seconds, progress, buffered: 0, buffering });
  const s = usePlayerStore.getState();
  if (Math.abs(s.currentTime - seconds) > 0.05 || s.progress !== progress) {
    usePlayerStore.setState({ currentTime: seconds, progress });
  }
}

function setPlaying(playing: boolean): void {
  if (usePlayerStore.getState().isPlaying !== playing) usePlayerStore.setState({ isPlaying: playing });
}

async function loadCurrentTrack(startSecs: number): Promise<void> {
  const s = session();
  const { currentTrack, currentRadio } = usePlayerStore.getState();
  if (!s || !currentTrack || currentRadio) return;
  const gen = ++generation;
  idleExpected = false;
  endHandled = false;
  lastLive = null;
  loadGraceUntil = Date.now() + LOAD_GRACE_MS;
  setPlaying(true);
  publishPosition(startSecs, currentDuration(), true);
  try {
    await castPlay(s.renderer, buildCastTrack(currentTrack), startSecs >= 1 ? startSecs : null);
    if (gen === generation) useCastStore.getState().patchSession({ error: null });
  } catch (e) {
    if (gen !== generation) return;
    useCastStore.getState().patchSession({ error: errorMessage(e) });
    setPlaying(false);
  }
}

function mirrorStatus(st: CastStatus): void {
  const duration = currentDuration(st);
  const loading = Date.now() < loadGraceUntil;
  if ((st.state === 'PLAYING' || st.state === 'PAUSED_PLAYBACK') && st.positionSecs != null) {
    lastLive = { position: st.positionSecs, duration };
    publishPosition(st.positionSecs, duration);
  }
  // TRANSITIONING is the renderer buffering, which reads as "playing" to the user.
  const playing = st.state === 'PLAYING' || (st.state === 'TRANSITIONING' && !idleExpected);
  // A just-sent track can still read STOPPED for a moment; do not flicker the icon.
  if (!(loading && !playing && !idleExpected)) setPlaying(playing);
  if (st.volume != null && Date.now() - lastLocalVolumeAt > VOLUME_ECHO_GUARD_MS) {
    const v = Math.max(0, Math.min(1, st.volume / 100));
    if (Math.abs(usePlayerStore.getState().volume - v) > 0.01) usePlayerStore.setState({ volume: v });
  }
}

function advanceAfterNaturalEnd(): void {
  if (endHandled) return;
  endHandled = true;
  const before = usePlayerStore.getState();
  const prevId = before.currentTrack?.id;
  const genBefore = generation;
  before.next(false);
  // `next()` resolves asynchronously. A change of track is picked up by the
  // currentTrack subscription, and the playTrack wrapper reloads a repeated track.
  // If `next()` reached neither (it bypassed the wrapper for repeat-one), reload
  // here, but only when nothing has been loaded in the meantime.
  setTimeout(() => {
    if (!active() || generation !== genBefore) return;
    const now = usePlayerStore.getState();
    if (now.currentTrack?.id === prevId && now.repeatMode === 'one') void loadCurrentTrack(0);
  }, 600);
}

async function tick(): Promise<void> {
  const s = session();
  if (!s || polling) return;
  polling = true;
  const gen = generation;
  try {
    const st = await castStatus(s.renderer);
    if (session()?.renderer.id !== s.renderer.id) return;
    failures = 0;
    useCastStore.getState().patchSession({ status: st, error: null });
    const ended = gen === generation && isNaturalTrackEnd({
      lastLive,
      status: st,
      idleExpected,
      loading: Date.now() < loadGraceUntil,
    });
    mirrorStatus(st);
    if (ended) advanceAfterNaturalEnd();
  } catch (e) {
    failures += 1;
    useCastStore.getState().patchSession({ error: errorMessage(e) });
    if (failures >= MAX_POLL_FAILURES) await endSession(`Lost connection to ${s.renderer.name}`);
  } finally {
    polling = false;
  }
}

function startPolling(): void {
  if (timer) clearInterval(timer);
  failures = 0;
  timer = setInterval(() => void tick(), POLL_MS);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function startSession(renderer: CastRenderer): Promise<void> {
  installWrappers();
  const previous = session();
  if (previous && previous.renderer.id !== renderer.id) {
    void castStop(previous.renderer).catch(() => {});
  }
  const player = usePlayerStore.getState();
  const resumeAt = player.currentTime;
  const wasPlaying = player.isPlaying;
  // Silence the local engine first, then flip the gate so the next playTrack stays off it.
  originals?.pause();
  setCastGateActive(true);
  lastLocalVolumeAt = 0; // adopt the renderer's volume on the first poll
  useCastStore.getState().setSession({ renderer, status: null, error: null });
  generation += 1;
  startPolling();
  if (usePlayerStore.getState().currentTrack && !usePlayerStore.getState().currentRadio) {
    await loadCurrentTrack(resumeAt);
    // Casting a paused track should not blast audio the user did not start.
    if (!wasPlaying) {
      idleExpected = true;
      try {
        await castPause(renderer);
      } catch {
        // renderer may still be loading; the next poll shows the real state
      }
      setPlaying(false);
    }
  }
}

async function endSession(reason?: string): Promise<void> {
  const s = session();
  if (!s) return;
  generation += 1;
  if (timer) clearInterval(timer);
  timer = null;
  if (volumeTimer) clearTimeout(volumeTimer);
  volumeTimer = null;
  setCastGateActive(false);
  useCastStore.getState().setSession(null);
  if (reason) useCastStore.getState().setDiscoverError(reason);
  setPlaying(false);
  try {
    await castStop(s.renderer);
  } catch {
    // device may be gone; nothing more to do
  }
}

// ---------------------------------------------------------------------------
// Store action wrappers
// ---------------------------------------------------------------------------

function installWrappers(): void {
  const s = usePlayerStore.getState();
  // Already ours. After a store reset (tests, HMR) the real actions are back and we wrap again.
  if (installed && s.togglePlay === installed.togglePlay) return;
  const o: Originals = {
    togglePlay: s.togglePlay,
    pause: s.pause,
    resume: s.resume,
    stop: s.stop,
    seek: s.seek,
    setVolume: s.setVolume,
    playTrack: s.playTrack,
  };
  originals = o;

  const pauseCast = () => {
    const sess = session();
    if (!sess) return;
    idleExpected = true;
    setPlaying(false);
    void castPause(sess.renderer).catch(e => useCastStore.getState().patchSession({ error: errorMessage(e) }));
  };

  const resumeCast = () => {
    const sess = session();
    if (!sess) return;
    const state = sess.status?.state;
    // Nothing loaded on the renderer any more (it stopped or ended): load the current track again.
    if (state === 'STOPPED' || state === 'NO_MEDIA_PRESENT' || state == null) {
      void loadCurrentTrack(usePlayerStore.getState().currentTime);
      return;
    }
    idleExpected = false;
    setPlaying(true);
    void castPlay(sess.renderer, null).catch(e => useCastStore.getState().patchSession({ error: errorMessage(e) }));
  };

  const wrappers: Originals = {
    togglePlay: () => {
      if (!active()) return o.togglePlay();
      if (usePlayerStore.getState().isPlaying) pauseCast();
      else resumeCast();
    },
    pause: () => (active() ? pauseCast() : o.pause()),
    resume: () => (active() ? resumeCast() : o.resume()),
    stop: () => {
      const sess = session();
      if (!sess) return o.stop();
      idleExpected = true;
      generation += 1;
      o.stop();
      publishPosition(0, currentDuration());
      void castStop(sess.renderer).catch(e => useCastStore.getState().patchSession({ error: errorMessage(e) }));
    },
    seek: (progress: number) => {
      const sess = session();
      if (!sess) return o.seek(progress);
      const duration = currentDuration(sess.status);
      if (!duration) return;
      const seconds = Math.max(0, Math.min(progress * duration, duration - 0.25));
      publishPosition(seconds, duration);
      emitPlaybackSeek(seconds);
      void castSeek(sess.renderer, seconds).catch(e => useCastStore.getState().patchSession({ error: errorMessage(e) }));
    },
    setVolume: (v: number) => {
      const sess = session();
      if (!sess) return o.setVolume(v);
      const clamped = Math.max(0, Math.min(1, v));
      lastLocalVolumeAt = Date.now();
      usePlayerStore.setState({ volume: clamped });
      if (volumeTimer) clearTimeout(volumeTimer);
      volumeTimer = setTimeout(() => {
        const live = session();
        if (live) void castSetVolume(live.renderer, Math.round(clamped * 100)).catch(() => {});
      }, VOLUME_SEND_DEBOUNCE_MS);
    },
    playTrack: (track, ...rest) => {
      const sameTrack = active() && usePlayerStore.getState().currentTrack?.id === track.id;
      o.playTrack(track, ...rest);
      // A different track is picked up by the subscription below once the store
      // updates; the same track produces no change to observe, so reload it directly.
      if (sameTrack) void loadCurrentTrack(0);
    },
  };
  installed = wrappers;
  usePlayerStore.setState(wrappers);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

usePlayerStore.subscribe((state, prev) => {
  if (!active()) return;
  const id = state.currentTrack?.id;
  if (id && id !== prev.currentTrack?.id && !state.currentRadio) {
    void loadCurrentTrack(0);
  }
});

registerCastController({
  start: startSession,
  stop: () => endSession(),
});
