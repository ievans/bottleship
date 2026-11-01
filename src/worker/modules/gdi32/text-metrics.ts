/** Vertical metrics of the context's current font, as GDI's TEXTMETRIC reports them. */
export interface VerticalMetrics {
    /** Baseline distance from the top of the cell (tmAscent). */
    ascent: number;
    /** Baseline distance to the bottom of the cell (tmDescent). */
    descent: number;
    /** tmHeight == ascent + descent == GetTextExtentPoint32 cy. */
    height: number;
}

type MeasureCtx = Pick<OffscreenCanvasRenderingContext2D, 'measureText' | 'textBaseline'>;

/**
 * fontBoundingBoxAscent/Descent are relative to the context's textBaseline, so a context left on
 * 'top' (every GDI DC draws that way) reports ascent≈0 and descent≈cell height. GDI's split is
 * about the alphabetic baseline; measure there and restore the caller's baseline.
 */
export function measureVerticalMetrics(ctx: MeasureCtx, fontSizeHint = 16): VerticalMetrics {
    let asc = fontSizeHint * 0.8;
    let desc = fontSizeHint * 0.2;
    const saved = ctx.textBaseline;
    try {
        ctx.textBaseline = 'alphabetic';
        const m = ctx.measureText('ABCgjpqy');
        if (m.fontBoundingBoxAscent !== undefined) {
            asc = m.fontBoundingBoxAscent;
            desc = m.fontBoundingBoxDescent;
        }
    } catch { /* keep the font-size estimate */ } finally {
        ctx.textBaseline = saved;
    }
    const ascent = Math.ceil(asc);
    const descent = Math.ceil(desc);
    return { ascent, descent, height: Math.max(1, ascent + descent) };
}
