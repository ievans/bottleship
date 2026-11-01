/**
 * Windows → bundled-font name mapping for GDI text rendering. Maps common
 * Windows face names games request to the metric-compatible Liberation fonts
 * we ship (WINDOWS_FONT_MAP), unless the face itself is installed.
 */
import { isInstalledFontName } from './font-resource';

/** Canonical Windows face names (enumerated verbatim: callers compare them case-sensitively). */
const WINDOWS_FONTS: ReadonlyArray<readonly [face: string, bundled: string]> = [
    ['Arial',                'Liberation Sans'],
    ['Helvetica',            'Liberation Sans'],
    ['MS Sans Serif',        'Liberation Sans'],
    ['Microsoft Sans Serif', 'Liberation Sans'],
    // NT5 resolves the dialog-manager alias to Microsoft Sans Serif. Keeping the
    // alias unresolved lets Canvas choose a platform UI font (often Segoe UI),
    // whose heavier stems and wider metrics do not match classic Win32 dialogs.
    ['MS Shell Dlg',         'Microsoft Sans Serif'],
    ['MS Shell Dlg 2',       'Microsoft Sans Serif'],
    ['Tahoma',               'Liberation Sans'],
    ['Verdana',              'Liberation Sans'],
    ['Courier New',          'Liberation Mono'],
    ['Courier',              'Liberation Mono'],
    ['Times New Roman',      'Liberation Serif'],
    ['Times',                'Liberation Serif'],
    ['Comic Sans MS',        'Liberation Sans'],
    ['Impact',               'Liberation Sans'],
];

const WINDOWS_FONT_MAP: ReadonlyMap<string, string> = new Map(
    WINDOWS_FONTS.map(([face, bundled]) => [face.toLowerCase(), bundled]),
);

/** Map a requested Windows face name to a bundled font; installed and unknown names pass through. */
export function resolveWindowsFontName(faceName: string): string {
    if (!faceName) return 'Liberation Sans';
    if (isInstalledFontName(faceName)) return faceName;
    const mapped = WINDOWS_FONT_MAP.get(faceName.toLowerCase());
    return mapped ?? faceName;
}

/** Realised families; the dialog-manager substitution names are not physical families. */
export function bundledFontFamilies(): string[] {
    return [...new Set([
        ...WINDOWS_FONTS.map(([face]) => face).filter(face => !face.toLowerCase().startsWith('ms shell dlg')),
        ...WINDOWS_FONT_MAP.values(),
    ])];
}
