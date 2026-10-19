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
 * Sketch is the creation option readers look for first, so its scribble keeps
 * the reference mark's teal (`#169682`) instead of the muted row tone. Every
 * other row shares `MENU_ICON_CLASS` unchanged.
 */
export const personalToolIconClass = (tool: PersonalTool): string => tool === 'sketch' ? 'size-[18px] shrink-0 text-[#169682]' : MENU_ICON_CLASS;