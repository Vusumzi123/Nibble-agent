import { Injectable, signal } from '@angular/core';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

@Injectable({ providedIn: 'root' })
export class UiService {
  readonly toast = signal<Toast | null>(null);
  private seq = 0;

  notify(message: string, tone: ToastTone = 'info'): void {
    const id = ++this.seq;
    this.toast.set({ id, message, tone });
    setTimeout(() => {
      if (this.toast()?.id === id) this.toast.set(null);
    }, 3200);
  }

  dismiss(): void {
    this.toast.set(null);
  }
}
