import { MessageRow, TranscriptEntry } from './models';

export function mapSessionMessages(rows: MessageRow[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  rows.forEach((row, i) => {
    const role = row.info?.role ?? 'unknown';
    const ts = row.info?.time?.created ?? null;
    (row.parts ?? []).forEach((part, j) => {
      const id = `${i}-${j}`;
      if (part.type === 'text' && part.text) {
        out.push({ id, role, kind: 'text', label: role === 'assistant' ? 'kael' : role, body: part.text, ts });
      } else if ((part.type === 'reasoning' || part.type === 'thought') && part.text) {
        out.push({ id, role, kind: 'thought', label: 'thought', body: part.text, ts });
      } else if (part.type === 'tool') {
        const title = part.state?.title ? ` · ${part.state.title}` : '';
        out.push({
          id,
          role,
          kind: 'tool',
          label: `${part.tool ?? 'tool'}${title}`,
          body: JSON.stringify(part.state?.input ?? part.state?.output ?? '', null, 2).slice(0, 4000),
          ts,
          status: part.state?.status,
        });
      }
    });
  });
  return out;
}
