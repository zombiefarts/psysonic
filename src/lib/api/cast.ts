/**
 * Typed facade over the generated `commands.cast*` bindings (DLNA / UPnP casting).
 * Each call resolves to the payload and rejects with the Rust error message,
 * matching how the other API facades behave.
 */
import { commands } from '@/generated/bindings';
import type { CastRenderer, CastStatus, CastTrack } from '@/generated/bindings';

export type { CastRenderer, CastStatus, CastTrack };

async function unwrap<T>(
  call: Promise<{ status: 'ok'; data: T } | { status: 'error'; error: string }>,
): Promise<T> {
  const res = await call;
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export function castListRenderers(timeoutMs: number | null = null): Promise<CastRenderer[]> {
  return unwrap(commands.listRenderers(timeoutMs));
}

/** `track` null resumes what is loaded; otherwise starts it, optionally at an offset. */
export function castPlay(
  renderer: CastRenderer,
  track: CastTrack | null,
  startSeconds: number | null = null,
): Promise<null> {
  return unwrap(commands.castPlay(renderer, track, startSeconds));
}

export function castSetNext(renderer: CastRenderer, track: CastTrack): Promise<null> {
  return unwrap(commands.castSetNext(renderer, track));
}

export function castPause(renderer: CastRenderer): Promise<null> {
  return unwrap(commands.castPause(renderer));
}

export function castStop(renderer: CastRenderer): Promise<null> {
  return unwrap(commands.castStop(renderer));
}

export function castSeek(renderer: CastRenderer, seconds: number): Promise<null> {
  return unwrap(commands.castSeek(renderer, seconds));
}

/** 0-100. */
export function castSetVolume(renderer: CastRenderer, volume: number): Promise<null> {
  return unwrap(commands.castSetVolume(renderer, volume));
}

export function castStatus(renderer: CastRenderer): Promise<CastStatus> {
  return unwrap(commands.castStatus(renderer));
}
