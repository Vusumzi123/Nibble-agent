import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  BacklogSnapshot,
  ConfigSnapshot,
  DrainSnapshot,
  Health,
  HeartbeatSnapshot,
  MemoryPending,
  MessageRow,
  Metrics,
  MissionToggleResult,
  MissionsSnapshot,
  QueuesSnapshot,
  RunsSnapshot,
  SessionInfo,
  TokenSeries,
  WriteResult,
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

// Thin client over the Nibble dashboard backend. All calls are same-origin:
// in production the backend serves this app (DASHBOARD_STATIC_DIR); in dev the
// Angular proxy forwards /api to the backend so the Host/Origin/CSRF guards
// stay satisfied.
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  health(): Promise<Health> {
    return firstValueFrom(this.http.get<Health>('/api/health'));
  }

  config(): Promise<ConfigSnapshot> {
    return firstValueFrom(this.http.get<ConfigSnapshot>('/api/config'));
  }

  metrics(): Promise<Metrics> {
    return firstValueFrom(this.http.get<Metrics>('/api/metrics'));
  }

  memoryPending(): Promise<MemoryPending> {
    return firstValueFrom(this.http.get<MemoryPending>('/api/memory/pending'));
  }

  // Drain consumer loop (drain-consumer-plan §6.1). An older backend answers
  // 404 — callers degrade to a "backend too old" banner.
  drain(): Promise<DrainSnapshot> {
    return firstValueFrom(this.http.get<DrainSnapshot>('/api/drain'));
  }

  heartbeat(): Promise<HeartbeatSnapshot> {
    return firstValueFrom(this.http.get<HeartbeatSnapshot>('/api/heartbeat'));
  }

  backlog(): Promise<BacklogSnapshot> {
    return firstValueFrom(this.http.get<BacklogSnapshot>('/api/backlog'));
  }

  missions(): Promise<MissionsSnapshot> {
    return firstValueFrom(this.http.get<MissionsSnapshot>('/api/missions'));
  }

  // Lane queues (`state/lanes.json`). An older backend answers 404 — callers
  // degrade to a "backend too old" banner instead of failing the page.
  queues(): Promise<QueuesSnapshot> {
    return firstValueFrom(this.http.get<QueuesSnapshot>('/api/queues'));
  }

  runs(query: { limit?: number; mission?: string; lane?: string; outcome?: string } = {}): Promise<RunsSnapshot> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.mission) params.set('mission', query.mission);
    if (query.lane) params.set('lane', query.lane);
    if (query.outcome) params.set('outcome', query.outcome);
    const suffix = params.toString();
    return firstValueFrom(this.http.get<RunsSnapshot>(`/api/runs${suffix ? `?${suffix}` : ''}`));
  }

  tokens(
    query: { bucket?: string; hours?: number; mission?: string; lane?: string; type?: string } = {},
  ): Promise<TokenSeries> {
    const params = new URLSearchParams();
    if (query.bucket) params.set('bucket', query.bucket);
    if (query.hours !== undefined) params.set('hours', String(query.hours));
    if (query.mission) params.set('mission', query.mission);
    if (query.lane) params.set('lane', query.lane);
    if (query.type) params.set('type', query.type);
    const suffix = params.toString();
    return firstValueFrom(this.http.get<TokenSeries>(`/api/metrics/tokens${suffix ? `?${suffix}` : ''}`));
  }

  ledger(name: string, limit = 200): Promise<{ name: string; entries: unknown[] }> {
    const query = new URLSearchParams({ limit: String(limit) });
    return firstValueFrom(
      this.http.get<{ name: string; entries: unknown[] }>(`/api/ledgers/${encodeURIComponent(name)}?${query}`),
    );
  }

  sessions(directory: string): Promise<SessionInfo[]> {
    const query = new URLSearchParams({ directory });
    return firstValueFrom(this.http.get<SessionInfo[]>(`/api/serve/session?${query}`));
  }

  sessionMessages(id: string, directory: string): Promise<MessageRow[]> {
    const query = new URLSearchParams({ directory });
    return firstValueFrom(
      this.http.get<MessageRow[]>(`/api/serve/session/${encodeURIComponent(id)}/message?${query}`),
    );
  }

  // Mutations need a CSRF token (issued + cookie set by the backend). The
  // browser sends the HttpOnly cookie automatically; we replay the JSON token
  // in the header (double-submit).
  async writeConfig(section: string, values: Record<string, unknown>): Promise<WriteResult> {
    const { token } = await firstValueFrom(this.http.get<{ token: string }>('/api/csrf'));
    const headers = new HttpHeaders({ 'x-csrf-token': token });
    return firstValueFrom(this.http.put<WriteResult>('/api/config', { section, values }, { headers }));
  }

  async setMissionEnabled(id: string, enabled: boolean): Promise<MissionToggleResult> {
    const { token } = await firstValueFrom(this.http.get<{ token: string }>('/api/csrf'));
    const headers = new HttpHeaders({ 'x-csrf-token': token });
    return firstValueFrom(this.http.put<MissionToggleResult>('/api/missions', { id, enabled }, { headers }));
  }
}
