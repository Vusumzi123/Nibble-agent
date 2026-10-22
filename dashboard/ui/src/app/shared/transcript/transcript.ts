import { Component, input } from '@angular/core';

import { fmtTime } from '../../core/format';
import { MessagePart, MessageRow } from '../../core/models';

@Component({
  selector: 'app-transcript',
  templateUrl: './transcript.html',
  styleUrl: './transcript.css',
})
export class TranscriptComponent {
  readonly rows = input.required<MessageRow[]>();

  protected readonly fmtTime = fmtTime;

  protected role(row: MessageRow): string {
    return typeof row.info?.role === 'string' ? row.info.role : 'unknown';
  }

  protected created(row: MessageRow): number | null {
    const t = row.info?.time?.created;
    return typeof t === 'number' ? t : null;
  }

  protected partText(part: MessagePart): string {
    return typeof part.text === 'string' ? part.text : '';
  }

  protected toolInput(part: MessagePart): string {
    return this.stringify(part.state?.input);
  }

  protected toolOutput(part: MessagePart): string {
    const state = part.state;
    if (state?.error !== undefined && state.error !== null) {
      return this.stringify(state.error);
    }
    return this.stringify(state?.output);
  }

  protected toolTitle(part: MessagePart): string {
    return typeof part.state?.title === 'string' ? part.state.title : '';
  }

  protected toolStatus(part: MessagePart): string {
    return typeof part.state?.status === 'string' ? part.state.status : '';
  }

  private stringify(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}
