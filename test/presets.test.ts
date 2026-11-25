import { describe, expect, it } from 'vitest';
import { jointFor } from '../src/core/design';
import { analyzeStructure } from '../src/fea/structure';
import { PRESETS } from '../src/presets';

describe('presets behave as advertised', () => {
  for (const p of PRESETS) {
    it(p.title, () => {
      const d = p.make();
      const res = analyzeStructure({ parts: d.parts, jointOf: (a, b, bd) => jointFor(d, a, b, bd) });
      const rows = [...res.byPart.values()]
        .sort((a, b) => b.U - a.U)
        .slice(0, 4)
        .map((r) => `${r.info.def.name}: ${(r.U * 100).toFixed(0)}% ${r.mode}${r.unstable ? ' UNSTABLE' : ''}`);
      console.log(`[${p.expect}] ${p.title} -> ${res.status} (${res.result.timeMs.toFixed(0)} ms, lambda ${res.result.lambda.toFixed(2)})\n   ` + rows.join('\n   '));
      if (p.expect === 'fails') expect(res.status).toBe('fail');
      else expect(['ok', 'warn']).toContain(res.status);
    });
  }

  it('removing the braces makes the braced table fail', () => {
    const d = PRESETS.find((p) => p.id === 'tungsten-braced')!.make();
    const parts = d.parts.filter((p) => !p.name.startsWith('Brace'));
    const res = analyzeStructure({ parts, jointOf: (a, b, bd) => jointFor(d, a, b, bd) });
    expect(res.status).toBe('fail');
  });
});
