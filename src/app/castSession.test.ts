import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CastRenderer, CastStatus } from '@/lib/api/cast';

vi.mock('@/lib/api/cast', () => ({
  castListRenderers: vi.fn(async () => []),
  castPlay: vi.fn(async () => null),
  castSetNext: vi.fn(async () => null),
  castPause: vi.fn(async () => null),
  castStop: vi.fn(async () => null),
  castSeek: vi.fn(async () => null),
  castSetVolume: vi.fn(async () => null),
  castStatus: vi.fn(async () => ({
    state: 'STOPPED', positionSecs: null, durationSecs: null, trackUri: '', volume: null, muted: null,
  })),
}));

vi.mock('@/lib/api/audio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/audio')>()),
  audioPause: vi.fn(async () => undefined),
  audioStop: vi.fn(async () => undefined),
}));

vi.mock('@/lib/api/subsonicStreamUrl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/subsonicStreamUrl')>()),
  buildStreamUrlForServer: vi.fn((_sid: string, id: string) => `http://192.168.1.10:4533/rest/stream.view?id=${id}&u=me`),
}));

import * as castApi from '@/lib/api/cast';
import { buildCastTrack, isNaturalTrackEnd } from '@/app/castSession';
import { getCastController, useCastStore } from '@/features/cast';
import { usePlayerStore } from '@/features/playback';
import { isCastGateActive } from '@/store/castGate';
import { makeTrack } from '@/test/helpers/factories';
import { resetPlayerStore } from '@/test/helpers/storeReset';

const renderer: CastRenderer = {
  id: 'uuid:test',
  name: 'Living Room',
  manufacturer: 'Acme',
  model: 'R1',
  location: 'http://192.168.1.50:1670/description.xml',
  avControlUrl: 'http://192.168.1.50:1670/AVTransport/control.xml',
  avServiceType: 'urn:schemas-upnp-org:service:AVTransport:1',
  rcControlUrl: 'http://192.168.1.50:1670/RenderingControl/control.xml',
  rcServiceType: 'urn:schemas-upnp-org:service:RenderingControl:1',
};

function status(over: Partial<CastStatus> = {}): CastStatus {
  return { state: 'PLAYING', positionSecs: 10, durationSecs: 180, trackUri: '', volume: null, muted: null, ...over };
}

describe('isNaturalTrackEnd', () => {
  const live = { position: 178, duration: 180 };
  const base = { lastLive: live, status: status({ state: 'STOPPED', positionSecs: null }), idleExpected: false, loading: false };

  it('is true when a renderer stops at the end of the track', () => {
    expect(isNaturalTrackEnd(base)).toBe(true);
    expect(isNaturalTrackEnd({ ...base, status: status({ state: 'NO_MEDIA_PRESENT' }) })).toBe(true);
  });

  it('is false when we stopped it ourselves or it is still loading', () => {
    expect(isNaturalTrackEnd({ ...base, idleExpected: true })).toBe(false);
    expect(isNaturalTrackEnd({ ...base, loading: true })).toBe(false);
  });

  it('is false when the track was cut short, still playing, or the length is unknown', () => {
    expect(isNaturalTrackEnd({ ...base, lastLive: { position: 60, duration: 180 } })).toBe(false);
    expect(isNaturalTrackEnd({ ...base, status: status({ state: 'PLAYING' }) })).toBe(false);
    expect(isNaturalTrackEnd({ ...base, status: status({ state: 'PAUSED_PLAYBACK' }) })).toBe(false);
    expect(isNaturalTrackEnd({ ...base, lastLive: { position: 178, duration: null } })).toBe(false);
    expect(isNaturalTrackEnd({ ...base, lastLive: null })).toBe(false);
  });
});

describe('buildCastTrack', () => {
  it('maps a track to a LAN-fetchable stream and its metadata', () => {
    const t = makeTrack({ id: 'abc', title: 'T', artist: 'A', album: 'B', suffix: 'flac', coverArt: undefined });
    expect(buildCastTrack(t)).toEqual({
      url: 'http://192.168.1.10:4533/rest/stream.view?id=abc&u=me',
      title: 'T',
      artist: 'A',
      album: 'B',
      artUrl: null,
      mime: 'flac',
    });
  });
});

