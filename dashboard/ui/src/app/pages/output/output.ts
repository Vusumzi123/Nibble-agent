import { Component, inject } from '@angular/core';

import { DashboardStore } from '../../core/store';
import { TranscriptComponent } from '../../shared/transcript/transcript';

@Component({
  selector: 'app-output-page',
  templateUrl: './output.html',
  imports: [TranscriptComponent],
})
export class OutputPage {
  protected readonly store = inject(DashboardStore);
}
