/**
 * One icon per personal creation option.
 *
 * ChatGPT labels every composer action and pairs it with a glyph that explains
 * what the action actually does. Before this map, six different options shared
 * one generic `file` glyph on desktop and the mobile sheet rendered none at all,
 * so a reader could not tell a spreadsheet from a slide deck. Keep this map and
 * the mobile list in sync: both surfaces read `PERSONAL_TOOL_ICONS`.
 *
 * Glyph names follow `components/icon/README.md`: kebab-case derived from the
 * Remixicon `RiXxxLine` component, with `Line` dropped and `Fill` becoming
 * `-fill`. Regenerate the sprite with `bun run icons:generate` after adding a
 * name here.
 */

import type { IconName } from '@/components/icon/icons';
import type { PersonalTool } from '@/lib/personal-workspace/model';

// Annotated as `Record<..., IconName>` on purpose: `scripts/generate-icon-sprite.mjs`
// scans source for that exact shape and pulls these literals into the sprite.
export const PERSONAL_TOOL_ICONS: Record<PersonalTool, IconName> = {
  // Draws: a hand-drawn scribble stroke (custom product glyph).
  sketch: 'sketch-scribble',
  // Content kinds get their own document shape instead of a generic page.
  document: 'file-text',
  spreadsheet: 'file-list',
  presentation: 'file-ppt',
  pdf: 'file-pdf',
  // Templates are a stack of reusable starting points; the library is the store.
  templates: 'stack',
  library: 'archive',
  // Recording is a record button, not a timer.
  teach: 'record-circle',
  // World and magnifier already read correctly for sites and references.
  sites: 'global',
  references: 'search',
  notion: 'notion',
};

/**
 * Menu rows are a fixed-height list, so every glyph gets the same box and the
 * labels stay on one baseline. `shrink-0` stops a long localized label from
 * squeezing the icon.
 */
export const MENU_ICON_CLASS = 'size-[18px] shrink-0 text-muted-foreground';

/**
 * The colour each creation option wears.
 *
 * A menu of grey glyphs is a menu nobody wants to click: the colour is the
 * fastest way to say what a row is, and a person reaching for a sketch or a
 * slide deck reaches for the colour they remember. These are the ink colours
 * the rest of the app already uses, so the menu and the panels it opens look
 * like the same product.
 */
export const PERSONAL_TOOL_ICON_COLORS: Record<PersonalTool, string> = {
  // The reference mark's teal: the scribble keeps the colour it always had.
  sketch: '#169682',
  document: '#2f6feb',
  spreadsheet: '#1f8a4c',
  presentation: '#d97706',
  pdf: '#dc2626',
  templates: '#7c3aed',
  library: '#0891b2',
  teach: '#db2777',
  sites: '#2563eb',
  references: '#0f766e',
  notion: '#64748b',
};

/**
 * The glyph, in its own colour, at the size the menu rows use.
 */
export const personalToolIconClass = (tool: PersonalTool): string =>
  `size-[18px] shrink-0`;
export const personalToolIconStyle = (tool: PersonalTool): { color: string } =>
  ({ color: PERSONAL_TOOL_ICON_COLORS[tool] });