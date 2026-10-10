/** Events for the Notion-style quick search palette (see NotionSearchPalette). */
export const SEARCH_PALETTE_EVENT = 'open-carter:search-palette';
export const ADVANCED_SEARCH_EVENT = 'open-carter:advanced-chat-search';
export const openSearchPalette = () => window.dispatchEvent(new CustomEvent(SEARCH_PALETTE_EVENT));
/** Open the palette straight onto the Today card. */
export const TODAY_EVENT = 'open-carter:today';
export const openTodayCard = () => window.dispatchEvent(new CustomEvent(TODAY_EVENT));
