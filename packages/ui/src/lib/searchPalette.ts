/** Events for the Notion-style quick search palette (see NotionSearchPalette). */
export const SEARCH_PALETTE_EVENT = 'open-carter:search-palette';
export const ADVANCED_SEARCH_EVENT = 'open-carter:advanced-chat-search';
export const openSearchPalette = () => window.dispatchEvent(new CustomEvent(SEARCH_PALETTE_EVENT));
