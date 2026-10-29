import { Component, inject } from '@angular/core';

import { DashboardStore } from '../core/store';

@Component({
  selector: 'db-load-overlay',
  templateUrl: './load-overlay.html',
  styleUrl: './load-overlay.css',
})
export class LoadOverlay {
  protected readonly store = inject(DashboardStore);
  protected readonly cells = Array.from({ length: 336 }, (_, index) => index);
}
