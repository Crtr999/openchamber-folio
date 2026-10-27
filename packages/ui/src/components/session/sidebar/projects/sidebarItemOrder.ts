export const WEBSITE_SIDEBAR_IDS = ['website:chatgpt', 'website:claude', 'website:venice', 'website:gemini'] as const;

export type WebsiteSidebarId = (typeof WEBSITE_SIDEBAR_IDS)[number];

const WEBSITE_SIDEBAR_ID_SET: ReadonlySet<string> = new Set(WEBSITE_SIDEBAR_IDS);

export const isWebsiteSidebarId = (id: string): id is WebsiteSidebarId => WEBSITE_SIDEBAR_ID_SET.has(id);

/**
 * Empty or missing saved order keeps folders first, then the website rows.
 * A saved order keeps ids that are still a known project or a website id,
 * then appends projects that arrived since, then any website id not yet listed.
 */
export const mergeSidebarItemOrder = (
  projectIds: readonly string[],
  saved: readonly string[] | null | undefined,
): string[] => {
  if (!saved || saved.length === 0) return [...projectIds, ...WEBSITE_SIDEBAR_IDS];
  const projects = new Set(projectIds);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of saved) {
    if (seen.has(id)) continue;
    if (!projects.has(id) && !isWebsiteSidebarId(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  for (const id of projectIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  for (const id of WEBSITE_SIDEBAR_IDS) {
    if (seen.has(id)) continue;
    kept.push(id);
  }
  return kept;
};
