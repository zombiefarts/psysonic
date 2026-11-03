import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { showToast } from '@/lib/dom/toast';
import { resolveIndexKey, serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import {
  libraryGetStatus,
  librarySyncCancel,
  subscribeLibrarySyncIdle,
  subscribeLibrarySyncProgress,
  type SyncStateDto,
} from '@/lib/api/library';
import {
  bootstrapAllIndexedServers,
  bindIndexedServer,
  bootstrapIndexedServer,
  lastBindErrorFor,
  type BindServerResult,
} from '@/lib/library/librarySession';
import {
  clearPendingLibrarySync,
  enqueueLibrarySync,
} from '@/lib/library/librarySyncQueue';
import { syncIngestDisplayCount } from '@/lib/library/libraryReady';
import {
  publishServerConnectionStatus,
  useServerReachabilitySnapshot,
} from '@/lib/network/serverReachability';

export type LibraryServerConnection = 'online' | 'offline' | 'unknown';

const STATUS_POLL_MS = 3000;
const SYNC_POLL_MS = 2500;
const OFFLINE_RETRY_MS = 60_000;

function shallowObjectEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.is(left[key], right[key]));
}

function syncStatusEqual(left: SyncStateDto | null, right: SyncStateDto | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return shallowObjectEqual(
    left as unknown as Record<string, unknown>,
    right as unknown as Record<string, unknown>,
  );
}

function statusMapEqual(
  left: Record<string, SyncStateDto | null>,
  right: Record<string, SyncStateDto | null>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => key in right && syncStatusEqual(left[key] ?? null, right[key] ?? null));
}

