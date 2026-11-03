import { create } from 'zustand';
import type { CastRenderer, CastStatus } from '@/lib/api/cast';

/**
 * Runtime state for casting to a UPnP renderer. Not persisted: a cast session
 * never survives an app restart.
 *
 * The session controller lives in `src/app/castSession.ts` because it has to
 * drive the playback store, and a feature may not import another feature that
 * imports it back. It registers itself here so UI (which only needs to ask for
 * "start" / "stop") stays free of playback imports.
 */
export interface CastController {
  start: (renderer: CastRenderer) => Promise<void>;
  stop: () => Promise<void>;
}

export interface CastSession {
  renderer: CastRenderer;
  /** Latest poll result; null until the first poll lands. */
  status: CastStatus | null;
  /** Last command/poll error, shown in the picker. Cleared on the next success. */
  error: string | null;
}

interface CastState {
  renderers: CastRenderer[];
  discovering: boolean;
  discoverError: string | null;
  session: CastSession | null;
  setDiscovering: (discovering: boolean) => void;
  setRenderers: (renderers: CastRenderer[]) => void;
  setDiscoverError: (error: string | null) => void;
  setSession: (session: CastSession | null) => void;
  patchSession: (patch: Partial<Omit<CastSession, 'renderer'>>) => void;
}

export const useCastStore = create<CastState>((set) => ({
  renderers: [],
  discovering: false,
  discoverError: null,
  session: null,
  setDiscovering: (discovering) => set({ discovering }),
  setRenderers: (renderers) => set({ renderers, discoverError: null }),
  setDiscoverError: (discoverError) => set({ discoverError }),
  setSession: (session) => set({ session }),
  patchSession: (patch) => set((s) => (s.session ? { session: { ...s.session, ...patch } } : s)),
}));

let controller: CastController | null = null;

export function registerCastController(impl: CastController | null): void {
  controller = impl;
}

export function getCastController(): CastController | null {
  return controller;
}