describe('cast session controller', () => {
  const track = makeTrack({ id: 'song-1', duration: 180 });
  let originalNext: Mock<(manual?: boolean) => void>;
  let originalToggle: Mock<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetPlayerStore();
    useCastStore.setState({ session: null, renderers: [], discovering: false, discoverError: null });
    originalNext = vi.fn<(manual?: boolean) => void>();
    originalToggle = vi.fn<() => void>();
    usePlayerStore.setState({
      currentTrack: track,
      isPlaying: true,
      currentTime: 42,
      volume: 0.8,
      next: originalNext,
      togglePlay: originalToggle,
    });
  });

  afterEach(async () => {
    await getCastController()?.stop();
    vi.useRealTimers();
  });

  it('silences local playback and loads the current track at its position', async () => {
    await getCastController()!.start(renderer);

    expect(isCastGateActive()).toBe(true);
    expect(useCastStore.getState().session?.renderer.id).toBe('uuid:test');
    expect(castApi.castPlay).toHaveBeenCalledWith(
      renderer,
      expect.objectContaining({ url: expect.stringContaining('id=song-1'), title: track.title }),
      42,
    );
  });

  it('routes play/pause to the renderer while casting and to the engine otherwise', async () => {
    await getCastController()!.start(renderer);
    usePlayerStore.getState().togglePlay();
    expect(castApi.castPause).toHaveBeenCalledWith(renderer);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(originalToggle).not.toHaveBeenCalled();

    useCastStore.getState().patchSession({ status: status({ state: 'PAUSED_PLAYBACK' }) });
    usePlayerStore.getState().togglePlay();
    expect(castApi.castPlay).toHaveBeenLastCalledWith(renderer, null);
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    await getCastController()!.stop();
    usePlayerStore.getState().togglePlay();
    expect(originalToggle).toHaveBeenCalledTimes(1);
    expect(isCastGateActive()).toBe(false);
  });

  it('seeks the renderer by fraction of the track length', async () => {
    await getCastController()!.start(renderer);
    usePlayerStore.getState().seek(0.5);
    expect(castApi.castSeek).toHaveBeenCalledWith(renderer, 90);
    expect(usePlayerStore.getState().currentTime).toBe(90);
  });

  it('sends renderer volume 0-100, debounced, without touching the local engine volume', async () => {
    await getCastController()!.start(renderer);
    usePlayerStore.getState().setVolume(0.3);
    usePlayerStore.getState().setVolume(0.4);
    expect(castApi.castSetVolume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(castApi.castSetVolume).toHaveBeenCalledTimes(1);
    expect(castApi.castSetVolume).toHaveBeenCalledWith(renderer, 40);
    expect(usePlayerStore.getState().volume).toBe(0.4);
  });

  it('mirrors renderer position and play state into the player store while polling', async () => {
    vi.mocked(castApi.castStatus).mockResolvedValue(status({ state: 'PLAYING', positionSecs: 25, volume: 55 }));
    await getCastController()!.start(renderer);
    await vi.advanceTimersByTimeAsync(5000); // past the post-load stale-report hold

    const s = usePlayerStore.getState();
    // The mock keeps reporting 25, so the local clock is nudged back toward it each poll.
    expect(s.currentTime).toBeGreaterThanOrEqual(25);
    expect(s.currentTime).toBeLessThan(28);
    expect(s.isPlaying).toBe(true);
    expect(s.volume).toBeCloseTo(0.55);
    expect(useCastStore.getState().session?.status?.state).toBe('PLAYING');
  });

  it('ignores a stale renderer position right after a seek instead of jumping back', async () => {
    vi.mocked(castApi.castStatus).mockResolvedValue(status({ state: 'PLAYING', positionSecs: 10 }));
    await getCastController()!.start(renderer);
    await vi.advanceTimersByTimeAsync(5000);
    usePlayerStore.getState().seek(0.5); // 90s; the renderer keeps reporting ~10s for a moment
    await vi.advanceTimersByTimeAsync(1100);
    expect(usePlayerStore.getState().currentTime).toBeGreaterThanOrEqual(90);

    vi.mocked(castApi.castStatus).mockResolvedValue(status({ state: 'PLAYING', positionSecs: 92 }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(usePlayerStore.getState().currentTime).toBeGreaterThanOrEqual(90);
    expect(usePlayerStore.getState().currentTime).toBeLessThan(95);
  });

  it('advances the queue when the renderer finishes a track', async () => {
    vi.mocked(castApi.castStatus).mockResolvedValue(status({ state: 'PLAYING', positionSecs: 178 }));
    await getCastController()!.start(renderer);
    await vi.advanceTimersByTimeAsync(9000); // past the post-load grace period, still playing
    expect(originalNext).not.toHaveBeenCalled();

    vi.mocked(castApi.castStatus).mockResolvedValue(status({ state: 'STOPPED', positionSecs: null }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(originalNext).toHaveBeenCalledTimes(1);
    expect(originalNext).toHaveBeenCalledWith(false);

    await vi.advanceTimersByTimeAsync(3000); // further STOPPED polls must not skip again
    expect(originalNext).toHaveBeenCalledTimes(1);
  });

  it('does not advance when the user stopped playback', async () => {
    vi.mocked(castApi.castStatus).mockResolvedValue(status({ state: 'PLAYING', positionSecs: 178 }));
    await getCastController()!.start(renderer);
    await vi.advanceTimersByTimeAsync(9000);

    usePlayerStore.getState().pause();
    vi.mocked(castApi.castStatus).mockResolvedValue(status({ state: 'STOPPED', positionSecs: null }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(originalNext).not.toHaveBeenCalled();
  });

  it('loads the new track on the renderer when the current track changes', async () => {
    await getCastController()!.start(renderer);
    vi.mocked(castApi.castPlay).mockClear();

    usePlayerStore.setState({ currentTrack: makeTrack({ id: 'song-2', duration: 200 }) });
    await vi.advanceTimersByTimeAsync(0);

    expect(castApi.castPlay).toHaveBeenCalledWith(
      renderer,
      expect.objectContaining({ url: expect.stringContaining('id=song-2') }),
      null,
    );
  });

  it('ends the session after repeated poll failures', async () => {
    vi.mocked(castApi.castStatus).mockRejectedValue(new Error('timeout'));
    await getCastController()!.start(renderer);
    await vi.advanceTimersByTimeAsync(7000);

    expect(useCastStore.getState().session).toBeNull();
    expect(isCastGateActive()).toBe(false);
    expect(useCastStore.getState().discoverError).toContain('Living Room');
  });

  it('stopping the session stops the renderer and releases the gate', async () => {
    await getCastController()!.start(renderer);
    await getCastController()!.stop();
    expect(castApi.castStop).toHaveBeenCalledWith(renderer);
    expect(useCastStore.getState().session).toBeNull();
    expect(isCastGateActive()).toBe(false);
  });
});
