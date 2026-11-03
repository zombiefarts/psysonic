/**
 * Cast feature public surface (DLNA / UPnP casting to a network renderer).
 * Deliberately has no dependency on the playback feature: the session controller
 * that drives the player lives in `src/app/castSession.ts`.
 */
export { CastButton } from './components/CastButton';
export {
  getCastController,
  registerCastController,
  useCastStore,
} from './store/castStore';
export type { CastController, CastSession } from './store/castStore';
