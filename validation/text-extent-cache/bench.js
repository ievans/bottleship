// ../../../../../../../private/tmp/bs-r4-gdi-extent-cache/src/worker/modules/gdi32/text-extent-cache.ts
var caches = new Map;
var MAX_EXTENT_ENTRIES = 1024;
var MAX_EXTENT_FONTS = 64;
var MAX_EXTENT_TEXT = 256;
var extents = new Map;
var extentEntries = 0;
function invalidateTextExtentCache() {
  caches.clear();
  extents.clear();
  extentEntries = 0;
}
function measureWholeTextCached(ctx, text) {
  const canvas = ctx;
  const cacheable = text.length <= MAX_EXTENT_TEXT && (!canvas.letterSpacing || canvas.letterSpacing === "0px") && (!canvas.wordSpacing || canvas.wordSpacing === "0px") && (!canvas.fontKerning || canvas.fontKerning === "auto") && (!canvas.fontStretch || canvas.fontStretch === "normal") && (!canvas.fontVariantCaps || canvas.fontVariantCaps === "normal") && (!canvas.textRendering || canvas.textRendering === "auto");
  let byText = cacheable ? extents.get(ctx.font) : undefined;
  const cached = byText?.get(text);
  if (cached)
    return cached;
  let width, height = 16;
  try {
    const metrics = ctx.measureText(text);
    width = Math.round(metrics.width);
    if (metrics.fontBoundingBoxAscent !== undefined) {
      height = Math.ceil(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
    }
  } catch {
    return null;
  }
  const result = { width, height };
  if (!cacheable)
    return result;
  if (extentEntries >= MAX_EXTENT_ENTRIES || !byText && extents.size >= MAX_EXTENT_FONTS) {
    extents.clear();
    extentEntries = 0;
    byText = undefined;
  }
  if (!byText) {
    byText = new Map;
    extents.set(ctx.font, byText);
  }
  byText.set(text, result);
  extentEntries++;
  return result;
}

// ../../../../../../../private/tmp/bs-r4-canvas-bench/bench.ts
var texts = Array.from({ length: 64 }, (_, i) => ["Settings", "日本語 text", "Office ffi AV", "Load saved progress"][i % 4] + " " + i);
var fonts = ["14px Arial", "16px serif", "12px monospace", "18px sans-serif"];
var n = 1e5;
var rows = [];
function run(cached, round) {
  invalidateTextExtentCache();
  let measurements = 0, checksum = 0, consumed = 0;
  const contexts = fonts.map((font) => {
    const c = new OffscreenCanvas(64, 64).getContext("2d");
    c.font = font;
    c.textBaseline = "top";
    return { font, textBaseline: "top", measureText: (s) => {
      measurements++;
      return c.measureText(s);
    } };
  });
  const expected = texts.map((t, i) => {
    const m = contexts[i % 4].measureText(t);
    return Math.round(m.width) + Math.ceil(m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
  });
  let oracle = 0;
  for (let i = 0;i < n; i++)
    oracle += expected[i % 64];
  measurements = 0;
  const start = performance.now();
  for (let i = 0;i < n; i++) {
    const ctx = contexts[i % 4], text = texts[i % 64];
    if (cached) {
      const m = measureWholeTextCached(ctx, text);
      checksum += m.width + m.height;
    } else {
      const m = ctx.measureText(text);
      checksum += Math.round(m.width) + Math.ceil(m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
    }
    consumed++;
  }
  const ms = performance.now() - start;
  if (checksum !== oracle || consumed !== n)
    throw Error("workload or result mismatch");
  rows.push({ round, cached, ms, measurements, checksum, consumed, oracle });
}
for (let round = 0;round < 12; round++) {
  run(round % 2 === 0, round);
  run(round % 2 !== 0, round);
}
var result = { userAgent: navigator.userAgent, fonts, texts, n, rows, scope: "Canvas microbenchmark only; no guest/game performance claim" };
document.querySelector("pre").textContent = JSON.stringify(result);
