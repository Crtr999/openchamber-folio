import { z } from 'zod';

const text = z.string().max(500_000);
const point = z.tuple([z.number().finite().min(0).max(1000), z.number().finite().min(0).max(650)]);
const sketchElementSchema = z.object({
  id: z.string().max(100), tool: z.enum(['pen', 'line', 'rectangle', 'ellipse', 'text']),
  points: z.array(point).min(1).max(20_000), color: z.string().regex(/^#[0-9a-f]{6}$/i),
  width: z.number().min(1).max(40), text: z.string().max(2000).default(''),
});
const base = { version: z.literal(1), title: z.string().trim().min(1).max(200), template: z.boolean().default(false) };
const sheetSchema = z.object({
  name: z.string().trim().min(1).max(31).refine((name) => ![...'\\/*?:[]'].some((char) => name.includes(char)) && !name.startsWith("'") && !name.endsWith("'")),
  rows: z.array(z.array(z.string().max(10_000)).max(50)).max(500),
});
export const workspaceArtifactSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('document'), markdown: text }),
  z.object({ ...base, kind: z.literal('spreadsheet'), sheets: z.array(sheetSchema).min(1).max(20).refine((sheets) => new Set(sheets.map((sheet) => sheet.name.toLocaleLowerCase())).size === sheets.length) }),
  z.object({ ...base, kind: z.literal('presentation'), slides: z.array(z.object({ title: z.string().max(1000), body: z.string().max(30_000), notes: z.string().max(30_000) })).min(1).max(100) }),
  z.object({ ...base, kind: z.literal('sketch'), elements: z.array(sketchElementSchema).max(2000) }),
]);
export type WorkspaceArtifact = z.infer<typeof workspaceArtifactSchema>;
export type SketchElement = z.infer<typeof sketchElementSchema>;
export type ArtifactKind = WorkspaceArtifact['kind'];
export type PersonalTool = ArtifactKind | 'templates' | 'library' | 'sites' | 'references' | 'pdf' | 'teach' | 'notion';

export function createArtifact(kind: ArtifactKind, title: string): WorkspaceArtifact {
  const common = { version: 1, title, template: false } as const;
  switch (kind) {
    case 'document': return { ...common, kind, markdown: '' };
    case 'spreadsheet': return { ...common, kind, sheets: [{ name: 'Sheet1', rows: Array.from({ length: 20 }, () => Array.from({ length: 6 }, () => '')) }] };
    case 'presentation': return { ...common, kind, slides: [{ title, body: '', notes: '' }] };
    case 'sketch': return { ...common, kind, elements: [] };
  }
}

export const serializeArtifact = (artifact: WorkspaceArtifact) => JSON.stringify(workspaceArtifactSchema.parse(artifact), null, 2);
export function parseArtifact(content: string): WorkspaceArtifact {
  if (content.length > 8_000_000) throw new Error('workspace_file_too_large');
  return workspaceArtifactSchema.parse(JSON.parse(content));
}
export const isWorkspaceArtifact = (path: string | undefined) => Boolean(path?.toLowerCase().endsWith('.ocwork'));

export const artifactFilename = (title: string, id: string) => `${title.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'artifact'}-${id}.ocwork`;

/** This format is model-neutral. No private consumer-app connector is assumed. */
export function artifactPrompt(artifact: WorkspaceArtifact, brief: string, path?: string): string {
  return [
    `Work on this Open Carter ${artifact.kind}: ${brief}`,
    path ? `The editable source is ${JSON.stringify(path)}. Read its latest contents before editing. Preserve unrelated user edits.` : 'Create a new editable .ocwork file under artifacts/ in this project. Do not overwrite an existing file.',
    'Open Carter .ocwork is UTF-8 JSON with this exact version-1 structure. Preserve kind and version; fill in the user content, not placeholder text:',
    serializeArtifact(artifact),
    'The native editor opens .ocwork files, edits them, and exports documents to DOCX, workbooks to XLSX/CSV, presentations to PPTX, sketches to SVG/PNG, and every kind to PDF. Use this editable format as the source of truth. For advanced Office formatting or existing Office/PDF files, load the relevant docx/xlsx/pptx/pdf skill and use its tools; do not claim a connector exists unless it is available. Keep an editable source alongside the requested export. Never upload or publish without explicit permission.',
    'For spreadsheets, cells are strings; formulas begin with =. The native calculator supports A1 references in the current sheet, ranges, arithmetic, comparisons, SUM, AVERAGE, MIN, MAX, COUNT, and IF. Do not invent unsupported functions. At most 500 rows, 50 columns per sheet, and 20 sheets. Presentations have title, body, and notes per slide. Documents contain Markdown. Sketch coordinates are 1000 × 650.',
    'Validate the saved JSON and use openchamber file.open to show the actual file in the app. If a required tool is unavailable, report it rather than pretending the file was created.',
  ].join('\n\n');
}

export function workflowPrompt(tool: 'pdf' | 'teach' | 'notion', brief: string): string {
  if (tool === 'teach') return `Help me teach a reusable skill: ${brief}\n\nUse CarterBot's teaching workflow and check its taught skills first. Offer a recording on the Operator computer or accept an attached demonstration video. Never control or record my real Mac. Explain what will be recorded before starting. After the demonstration, draft the skill, show me the instructions for review, and test it on a safe example. Do not call a draft installed or tested until the tools confirm it. If the teaching tools are unavailable, explain what connection is missing. Stay in Open Carter.`;
  if (tool === 'notion') return `Work with my connected Notion account: ${brief}\n\nInspect the available Notion integration/tools first. Use the connected account, not invented data. Ask me to select a destination when it is ambiguous. Read-only search is fine; preview any publication, deletion, or bulk change and get confirmation before executing it. If no Notion tool is connected, explain how to connect it in Open Carter's integrations or use Operator with an explicit sign-in handoff. Do not claim the Home task-board integration grants general Notion access.`;
  return `Work on a PDF in Open Carter: ${brief}\n\nLoad the pdf skill. Use my attached files or ask for the missing source. Read, create, merge, extract, annotate, or fill as requested, verify the actual pages, and save outputs in artifacts/ without overwriting originals. Use openchamber file.open to show the resulting PDF here. If an editable document is needed, keep a Markdown or .ocwork source alongside the PDF. Do not upload anything without my permission.`;
}
