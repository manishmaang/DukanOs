import { useCallback, useEffect, useRef, useState } from 'react';
import type { AlertState } from '@dukanos/shared-types';
import { api, ApiFailure } from './api';
// One canonical snapshot. Failed reads retain only previously known schedules.
export function useOperationalAlerts<T>(path: string, userId: string) {
  const key = `dukanos-alerts:${userId}:${path}`;
  const [entries, setEntries] = useState<T[]>([]);
  const [offline, setOffline] = useState(true);
  const [, tick] = useState(0);
  const sample = useRef({ server: Date.now(), received: performance.now() });
  const flight = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (flight.current) return;
    flight.current = true;
    const current = ++revision.current;
    try {
      const state = await api<AlertState<T>>(path);
      if (!mounted.current || revision.current !== current) return;
      sample.current = {
        server: Date.parse(state.serverTime),
        received: performance.now(),
      };
      setEntries(state.entries);
      setOffline(false);
      try {
        sessionStorage.setItem(
          key,
          JSON.stringify({ ...state, savedAt: Date.now() }),
        );
      } catch {
        /* In-memory fallback remains available. */
      }
    } catch (e) {
      if (mounted.current && revision.current === current) {
        setOffline(true);
        if (e instanceof ApiFailure && [401, 403].includes(e.status)) {
          setEntries([]);
          sessionStorage.removeItem(key);
        }
      }
    } finally {
      flight.current = false;
    }
  }, [path, key]);
  useEffect(() => {
    mounted.current = true;
    try {
      const cached = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (
        cached &&
        Array.isArray(cached.entries) &&
        Number.isFinite(cached.savedAt) &&
        Number.isFinite(Date.parse(cached.serverTime))
      ) {
        setEntries(cached.entries);
        sample.current = {
          server:
            Date.parse(cached.serverTime) +
            Math.max(0, Date.now() - cached.savedAt),
          received: performance.now(),
        };
      }
    } catch {
      /* Ignore invalid cache; never treat it as authority. */
    }
    void refresh();
    const poll = setInterval(() => {
      void refresh();
    }, 2000);
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    const wake = () => void refresh();
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      mounted.current = false;
      revision.current++;
      clearInterval(poll);
      clearInterval(timer);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [key, refresh]);
  return {
    entries,
    offline,
    refresh,
    now: sample.current.server + performance.now() - sample.current.received,
  };
}
export function countdown(due: string, now: number) {
  const seconds = Math.ceil(Math.abs(Date.parse(due) - now) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
