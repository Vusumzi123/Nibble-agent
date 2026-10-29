import { Component, computed, effect, inject, signal } from '@angular/core';

import { errorText } from '../core/api';
import { fmtDuration } from '../core/format';
import { SettingField, SettingsSection } from '../core/models';
import { DashboardStore } from '../core/store';
import { UiService } from '../core/ui';

@Component({
  selector: 'db-setup-page',
  templateUrl: './setup.html',
  styleUrl: './setup.css',
})
export class SetupPage {
  protected readonly store = inject(DashboardStore);
  private readonly ui = inject(UiService);

  protected readonly active = signal('autonomy');
  protected readonly query = signal('');
  protected readonly saving = signal<string | null>(null);
  protected readonly drafts = signal<Record<string, unknown>>({});

  protected fmtDuration = fmtDuration;

  protected readonly sections = computed(() => this.store.settings()?.sections ?? []);

  protected readonly presentLocks = computed(() => this.store.locks().filter((lock) => lock.present));

  protected readonly lockSummary = computed(() => {
    const present = this.presentLocks();
    if (!present.length) return 'none';
    return present.map((lock) => `${lock.name.replace('.lock', '')} ${fmtDuration(lock.age_ms)}`).join(' · ');
  });

  protected readonly section = computed(() => this.sections().find((s) => s.id === this.active()) ?? this.sections()[0]);

  protected readonly dirtyCount = computed(
    () => Object.keys(this.drafts()).filter((path) => this.isDirtyPath(path)).length,
  );

  constructor() {
    effect(() => {
      const sections = this.sections();
      if (sections.length && !sections.some((s) => s.id === this.active())) this.active.set(sections[0].id);
    });
  }

  protected visibleFields(section: SettingsSection): SettingField[] {
    const q = this.query().trim().toLowerCase();
    if (!q) return section.fields;
    return section.fields.filter((f) => `${f.path} ${f.label} ${f.help}`.toLowerCase().includes(q));
  }

  protected dirtyFor(section: SettingsSection): SettingField[] {
    return section.fields.filter((field) => this.isDirty(field));
  }

  private isDirtyPath(path: string): boolean {
    for (const section of this.sections()) {
      const field = section.fields.find((f) => f.path === path);
      if (field) return this.isDirty(field);
    }
    return false;
  }

  private isDirty(field: SettingField): boolean {
    if (!(field.path in this.drafts())) return false;
    return JSON.stringify(this.drafts()[field.path]) !== JSON.stringify(field.value);
  }

  private raw(field: SettingField): unknown {
    return field.path in this.drafts() ? this.drafts()[field.path] : field.value;
  }

  protected boolValue(field: SettingField): boolean {
    return this.raw(field) === true;
  }

  protected stringValue(field: SettingField): string {
    const value = this.raw(field);
    return value === null || value === undefined ? '' : String(value);
  }

  protected numberValue(field: SettingField): number {
    const value = this.raw(field);
    return typeof value === 'number' ? value : 0;
  }

  protected listValue(field: SettingField): string {
    const value = this.raw(field);
    return Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }

  private setDraft(path: string, value: unknown): void {
    this.drafts.update((drafts) => ({ ...drafts, [path]: value }));
  }

  protected setBool(field: SettingField, value: boolean): void {
    this.setDraft(field.path, value);
  }

  protected setString(field: SettingField, value: string): void {
    this.setDraft(field.path, value);
  }

  protected setNumber(field: SettingField, value: number, float: boolean): void {
    this.setDraft(field.path, float ? value : Math.trunc(value));
  }

  protected setList(field: SettingField, value: string): void {
    this.setDraft(field.path, value.split(',').map((s) => s.trim()).filter(Boolean));
  }

  protected setBudget(field: SettingField, value: string): void {
    const trimmed = value.trim();
    this.setDraft(field.path, trimmed === 'unlimited' ? 'unlimited' : Number(trimmed));
  }

  protected reset(section: SettingsSection): void {
    this.drafts.update((drafts) => {
      const next = { ...drafts };
      for (const field of section.fields) delete next[field.path];
      return next;
    });
  }

  protected async apply(section: SettingsSection): Promise<void> {
    const updates = this.dirtyFor(section).map((field) => ({ path: field.path, value: this.drafts()[field.path] }));
    if (!updates.length) return;
    this.saving.set(section.id);
    try {
      const count = await this.store.saveSettings(updates);
      this.reset(section);
      this.ui.notify(`${section.label}: ${count} setting${count === 1 ? '' : 's'} applied`, 'success');
    } catch (err) {
      this.ui.notify(errorText(err), 'danger');
    } finally {
      this.saving.set(null);
    }
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
}
