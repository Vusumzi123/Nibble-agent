import { describe, expect, it } from 'vitest';

import { MessageRow } from './models';
import { mapSessionMessages } from './transcript-map';

function row(parts: NonNullable<MessageRow['parts']>): MessageRow {
  return { info: { role: 'assistant', time: { created: 1700000000000 } }, parts };
}

describe('mapSessionMessages', () => {
  it('maps text parts to text entries with the "kael" label for assistants', () => {
    const out = mapSessionMessages([row([{ type: 'text', text: 'hello' }])]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: 'assistant', kind: 'text', label: 'kael', body: 'hello', ts: 1700000000000 });
  });

  it('labels user text entries by role', () => {
    const out = mapSessionMessages([{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }]);
    expect(out[0].label).toBe('user');
    expect(out[0].role).toBe('user');
  });

  it('maps reasoning and thought parts to thought entries', () => {
    const out = mapSessionMessages([
      row([{ type: 'reasoning', text: 'thinking…' }, { type: 'thought', text: 'also thinking' }]),
    ]);
    expect(out.map((e) => e.kind)).toEqual(['thought', 'thought']);
    expect(out.map((e) => e.label)).toEqual(['thought', 'thought']);
    expect(out[1].body).toBe('also thinking');
  });

  it('maps tool parts with status and truncated JSON body', () => {
    const long = { payload: 'x'.repeat(5000) };
    const out = mapSessionMessages([
      row([{ type: 'tool', tool: 'bash', state: { status: 'completed', title: 'ok', input: long } }]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('tool');
    expect(out[0].label).toBe('bash · ok');
    expect(out[0].status).toBe('completed');
    expect(out[0].body.length).toBeLessThanOrEqual(4000);
  });

  it('produces unique ids across rows and parts', () => {
    const out = mapSessionMessages([
      row([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
      row([{ type: 'text', text: 'c' }]),
    ]);
    expect(out.map((e) => e.id)).toEqual(['0-0', '0-1', '1-0']);
  });

  it('skips empty text and unknown part types', () => {
    const out = mapSessionMessages([row([{ type: 'text', text: '' }, { type: 'mystery' }])]);
    expect(out).toHaveLength(0);
  });

  it('tolerates rows without info or parts', () => {
    expect(mapSessionMessages([{}])).toEqual([]);
    expect(mapSessionMessages([])).toEqual([]);
  });
});