export function useLibraryIndexSync() {
  const { t } = useTranslation();
  const servers = useAuthStore(s => s.servers);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const masterEnabled = useLibraryIndexStore(s => s.masterEnabled);
  const reachabilityByServer = useServerReachabilitySnapshot();

  const serverKeyById = useMemo(
    () => Object.fromEntries(servers.map(s => [s.id, serverIndexKeyForProfile(s)])),
    [servers],
  );
  const indexedKeys = useMemo(
    () => Array.from(new Set(Object.values(serverKeyById))),
    [serverKeyById],
  );
  const indexedServers = useMemo(() => {
    const primary = new Map<string, { key: string; server: typeof servers[number] }>();
    for (const server of servers) {
      const key = serverKeyById[server.id];
      if (!primary.has(key)) primary.set(key, { key, server });
    }
    if (activeServerId) {
      const active = servers.find(s => s.id === activeServerId);
      if (active) {
        const key = serverKeyById[active.id];
        if (primary.has(key)) primary.set(key, { key, server: active });
      }
    }
    return Array.from(primary.values());
  }, [servers, serverKeyById, activeServerId]);

  const [statusByServer, setStatusByServer] = useState<Record<string, SyncStateDto | null>>({});
  const [progressByServer, setProgressByServer] = useState<Record<string, string | null>>({});
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ingestCountRef = useRef<Record<string, number>>({});
  const syncPhaseRef = useRef<Record<string, string | null>>({});
  const generationRef = useRef(0);
  const statusFlightRef = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const retryFlightRef = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const bootstrapGenerationRef = useRef<number | null>(null);
  const indexedKeysKey = indexedKeys.join(',');
  const connectionByServer = useMemo<Record<string, LibraryServerConnection>>(() => (
    Object.fromEntries(indexedServers.map(({ key, server }) => {
      const reachability = reachabilityByServer.get(server.id);
      return [
        key,
        reachability === 'available' ? 'online' : reachability === 'unavailable' ? 'offline' : 'unknown',
      ];
    }))
  ), [indexedServers, reachabilityByServer]);

  useEffect(() => {
    generationRef.current += 1;
    statusFlightRef.current = null;
    retryFlightRef.current = null;
    bootstrapGenerationRef.current = null;
    const keys = masterEnabled ? indexedKeys : [];
    const keySet = new Set(keys);
    ingestCountRef.current = Object.fromEntries(
      Object.entries(ingestCountRef.current).filter(([key]) => keySet.has(key)),
    );
    syncPhaseRef.current = Object.fromEntries(
      Object.entries(syncPhaseRef.current).filter(([key]) => keySet.has(key)),
    );
    // React Compiler set-state-in-effect rule: invalidate obsolete async bootstrap state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBootstrapping(false);
    setBusyServerId(current => current && keySet.has(current) ? current : null);
    setStatusByServer(prev => {
      const next = Object.fromEntries(keys.map(key => [key, prev[key] ?? null]));
      return statusMapEqual(prev, next) ? prev : next;
    });
    setProgressByServer(prev => {
      const next = Object.fromEntries(keys.map(key => [key, prev[key] ?? null]));
      return shallowObjectEqual(prev, next) ? prev : next;
    });
    return () => {
      generationRef.current += 1;
    };
  }, [masterEnabled, indexedKeysKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const publishConnectionResults = useCallback((
    results: Record<string, BindServerResult>,
    generation = generationRef.current,
  ) => {
    if (generation !== generationRef.current) return;
    for (const { key, server } of indexedServers) {
      const result = results[key];
      if (!result) continue;
      publishServerConnectionStatus(
        server.id,
        result === 'bound' ? 'online' : result === 'offline' ? 'offline' : 'unknown',
        useAuthStore.getState().activeServerId === server.id,
      );
    }
  }, [indexedServers]);

  const refreshAllStatuses = useCallback((generation = generationRef.current): Promise<void> => {
    if (!masterEnabled || indexedServers.length === 0) return Promise.resolve();
    const existing = statusFlightRef.current;
    if (existing?.generation === generation) return existing.promise;
    const promise = Promise.all(
      indexedServers.map(async ({ key }) => {
        try {
          const fresh = await libraryGetStatus(key);
          return [key, fresh] as const;
        } catch {
          return [key, null] as const;
        }
      }),
    ).then(entries => {
      if (generation !== generationRef.current) return;
      const nextStatus = Object.fromEntries(entries) as Record<string, SyncStateDto | null>;
      const progressUpdates: Record<string, string | null> = {};
      for (const [key, fresh] of entries) {
        syncPhaseRef.current[key] = fresh?.syncPhase ?? null;
        if (fresh?.syncPhase === 'initial_sync') {
          const count = Math.max(ingestCountRef.current[key] ?? 0, syncIngestDisplayCount(fresh));
          ingestCountRef.current[key] = count;
          progressUpdates[key] = t('settings.libraryIndexProgressIngest', { count });
        } else if (fresh?.syncPhase === 'ready' || fresh?.syncPhase === 'idle') {
          ingestCountRef.current[key] = 0;
          progressUpdates[key] = null;
        }
      }
      setStatusByServer(prev => statusMapEqual(prev, nextStatus) ? prev : nextStatus);
      setProgressByServer(prev => {
        const next = Object.fromEntries(indexedKeys.map(key => [
          key,
          key in progressUpdates ? progressUpdates[key] : (prev[key] ?? null),
        ]));
        return shallowObjectEqual(prev, next) ? prev : next;
      });
    });
    statusFlightRef.current = { generation, promise };
    void promise.finally(() => {
      if (statusFlightRef.current?.promise === promise) statusFlightRef.current = null;
    });
    return promise;
  }, [masterEnabled, indexedServers, indexedKeys, t]);

  const runBootstrap = useCallback(async () => {
    if (!masterEnabled) return;
    const generation = generationRef.current;
    bootstrapGenerationRef.current = generation;
    setBootstrapping(true);
    try {
      const results = await bootstrapAllIndexedServers();
      if (generation !== generationRef.current) return;
      publishConnectionResults(results, generation);
      await refreshAllStatuses(generation);
    } finally {
      if (bootstrapGenerationRef.current === generation) {
        bootstrapGenerationRef.current = null;
        setBootstrapping(false);
      }
    }
  }, [masterEnabled, publishConnectionResults, refreshAllStatuses]);

  const retryOfflineServers = useCallback((generation = generationRef.current): Promise<void> => {
    if (!masterEnabled) return Promise.resolve();
    const existing = retryFlightRef.current;
    if (existing?.generation === generation) return existing.promise;
    const offline = indexedServers.filter(s => connectionByServer[s.key] === 'offline');
    if (offline.length === 0) return Promise.resolve();
    const promise = Promise.all(offline.map(async srv => {
      const result: BindServerResult = await bootstrapIndexedServer(srv.server)
        .catch(() => 'error');
      publishConnectionResults({ [srv.key]: result }, generation);
    })).then(async () => {
      if (generation === generationRef.current) await refreshAllStatuses(generation);
    });
    retryFlightRef.current = { generation, promise };
    void promise.finally(() => {
      if (retryFlightRef.current?.promise === promise) retryFlightRef.current = null;
    });
    return promise;
  }, [masterEnabled, indexedServers, connectionByServer, publishConnectionResults, refreshAllStatuses]);

  useEffect(() => {
    if (!masterEnabled || indexedKeys.length === 0) return;
    // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runBootstrap();
  }, [masterEnabled, indexedKeysKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!masterEnabled) return;
    const generation = generationRef.current;
    let cancelled = false;
    const poll = async () => {
      await refreshAllStatuses(generation);
      if (cancelled || generation !== generationRef.current) return;
      const anyInitial = indexedKeys.some(
        key => syncPhaseRef.current[key] === 'initial_sync',
      );
      pollTimer.current = setTimeout(() => void poll(), anyInitial ? SYNC_POLL_MS : STATUS_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
    };
    // indexedKeys is derived from indexedServers (already a dep); the poll loop is
    // keyed on the server set, not on the recomputed key array, to avoid
    // restarting the poll on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterEnabled, indexedServers, refreshAllStatuses]);

  useEffect(() => {
    if (!masterEnabled) return;
    const generation = generationRef.current;
    let cancelled = false;
    const retry = async () => {
      await retryOfflineServers(generation);
      if (cancelled || generation !== generationRef.current) return;
      retryTimer.current = setTimeout(() => void retry(), OFFLINE_RETRY_MS);
    };
    retryTimer.current = setTimeout(() => void retry(), OFFLINE_RETRY_MS);
    return () => {
      cancelled = true;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [masterEnabled, retryOfflineServers]);

  useEffect(() => {
    if (!masterEnabled) return;
    const unsubs: Array<Promise<() => void>> = [
      subscribeLibrarySyncProgress(p => {
        const key = resolveIndexKey(p.serverId);
        if (!indexedKeys.includes(key)) return;
        setBusyServerId(key);
        if (p.kind === 'ingest_page') {
          const next = Math.max(ingestCountRef.current[key] ?? 0, p.ingestedTotal ?? 0);
          ingestCountRef.current[key] = next;
          setProgressByServer(prev => ({
            ...prev,
            [key]: t('settings.libraryIndexProgressIngest', { count: next }),
          }));
        } else if (p.kind === 'tombstoned') {
          setProgressByServer(prev => ({
            ...prev,
            [key]: t('settings.libraryIndexProgressVerify', {
              checked: p.tombstonesChecked ?? 0,
              deleted: p.tombstonesDeleted ?? 0,
            }),
          }));
        } else if (p.kind === 'phase_changed' && p.phase) {
          setProgressByServer(prev => ({ ...prev, [key]: p.phase ?? null }));
        }
      }),
      subscribeLibrarySyncIdle(p => {
        const key = resolveIndexKey(p.serverId);
        if (!indexedKeys.includes(key)) return;
        setBusyServerId(cur => (cur === key ? null : cur));
        ingestCountRef.current[key] = 0;
        setProgressByServer(prev => ({ ...prev, [key]: null }));
        void refreshAllStatuses(generationRef.current);
        if (!p.ok && p.error) {
          showToast(t('settings.libraryIndexSyncError', { error: p.error }), 5000, 'error');
        }
      }),
    ];
    return () => {
      unsubs.forEach(u => void u.then(fn => fn()));
    };
  }, [masterEnabled, indexedKeys, refreshAllStatuses, t]);

  const runServerAction = useCallback(async (
    serverId: string,
    action: 'full' | 'delta' | 'verify',
  ) => {
    const key = resolveIndexKey(serverId);
    setBusyServerId(key);
    try {
      const kind =
        action === 'verify'
          ? 'verify'
          : action === 'full'
            ? 'full'
            : statusByServer[key]?.lastFullSyncAt
              ? 'delta'
              : 'full';
      ingestCountRef.current[key] = 0;
      try {
        await enqueueLibrarySync({ serverId: key, kind });
      } catch (e) {
        // The Rust session lives in process memory and is only bound at startup /
        // server changes. If that bind failed (or never ran), rebind now and retry
        // once instead of surfacing the opaque "no bound session" error.
        const message = e instanceof Error ? e.message : String(e);
        if (!message.includes('no bound session')) throw e;
        const profile = servers.find(s => serverIndexKeyForProfile(s) === key)
          ?? servers.find(s => s.id === serverId);
        if (!profile) throw e;
        const bound = await bindIndexedServer(profile);
        if (bound !== 'bound') {
          throw new Error(`could not connect to the server (${lastBindErrorFor(key) ?? bound})`);
        }
        await enqueueLibrarySync({ serverId: key, kind });
      }
    } catch (e) {
      setBusyServerId(null);
      showToast(t('settings.libraryIndexSyncError', { error: e instanceof Error ? e.message : String(e) }), 5000, 'error');
    }
  }, [servers, statusByServer, t]);

  const handleCancel = useCallback(async (serverId: string) => {
    clearPendingLibrarySync(resolveIndexKey(serverId));
    try {
      await librarySyncCancel();
    } catch {
      /* best-effort */
    }
  }, []);

  const globalBusy = bootstrapping || busyServerId != null;

  return {
    statusByServer,
    connectionByServer,
    progressByServer,
    busyServerId,
    bootstrapping,
    globalBusy,
    runServerAction,
    handleCancel,
  };
}
