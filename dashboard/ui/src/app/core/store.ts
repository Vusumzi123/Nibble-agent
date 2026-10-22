import { Injectable, computed, inject, signal } from '@angular/core';

import { ApiService, errorText } from './api.service';
import {
  ConfigSnapshot,
  Health,
  HeartbeatSnapshot,
  HeartbeatTick,
  MemoryPending,
  MessageRow,
  Metrics,
  MissionsSnapshot,
  QueuesSnapshot,
} from './models';

const POLL_MS = 2000;
const PENDING_MS = 5000;

// Central polling store: one shared 2 s tick feeds every widget, so the
// backend sees a single steady reader instead of one poll per component.
@Injectable({ providedIn: 'root' })
export class DashboardStore {
  private readonly api = inject(ApiService);

  readonly health = signal<Health | null>(null);
  readonly heartbeat = signal<HeartbeatSnapshot | null>(null);
  readonly metrics = signal<Metrics | null>(null);
  readonly memoryPending = signal<MemoryPending | null>(null);
  readonly queues = signal<QueuesSnapshot | null>(null);
  readonly queuesError = signal<string | null>(null);
  readonly config = signal<ConfigSnapshot | null>(null);
  readonly missions = signal<MissionsSnapshot | null>(null);
  readonly missionsError = signal<string | null>(null);
  readonly ticks = signal<HeartbeatTick[]>([]);
  readonly messages = signal<MessageRow[]>([]);
  readonly lastSession = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly lastUpdated = signal<number | null>(null);
  readonly now = signal<number>(Date.now());

  readonly inFlight = computed(() => this.heartbeat()?.current?.state === 'in-flight');

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private pendingTimer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private loadedConfig = false;

  async start(): Promise<void> {
    await this.loadStatic();
    await this.loadMissions();
    await Promise.all([this.poll(), this.loadMemoryPending(), this.loadQueues()]);
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    }
    if (this.pendingTimer === null) {
      this.pendingTimer = setInterval(() => {
        void this.loadMemoryPending();
        void this.loadQueues();
      }, PENDING_MS);
    }
    if (this.clockTimer === null) {
      this.clockTimer = setInterval(() => this.now.set(Date.now()), 1000);
    }
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pendingTimer !== null) {
      clearInterval(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  // The drain backlog is DB-backed and slower than the 2 s widgets, so it has
  // its own 5 s cadence (the backend also caches for 5 s). A failure hides the
  // pill instead of tripping the global unreachable banner.
  async loadMemoryPending(): Promise<void> {
    try {
      this.memoryPending.set(await this.api.memoryPending());
    } catch {
      this.memoryPending.set(null);
    }
  }

  // Lane queues are file-backed and cheap to parse (the backend caches 2 s), so
  // they ride the same 5 s cadence as the memory pill. A 404 (older backend)
  // lands in queuesError instead of the global unreachable banner.
  async loadQueues(): Promise<void> {
    try {
      this.queues.set(await this.api.queues());
      this.queuesError.set(null);
    } catch (err) {
      this.queues.set(null);
      this.queuesError.set(errorText(err));
    }
  }

  private async loadStatic(): Promise<void> {
    try {
      const [health, config] = await Promise.all([this.api.health(), this.api.config()]);
      this.health.set(health);
      this.config.set(config);
      this.loadedConfig = true;
      this.error.set(null);
    } catch (err) {
      this.error.set(errorText(err));
    }
  }

  async refreshConfig(): Promise<void> {
    try {
      this.config.set(await this.api.config());
      this.error.set(null);
    } catch (err) {
      this.error.set(errorText(err));
    }
  }

  // Missions are not polled (they change rarely); load once on start and on
  // demand. A 404 (older backend without /api/missions) lands in missionsError
  // rather than the global unreachable banner.
  async loadMissions(): Promise<void> {
    try {
      this.missions.set(await this.api.missions());
      this.missionsError.set(null);
    } catch (err) {
      this.missionsError.set(errorText(err));
    }
  }

  async toggleMission(id: string, enabled: boolean): Promise<void> {
    await this.api.setMissionEnabled(id, enabled);
    await this.loadMissions();
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const [heartbeat, ticksPage, metrics] = await Promise.all([
        this.api.heartbeat(),
        this.api.ledger('heartbeat.log', 500).catch(() => ({ name: 'heartbeat.log', entries: [] as unknown[] })),
        this.api.metrics().catch(() => null),
      ]);
      this.heartbeat.set(heartbeat);
      this.ticks.set((ticksPage.entries as HeartbeatTick[]).filter((t) => t && typeof t === 'object'));
      if (metrics) this.metrics.set(metrics);
      if (!this.loadedConfig && metrics) {
        this.config.set(metrics.config);
        this.loadedConfig = true;
      }
      this.lastUpdated.set(Date.now());
      this.error.set(null);
      await this.pollSession(heartbeat);
    } catch (err) {
      this.error.set(errorText(err));
    } finally {
      this.busy = false;
    }
  }

  // Keep the output widget fed: prefer the in-flight child session; otherwise
  // stay on the most recent mission session (so the transcript survives idle).
  private async pollSession(heartbeat: HeartbeatSnapshot): Promise<void> {
    const directory = this.health()?.directory;
    if (!directory) return;

    const live = heartbeat.current?.session ?? null;
    if (live) this.lastSession.set(live);

    let session = this.lastSession();
    if (!session && this.ticks().length > 0) {
      session = await this.discoverSession(directory).catch(() => null);
      if (session) this.lastSession.set(session);
    }
    if (!session) return;

    const rows = await this.api.sessionMessages(session, directory).catch(() => null);
    if (rows) this.messages.set(rows);
  }

  private async discoverSession(directory: string): Promise<string | null> {
    const list = await this.api.sessions(directory);
    // Runner missions (drain-pipe) have no `heartbeat:` child session; their
    // transcript lives in the writer session the provider spawns.
    const TRANSCRIPT_TITLES = ['heartbeat:', 'knowledge-consolidate'];
    const missions = (Array.isArray(list) ? list : [])
      .filter(
        (s) =>
          typeof s.title === 'string' &&
          TRANSCRIPT_TITLES.some((prefix) => (s.title as string).startsWith(prefix)),
      )
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    return missions[0]?.id ?? null;
  }
}
