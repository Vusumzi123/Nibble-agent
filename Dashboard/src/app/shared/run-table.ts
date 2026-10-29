import { Component, input, output } from '@angular/core';

import { fmtCost, fmtDuration, fmtTime, fmtTokens } from '../core/format';
import { RunRow } from '../core/models';

@Component({
  selector: 'db-run-table',
  templateUrl: './run-table.html',
  styleUrl: './run-table.css',
})
export class RunTable {
  readonly runs = input<RunRow[]>([]);
  readonly select = output<RunRow>();

  protected fmtTime = fmtTime;
  protected fmtDuration = fmtDuration;
  protected fmtTokens = fmtTokens;
  protected fmtCost = fmtCost;

  outcomeTone(outcome: string | null): string {
    switch (outcome) {
      case 'completed':
        return 'success';
      case 'error':
      case 'aborted':
        return 'danger';
      case 'timeout':
      case 'silent':
      case 'degraded':
      case 'dropped':
        return 'warning';
      case 'declined':
      case 'nothing':
      case 'skipped':
        return 'muted';
      case 'ok':
        return 'success';
      default:
        return 'ghost';
    }
  }

  kindTone(kind: string): string {
    switch (kind) {
      case 'mission':
        return 'primary';
      case 'side':
        return 'warning';
      case 'drain':
      case 'drain-pass':
        return 'info';
      default:
        return 'ghost';
    }
  }
}
