import { expect, test } from 'bun:test';
import { measureVerticalMetrics } from '../../src/worker/modules/gdi32/text-metrics';

function fakeCtx(initial: 'top' | 'alphabetic') {
    const ctx = {
        textBaseline: initial,
        measureText: () => (ctx.textBaseline === 'top'
            ? { fontBoundingBoxAscent: 2.14, fontBoundingBoxDescent: 13.86 }
            : { fontBoundingBoxAscent: 13, fontBoundingBoxDescent: 3 }),
    };
    return ctx;
}

test('splits ascent/descent at the alphabetic baseline even when the DC draws from the top', () => {
    const ctx = fakeCtx('top');
    expect(measureVerticalMetrics(ctx as never)).toEqual({ ascent: 13, descent: 3, height: 16 });
    expect(ctx.textBaseline).toBe('top');
});

test('same answer from an alphabetic context', () => {
    expect(measureVerticalMetrics(fakeCtx('alphabetic') as never)).toEqual({ ascent: 13, descent: 3, height: 16 });
});

test('estimates from the size hint when the context cannot report font bounds', () => {
    const ctx = { textBaseline: 'top', measureText: () => ({}) };
    expect(measureVerticalMetrics(ctx as never, 20)).toEqual({ ascent: 16, descent: 4, height: 20 });
});
