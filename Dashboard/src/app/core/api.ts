import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  Activity,
  Backlog,
  CostReport,
  Drain,
  ErrorReport,
  Health,
  Heartbeat,
  Idea,
  LedgerInfo,
  LockInfo,
  MessageRow,
  Mission,
  Mood,
  Overview,
  QueueWait,
  Queues,
  RunDetail,
  RunsSnapshot,
  SettingsResult,
  SettingsSnapshot,
  Sleep,
  Throughput,
  TokenSeries,
} from './models';

export function errorText(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error;
    if (body && typeof body === 'object' && 'message' in body) {
      return String((body as { message: unknown }).message);
    }
    if (typeof body === 'string' && body) return body;
    return `${err.status} ${err.statusText}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function q(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  private get<T>(path: string): Promise<T> {
    return firstValueFrom(this.http.get<T>(path));
  }

  health(): Promise<Health> {
    return timeout(this.get<Health>('/api/health'), 3000);
  }

  overview(): Promise<Overview> {
    return this.get<Overview>('/api/overview');
  }

  heartbeat(): Promise<Heartbeat> {
    return this.get<Heartbeat>('/api/heartbeat');
  }

  mood(): Promise<Mood> {
    return this.get<Mood>('/api/mood');
  }

  sleep(): Promise<Sleep> {
    return this.get<Sleep>('/api/sleep');
  }

  idea(): Promise<Idea> {
    return this.get<Idea>('/api/idea');
  }

  queues(): Promise<Queues> {
    return this.get<Queues>('/api/queues');
  }

  drain(): Promise<Drain> {
    return this.get<Drain>('/api/drain');
  }

  runs(params: { limit?: number; mission?: string; kind?: string; outcome?: string; hours?: number } = {}): Promise<RunsSnapshot> {
    return this.get<RunsSnapshot>(`/api/runs${q(params)}`);
  }

  runDetail(params: { session?: string | null; tick?: number | null; mission?: string | null }): Promise<RunDetail> {
    return this.get<RunDetail>(
      `/api/runs/detail${q({
        session: params.session ?? undefined,
        tick: params.tick ?? undefined,
        mission: params.mission ?? undefined,
      })}`,
    );
  }

  tokens(hours = 24, bucket: 'tick' | 'hour' | 'day' = 'hour'): Promise<TokenSeries> {
    return this.get<TokenSeries>(`/api/metrics/tokens${q({ hours, bucket })}`);
  }

  cost(hours = 24): Promise<CostReport> {
    return this.get<CostReport>(`/api/metrics/cost${q({ hours })}`);
  }

  errors(hours = 24): Promise<ErrorReport> {
    return this.get<ErrorReport>(`/api/metrics/errors${q({ hours })}`);
  }

  throughput(hours = 24): Promise<Throughput> {
    return this.get<Throughput>(`/api/metrics/throughput${q({ hours })}`);
  }

  queueWait(): Promise<QueueWait> {
    return this.get<QueueWait>('/api/metrics/queue-wait');
  }

  activity(hours = 6): Promise<Activity> {
    return this.get<Activity>(`/api/activity${q({ hours })}`);
  }

  settings(): Promise<SettingsSnapshot> {
    return this.get<SettingsSnapshot>('/api/settings');
  }

  missions(): Promise<{ file: string; missions: Mission[] }> {
    return this.get<{ file: string; missions: Mission[] }>('/api/missions');
  }

  backlog(limit = 100): Promise<Backlog> {
    return this.get<Backlog>(`/api/backlog${q({ limit })}`);
  }

  ledgers(): Promise<{ ledgers: LedgerInfo[] }> {
    return this.get<{ ledgers: LedgerInfo[] }>('/api/ledgers');
  }

  ledger(name: string, limit = 300): Promise<{ name: string; entries: unknown[] }> {
    return this.get<{ name: string; entries: unknown[] }>(`/api/ledgers/${encodeURIComponent(name)}${q({ limit })}`);
  }

  locks(): Promise<{ ts: string; locks: LockInfo[] }> {
    return this.get<{ ts: string; locks: LockInfo[] }>('/api/locks');
  }

  sessionMessages(session: string, directory: string): Promise<MessageRow[]> {
    return this.get<MessageRow[]>(`/api/serve/session/${encodeURIComponent(session)}/message${q({ directory })}`);
  }

  private async csrf(): Promise<HttpHeaders> {
    const { token } = await this.get<{ token: string }>('/api/csrf');
    return new HttpHeaders({ 'x-csrf-token': token });
  }

  async saveSettings(updates: Array<{ path: string; value: unknown }>): Promise<SettingsResult> {
    const headers = await this.csrf();
    return firstValueFrom(this.http.put<SettingsResult>('/api/settings', { updates }, { headers }));
  }

  async saveMission(body: {
    id: string;
    enabled?: boolean;
    min_level?: number;
    frequency?: string;
    menus?: string[];
  }): Promise<{ ok: boolean; mission: Mission; missions: Mission[] }> {
    const headers = await this.csrf();
    return firstValueFrom(
      this.http.put<{ ok: boolean; mission: Mission; missions: Mission[] }>('/api/missions', body, { headers }),
    );
  }
}

