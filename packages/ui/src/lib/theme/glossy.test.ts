import { describe, expect, test } from 'bun:test';

import { contrastRatio, mixColor } from './color';
import { requireTheme } from './definition';
import { getReadableThemeColors } from './readableColors';
import { CSSVariableGenerator } from './cssGenerator';
import { getThemeById, themes } from './themes';
import glossyDarkRaw from './themes/glossy-dark.json';
import glossyLightRaw from './themes/glossy-light.json';

const GLOSSY_IDS = ['glossy-dark', 'glossy-light'];

const glossyThemes = GLOSSY_IDS.map((id) => {
  const theme = getThemeById(id);
  if (!theme) {
    throw new Error(`Glossy preset ${id} is not registered`);
  }
  return theme;
});

/**
 * Every colour the browser can actually paint from a theme's authored backdrop,
 * flattened onto the canvas. A backdrop is authored as one CSS value, so the
 * only honest way to know what a pane can end up sitting on is to read the
 * stops out of that value and composite each one.
 */
const paintedBackdrops = (backdrop: string, canvas: string): string[] => {
  const stops = backdrop.match(/#[0-9a-f]{6}([0-9a-f]{2})?/gi) ?? [];
  if (!stops.length) {
    throw new Error('A backdrop must name at least one colour');
  }
  return stops.map((stop) => mixColor(stop, canvas, 1, canvas));
};

const relativeLuminance = (color: string): number => {
  const hex = color.replace('#', '');
  const channel = (raw: string) => {
    const value = parseInt(raw, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return (
    channel(hex.slice(0, 2)) * 0.2126 +
    channel(hex.slice(2, 4)) * 0.7152 +
    channel(hex.slice(4, 6)) * 0.0722
  );
};

/**
 * The backdrop patch a panel is least readable against: the lightest one in a
 * dark theme, the darkest in a light one. Frosted glass is only as legible as
 * the worst place the wallpaper puts under it.
 */
const worstBackdrop = (backdrop: string, canvas: string, dark: boolean): string => {
  const stops = paintedBackdrops(backdrop, canvas);
  return stops.reduce((worst, stop) =>
    (relativeLuminance(stop) - relativeLuminance(worst)) * (dark ? 1 : -1) > 0 ? stop : worst,
  );
};

const luminanceSeparation = (first: string, second: string): number => {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

describe('Glossy presets', () => {
  test('registers both variants under one name, resolvable by id', () => {
    expect(themes.filter((theme) => theme.metadata.name === 'Glossy').map((theme) => theme.metadata.id)).toEqual(GLOSSY_IDS);
    for (const [index, id] of GLOSSY_IDS.entries()) {
      const theme = getThemeById(id);
      expect(theme?.metadata.variant).toBe(index === 0 ? 'dark' : 'light');
      expect(theme?.metadata.version).toBe('1.0.0');
      expect(theme?.metadata.description.length).toBeGreaterThan(0);
    }
  });

  test('resolves both authored files into a complete palette through the validator', () => {
    for (const raw of [glossyDarkRaw, glossyLightRaw]) {
      const theme = requireTheme(raw);
      expect(theme.metadata.id.startsWith('glossy-')).toBe(true);
      expect(theme.colors.surface.backdrop).toBeDefined();
      expect(/^#[0-9a-f]{6}$/i.test(theme.colors.surface.elevatedForeground)).toBe(true);
      expect(theme.colors.syntax.base.background).toBeDefined();
      expect(new CSSVariableGenerator().generate(theme)).not.toContain('undefined');
    }
  });

  test('paints a backdrop only where a wallpaper is authored', () => {
    const withBackdrop = themes.filter((theme) => theme.colors.surface.backdrop !== undefined);
    expect(withBackdrop.map((theme) => theme.metadata.id).sort()).toEqual(GLOSSY_IDS);
  });

  test('leaves the canvas opaque so the native shells and the splash get a colour they can read', () => {
    for (const theme of glossyThemes) {
      // FolioSurfaceColor.fromHexString (AppDelegate.swift) and the desktop
      // splash both accept #rgb and #rrggbb and nothing else. An alpha channel
      // here would leave the iPhone window, the web view and the native page
      // editor on the system background instead of the theme's.
      expect(/^#[0-9a-f]{6}$/i.test(theme.colors.surface.background)).toBe(true);
    }
  });
});

describe('Glossy legibility over its own wallpaper', () => {
  for (const theme of glossyThemes) {
    const dark = theme.metadata.variant === 'dark';
    const backdrop = theme.colors.surface.backdrop ?? '';
    const worst = worstBackdrop(backdrop, theme.colors.surface.background, dark);
    const readable = getReadableThemeColors(theme);
    const surface = theme.colors.surface;

    const pairings: Array<[string, string, string]> = [
      ['canvas text', surface.foreground, surface.background],
      ['muted panel text', surface.foreground, surface.muted],
      ['elevated panel text', surface.elevatedForeground, surface.elevated],
      ['canvas text on an elevated panel', surface.foreground, surface.elevated],
      ['subtle fill text', surface.foreground, surface.subtle],
      ['muted foreground on the canvas', surface.mutedForeground, surface.background],
      ['muted foreground on a muted panel', surface.mutedForeground, surface.muted],
      ['muted foreground on an elevated panel', surface.mutedForeground, surface.elevated],
      ['user message text', surface.foreground, theme.colors.chat?.userMessageBackground ?? surface.elevated],
      ['inline code', theme.colors.markdown?.inlineCode ?? theme.colors.syntax.base.string, theme.colors.markdown?.inlineCodeBackground ?? surface.background],
      ['blockquote', theme.colors.markdown?.blockquote ?? surface.mutedForeground, surface.background],
      ['markdown link', theme.colors.markdown?.link ?? theme.colors.primary.base, surface.background],
      ['primary button label', theme.colors.primary.foreground ?? theme.colors.surface.background, theme.colors.primary.base],
      ['selected row label', theme.colors.interactive.selectionForeground, theme.colors.interactive.selection],
      ['code text', theme.colors.syntax.base.foreground, theme.colors.syntax.base.background],
      ['code comment', theme.colors.syntax.base.comment, theme.colors.syntax.base.background],
      ['code keyword', theme.colors.syntax.base.keyword, theme.colors.syntax.base.background],
      ['code string', theme.colors.syntax.base.string, theme.colors.syntax.base.background],
      ['code number', theme.colors.syntax.base.number, theme.colors.syntax.base.background],
      ['code function', theme.colors.syntax.base.function, theme.colors.syntax.base.background],
      ['code variable', theme.colors.syntax.base.variable, theme.colors.syntax.base.background],
      ['code type', theme.colors.syntax.base.type, theme.colors.syntax.base.background],
      ['code operator', theme.colors.syntax.base.operator, theme.colors.syntax.base.background],
    ];

    for (const [name, text] of Object.entries(readable.tinted)) {
      for (const [surfaceName, fill] of [
        ['canvas', surface.background],
        ['muted', surface.muted],
        ['elevated', surface.elevated],
      ] as const) {
        pairings.push([`${name} text on the ${surfaceName}`, text, fill]);
      }
    }

    for (const [name, text] of Object.entries(readable.status)) {
      for (const [surfaceName, fill] of [
        ['canvas', surface.background],
        ['elevated', surface.elevated],
      ] as const) {
        pairings.push([`${name} alert on the ${surfaceName}`, text, fill]);
      }
    }

    test(`${theme.metadata.id} keeps every text-on-surface pairing at 4.5:1 over its worst backdrop`, () => {
      const failures: string[] = [];
      for (const [name, text, fill] of pairings) {
        const ratio = contrastRatio(text, fill, worst);
        if (ratio === null || ratio < 4.5) {
          failures.push(`${name}: ${ratio === null ? 'unmeasurable' : ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    test(`${theme.metadata.id} keeps code and canvas within the built-in surface-separation budget`, () => {
      // This budget is about code reading as the same page, not about the panel
      // edge: a pane is *meant* to separate from the canvas under glass.
      const codeOverWallpaper = mixColor(theme.colors.syntax.base.background, worst, 1, worst);
      const canvasOverWallpaper = mixColor(theme.colors.surface.background, worst, 1, worst);
      expect(luminanceSeparation(codeOverWallpaper, canvasOverWallpaper)).toBeLessThanOrEqual(1.1);
    });
  }
});

describe('Glossy scoping', () => {
  test('emits the backdrop variable only for a theme that authors one', () => {
    const generator = new CSSVariableGenerator();
    for (const theme of themes) {
      const css = generator.generate(theme);
      const authored = theme.colors.surface.backdrop !== undefined;
      expect(css.includes('--surface-backdrop:')).toBe(authored);
    }
  });

  test('leaves every other preset byte-identical to a theme that gained the field', () => {
    // The new authored field must be additive: a preset without a backdrop
    // generates exactly the stylesheet it did before, so nothing about the
    // other twenty themes can shift because this one exists.
    const generator = new CSSVariableGenerator();
    for (const theme of themes) {
      if (theme.metadata.id.startsWith('glossy-')) continue;
      const css = generator.generate(theme);
      expect(css).not.toContain('backdrop');
      expect(theme.colors.surface.backdrop).toBeUndefined();
    }
  });
});
