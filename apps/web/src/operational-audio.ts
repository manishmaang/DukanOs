export type AlertSound = 'PAYMENT_REMINDER' | 'KITCHEN_TIMER';
/** Presentation cadence, independent of the bill's persisted reminder interval. */
export const AUDIO_POLICY = {
  PAYMENT_REMINDER: {
    repeatMs: 60_000,
    volume: 0.09,
    notes: [
      [660, 0, 0.18],
      [880, 0.42, 0.28],
    ],
  },
  KITCHEN_TIMER: {
    repeatMs: 20_000,
    volume: 0.13,
    notes: [
      [880, 0, 0.14],
      [880, 0.24, 0.14],
      [1100, 0.48, 0.2],
    ],
  },
} as const;
export interface AudioDriver {
  ready(): boolean;
  playing(): boolean;
  play(kind: AlertSound): void;
  stop(): void;
}
export interface SoundAlert {
  id: string;
  dueAt: string;
}
/** One coordinator per signed-in app. It cannot call APIs or change domain state. */
export class OperationalAudio {
  private driver: AudioDriver;
  private scope = new Set<AlertSound>();
  private known = new Map<AlertSound, Set<string>>();
  private due = new Map<AlertSound, Set<string>>();
  private suppressed = new Set<string>();
  private next = new Map<AlertSound, number>();
  private playingKind?: AlertSound;
  private enabled = false;
  constructor(driver: AudioDriver) {
    this.driver = driver;
  }
  setScope(kinds: AlertSound[]) {
    if (
      kinds.length === this.scope.size &&
      kinds.every((k) => this.scope.has(k))
    )
      return;
    this.driver.stop();
    this.playingKind = undefined;
    this.scope = new Set(kinds);
    this.due.clear();
    this.known.clear();
    this.suppressed.clear();
  }
  setEnabled(enabled: boolean) {
    if (enabled && !this.enabled) this.next.clear();
    this.enabled = enabled;
    if (!enabled) {
      this.driver.stop();
      this.playingKind = undefined;
    }
  }
  update(kind: AlertSound, alerts: SoundAlert[], now: number) {
    if (!this.scope.has(kind)) return;
    const present = new Set(alerts.map((a) => `${kind}:${a.id}:${a.dueAt}`));
    this.known.set(kind, present);
    for (const key of this.suppressed)
      if (key.startsWith(kind + ':') && !present.has(key))
        this.suppressed.delete(key);
    this.due.set(
      kind,
      new Set(
        alerts
          .filter(
            (a) =>
              Number.isFinite(Date.parse(a.dueAt)) &&
              Date.parse(a.dueAt) <= now,
          )
          .map((a) => `${kind}:${a.id}:${a.dueAt}`),
      ),
    );
    this.stopIfResolved(kind);
  }
  detach(kind: AlertSound) {
    this.known.delete(kind);
    this.due.delete(kind);
    this.stopIfResolved(kind);
  }
  private available(kind: AlertSound) {
    return [...(this.due.get(kind) ?? [])].some(
      (key) => !this.suppressed.has(key),
    );
  }
  private stopIfResolved(kind: AlertSound) {
    if (this.playingKind === kind && !this.available(kind)) {
      this.driver.stop();
      this.playingKind = undefined;
    }
  }
  /** Suppress a requested action immediately; undo only on failure, otherwise wait for canonical removal/new deadline. */
  silence(kind: AlertSound, id: string) {
    const keys = [...(this.known.get(kind) ?? [])].filter((key) =>
      key.startsWith(`${kind}:${id}:`),
    );
    keys.forEach((key) => this.suppressed.add(key));
    if (this.playingKind === kind) {
      this.driver.stop();
      this.playingKind = undefined;
    }
    return () => keys.forEach((key) => this.suppressed.delete(key));
  }
  tick(now: number) {
    if (!this.enabled || !this.driver.ready() || this.driver.playing()) return;
    for (const kind of ['KITCHEN_TIMER', 'PAYMENT_REMINDER'] as const) {
      if (
        this.scope.has(kind) &&
        this.available(kind) &&
        now >= (this.next.get(kind) ?? -Infinity)
      ) {
        this.driver.play(kind);
        this.playingKind = kind;
        this.next.set(kind, now + AUDIO_POLICY[kind].repeatMs);
        return;
      }
    }
  }
  test(kind: AlertSound, now: number) {
    if (
      !this.enabled ||
      !this.scope.has(kind) ||
      !this.driver.ready() ||
      this.driver.playing()
    )
      return false;
    this.driver.play(kind);
    this.playingKind = undefined;
    this.next.set(kind, now + AUDIO_POLICY[kind].repeatMs);
    return true;
  }
  stop() {
    this.driver.stop();
    this.due.clear();
    this.known.clear();
    this.suppressed.clear();
    this.scope.clear();
  }
}

/** All tones are generated on this device: no files, URLs, loops or audio dependencies. */
export class LocalToneDriver implements AudioDriver {
  private context?: AudioContext;
  private nodes = new Set<OscillatorNode>();
  private notify: () => void;
  constructor(notify: () => void) {
    this.notify = notify;
  }
  async unlock() {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext();
      this.context.onstatechange = () => {
        if (!this.ready()) this.stop();
        this.notify();
      };
    }
    // Called directly from the button gesture, before any awaited work.
    const resumed = this.context.resume();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        resumed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Sound activation timed out')),
            2500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (!this.ready()) throw new Error('Sound needs activation');
  }
  ready() {
    return this.context?.state === 'running';
  }
  playing() {
    return this.nodes.size > 0;
  }
  play(kind: AlertSound) {
    const context = this.context;
    if (!context || !this.ready() || this.playing()) return;
    const policy = AUDIO_POLICY[kind];
    for (const [frequency, offset, length] of policy.notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = context.currentTime + 0.01 + offset;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(policy.volume, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, at + length);
      oscillator.connect(gain);
      gain.connect(context.destination);
      this.nodes.add(oscillator);
      oscillator.onended = () => {
        this.nodes.delete(oscillator);
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(at);
      oscillator.stop(at + length + 0.02);
    }
  }
  stop() {
    for (const node of this.nodes) {
      try {
        node.stop();
        node.disconnect();
      } catch {
        /* Already ended. */
      }
    }
    this.nodes.clear();
  }
  dispose() {
    this.stop();
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => {});
      this.context = undefined;
    }
  }
}
