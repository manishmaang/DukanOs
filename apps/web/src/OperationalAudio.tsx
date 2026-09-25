import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import type { PermissionCode } from '@dukanos/shared-types';
import {
  LocalToneDriver,
  OperationalAudio,
  type AlertSound,
  type SoundAlert,
} from './operational-audio';
export const SOUND_PREFERENCE_KEY = 'dukanos-sound-alerts';
interface AudioContextValue {
  engine: OperationalAudio;
  enabled: boolean;
  ready: boolean;
  error: string;
  busy: boolean;
  enable: () => Promise<void>;
  mute: () => void;
  test: (kind: AlertSound) => void;
}
const Context = createContext<AudioContextValue | null>(null);
function preference() {
  try {
    return localStorage.getItem(SOUND_PREFERENCE_KEY) === 'on';
  } catch {
    return false;
  }
}
export function OperationalAudioProvider({
  children,
  permissions,
}: {
  children: ReactNode;
  permissions: PermissionCode[];
}) {
  const [, render] = useState(0);
  const [driver] = useState(
    () => new LocalToneDriver(() => render((n) => n + 1)),
  );
  const [engine] = useState(() => new OperationalAudio(driver));
  const [enabled, setEnabled] = useState(preference);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const operation = useRef(0);
  const { pathname } = useLocation();
  const scope: AlertSound | undefined =
    pathname === '/pos' && permissions.includes('bills.reminders.read')
      ? 'PAYMENT_REMINDER'
      : pathname === '/kitchen' && permissions.includes('kitchen.timers.read')
        ? 'KITCHEN_TIMER'
        : undefined;
  useEffect(() => {
    engine.setScope(scope ? [scope] : []);
  }, [engine, scope]);
  useEffect(() => {
    engine.setEnabled(enabled);
  }, [engine, enabled]);
  useEffect(() => {
    alive.current = true;
    const tick = () => {
      try {
        engine.tick(performance.now());
      } catch {
        engine.setEnabled(false);
        setEnabled(false);
        setError('Sound could not play. Tap Enable Sound to try again.');
      }
    };
    const timer = setInterval(tick, 500);
    const storage = () => {
      const value = preference();
      setEnabled(value);
      engine.setEnabled(value);
    };
    window.addEventListener('storage', storage);
    return () => {
      alive.current = false;
      operation.current++;
      clearInterval(timer);
      window.removeEventListener('storage', storage);
      engine.stop();
      driver.dispose();
    };
  }, [engine, driver]);
  function save(value: boolean) {
    setEnabled(value);
    engine.setEnabled(value);
    try {
      localStorage.setItem(SOUND_PREFERENCE_KEY, value ? 'on' : 'off');
    } catch {
      /* Preference still works for this page. */
    }
  }
  async function enable() {
    if (busy) return;
    const request = ++operation.current;
    setBusy(true);
    setError('');
    try {
      await driver.unlock();
      if (alive.current && request === operation.current) save(true);
    } catch {
      if (alive.current && request === operation.current)
        setError(
          'Sound is unavailable. Tap Enable Sound again and check device volume. Visual alerts remain active.',
        );
    } finally {
      if (alive.current && request === operation.current) setBusy(false);
    }
  }
  function mute() {
    operation.current++;
    setBusy(false);
    save(false);
    setError('');
  }
  function test(kind: AlertSound) {
    try {
      engine.test(kind, performance.now());
    } catch {
      engine.setEnabled(false);
      setEnabled(false);
      setError(
        'Sound could not play. Check device volume and enable sound again.',
      );
    }
  }
  return (
    <Context.Provider
      value={{
        engine,
        enabled,
        ready: driver.ready(),
        error,
        busy,
        enable,
        mute,
        test,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useOperationalAudio() {
  const value = useContext(Context);
  if (!value) throw new Error('OperationalAudioProvider is required');
  return value;
}
export function useAlertSound(
  kind: AlertSound,
  alerts: SoundAlert[],
  now: number,
) {
  const { engine } = useOperationalAudio();
  useEffect(() => {
    engine.update(kind, alerts, now);
  }, [engine, kind, alerts, now]);
  useEffect(() => () => engine.detach(kind), [engine, kind]);
  return (id: string) => engine.silence(kind, id);
}
export function SoundControl({ kind }: { kind: AlertSound }) {
  const audio = useOperationalAudio();
  const on = audio.enabled && audio.ready;
  return (
    <div className="sound-controls" aria-label="Sound alerts">
      <button
        className="secondary"
        disabled={audio.busy}
        aria-label={on ? 'Mute sound alerts' : 'Enable Sound'}
        onClick={() => {
          if (on) audio.mute();
          else void audio.enable();
        }}
      >
        {audio.busy
          ? 'Enabling sound…'
          : on
            ? 'Sound: ON · Mute'
            : 'Enable Sound'}
      </button>
      {audio.enabled && !on && (
        <button className="secondary" onClick={audio.mute}>
          Sound: OFF
        </button>
      )}
      <button
        className="secondary"
        disabled={!on}
        onClick={() => audio.test(kind)}
      >
        Test sound
      </button>
      {!on && (
        <small>
          {audio.enabled
            ? 'Tap Enable Sound to activate this session.'
            : 'Sound alerts are off on this device.'}
        </small>
      )}
      {audio.error && <p role="status">{audio.error}</p>}
    </div>
  );
}
