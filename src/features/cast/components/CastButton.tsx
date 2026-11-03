import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Cast, Check, RefreshCw } from 'lucide-react';
import { castListRenderers, type CastRenderer } from '@/lib/api/cast';
import { TRANSIENT_UI_CLOSE_EVENT, prepareTransientUiOpen } from '@/lib/dom/transientUi';
import { getCastController, useCastStore } from '@/features/cast/store/castStore';

interface Props {
  className?: string;
  iconSize?: number;
}

const MENU_WIDTH = 260;

/**
 * "Cast to device" control. Opens a small device picker; while a session is
 * active the icon is accented, the tooltip names the renderer and the menu offers
 * "Stop casting".
 */
export function CastButton({ className = 'player-btn player-btn-sm', iconSize = 15 }: Props) {
  const { t } = useTranslation();
  const session = useCastStore(s => s.session);
  const renderers = useCastStore(s => s.renderers);
  const discovering = useCastStore(s => s.discovering);
  const discoverError = useCastStore(s => s.discoverError);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const store = useCastStore.getState();
    if (store.discovering) return;
    store.setDiscovering(true);
    try {
      store.setRenderers(await castListRenderers());
    } catch (e) {
      store.setDiscoverError(e instanceof Error ? e.message : String(e));
    } finally {
      useCastStore.getState().setDiscovering(false);
    }
  }, []);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    prepareTransientUiOpen();
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(8, Math.min(window.innerWidth - MENU_WIDTH - 8, rect.right - MENU_WIDTH));
      setPos({ left, bottom: window.innerHeight - rect.top + 8 });
    }
    setOpen(true);
    void refresh();
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener(TRANSIENT_UI_CLOSE_EVENT, close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(TRANSIENT_UI_CLOSE_EVENT, close);
    };
  }, [open]);

  const select = (renderer: CastRenderer) => {
    setOpen(false);
    void getCastController()?.start(renderer);
  };

  const stopCasting = () => {
    setOpen(false);
    void getCastController()?.stop();
  };

  const label = session
    ? t('cast.castingTo', { name: session.renderer.name })
    : t('cast.title');

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`${className}${session ? ' active cast-btn-active' : ''}`}
        onClick={toggle}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={label}
      >
        <Cast size={iconSize} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="cast-menu"
          role="menu"
          aria-label={t('cast.title')}
          style={{ left: pos.left, bottom: pos.bottom, width: MENU_WIDTH }}
        >
          <div className="cast-menu-header">
            <span className="cast-menu-title">{t('cast.title')}</span>
            <button
              type="button"
              className="cast-menu-refresh"
              onClick={() => void refresh()}
              disabled={discovering}
              aria-label={t('cast.refresh')}
              data-tooltip={t('cast.refresh')}
            >
              <RefreshCw size={14} className={discovering ? 'cast-spin' : undefined} />
            </button>
          </div>
          {session?.error && <div className="cast-menu-note cast-menu-error">{session.error}</div>}
          {discoverError && <div className="cast-menu-note cast-menu-error">{discoverError}</div>}
          <ul className="cast-menu-list">
            {renderers.map(r => {
              const isActive = session?.renderer.id === r.id;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={`cast-menu-item${isActive ? ' is-active' : ''}`}
                    onClick={() => select(r)}
                  >
                    <span className="cast-menu-item-text">
                      <span className="cast-menu-item-name">{r.name}</span>
                      {(r.manufacturer || r.model) && (
                        <span className="cast-menu-item-meta">{[r.manufacturer, r.model].filter(Boolean).join(' ')}</span>
                      )}
                    </span>
                    {isActive && <Check size={14} />}
                  </button>
                </li>
              );
            })}
          </ul>
          {!discovering && renderers.length === 0 && !discoverError && (
            <div className="cast-menu-note">{t('cast.none')}</div>
          )}
          {discovering && renderers.length === 0 && (
            <div className="cast-menu-note">{t('cast.searching')}</div>
          )}
          {session && (
            <button type="button" className="cast-menu-stop" onClick={stopCasting}>
              {t('cast.stop')}
            </button>
          )}
          <div className="cast-menu-note cast-menu-hint">{t('cast.limitations')}</div>
        </div>,
        document.body,
      )}
    </>
  );
}
