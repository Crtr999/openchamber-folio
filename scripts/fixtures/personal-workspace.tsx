import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useI18n } from '../../packages/ui/src/lib/i18n';
import { ThemeSystemContext } from '../../packages/ui/src/contexts/theme-system-context';
import { CSSVariableGenerator } from '../../packages/ui/src/lib/theme/cssGenerator';
import { getDefaultTheme } from '../../packages/ui/src/lib/theme/themes';
import { WorkspaceEditor } from '../../packages/ui/src/components/personal/WorkspaceEditor';
import { PersonalWorkspaceDialog } from '../../packages/ui/src/components/personal/PersonalWorkspaceDialog';
import { ComposerAttachmentControls } from '../../packages/ui/src/components/chat/composer/ui/ComposerAttachmentControls';
import { createArtifact, serializeArtifact, type PersonalTool, type WorkspaceArtifact } from '../../packages/ui/src/lib/personal-workspace/model';
import { RuntimeAPIProvider } from '../../packages/ui/src/contexts/RuntimeAPIProvider';
import { createWebAPIs } from '../../packages/web/src/api';
import { SyncProvider } from '../../packages/ui/src/sync/sync-context';
import { opencodeClient } from '../../packages/ui/src/lib/opencode/client';
import '../../packages/ui/src/index.css';

const exports: { name: string; blob: Blob }[] = [];
const apis = createWebAPIs();
// Isolated fixture data only. No app credentials, API calls or real account state.
function Fixture() {
  const { t } = useI18n();
  const [dark, setDark] = React.useState(true);
  const theme = getDefaultTheme(dark);
  React.useEffect(() => { new CSSVariableGenerator().apply(theme); }, [theme]);
  const [value, setValue] = React.useState<WorkspaceArtifact>(createArtifact('sketch', 'Sketch test'));
  const [dialog, setDialog] = React.useState<PersonalTool | null>(null);
  const [attached, setAttached] = React.useState<string[]>([]);
  const setKind = (tool: PersonalTool) => {
    if (tool === 'document') setValue({ ...createArtifact('document', 'Quarterly plan'), kind: 'document', markdown: '# Priorities\n\nMake Open Carter the place to finish the work.\n\n- Keep editable sources\n- Verify actual exports\n\n世界 — العربية — 한국어' });
    else if (tool === 'spreadsheet') setValue({ version: 1, kind: tool, title: 'Budget', template: false, sheets: [{ name: 'Budget', rows: [['Item', 'Cost'], ['Research', '125'], ['Design', '275'], ['Total', '=SUM(B2:B3)']] }] });
    else if (tool === 'presentation') setValue({ version: 1, kind: tool, title: 'Open Carter', template: false, slides: [{ title: 'Finish the work here', body: 'Editable documents\nSpreadsheets and presentations\nSketches and reusable templates', notes: 'Demonstrate the real workflow.' }, { title: 'Sources stay portable', body: '世界\nالعربية\n한국어', notes: '' }] });
    else if (tool === 'sketch') setValue(createArtifact(tool, 'Sketch test'));
  };
  const context = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
    setTheme: () => {}, reloadCustomThemes: async () => {}, importTheme: async () => theme,
    deleteImportedTheme: async () => {}, isSystemPreference: false, setSystemPreference: () => {},
    themeMode: dark ? 'dark' : 'light', setThemeMode: () => {}, lightThemeId: getDefaultTheme(false).metadata.id,
    darkThemeId: getDefaultTheme(true).metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  } satisfies React.ContextType<typeof ThemeSystemContext>;
  return <ThemeSystemContext.Provider value={context}><main className="flex h-dvh flex-col gap-4 bg-background p-5 text-foreground">
    <header className="flex flex-wrap items-center gap-4">
      <ComposerAttachmentControls isVSCode={false} footerIconButtonClass="rounded-md border p-2" iconSizeClass="size-5" handlePickLocalFiles={() => {}} openIssuePicker={() => {}} openPrPicker={() => {}} onOpenPersonalTool={setDialog} />
      {(['sketch', 'document', 'spreadsheet', 'presentation'] as const).map((kind) => <button type="button" key={kind} onClick={() => setKind(kind)}>{t(`workspace.${kind}`)}</button>)}
      <button type="button" onClick={() => setDark(!dark)}>{dark ? 'Light' : 'Dark'}</button>
      <button type="button" onClick={() => setDialog('sketch')}>Draw dialog</button>
      <button type="button" onClick={() => setDialog('sites')}>Saved sites</button>
      <button type="button" onClick={() => setDialog('teach')}>Record</button>
    </header>
    <section className="min-h-0 flex-1 rounded-xl border bg-[var(--surface-elevated)] p-4"><WorkspaceEditor key={value.kind} value={value} onChange={setValue} onExport={async (blob, name) => { exports.push({ blob, name }); document.documentElement.dataset.lastExport = name; }} /></section>
    <output data-testid="artifact-json" className="hidden">{serializeArtifact(value)}</output>
    <output data-testid="export-count">{exports.length}</output>
    <output data-testid="attached">{attached.join(',')}</output>
    {dialog && <PersonalWorkspaceDialog tool={dialog} directory="/fixture" isCurrent={() => true} onClose={() => setDialog(null)} onPrompt={() => {}} onAttach={async (files) => setAttached(files.map((file) => file.name))} onReference={async (reference) => setAttached([reference.title])} />}
  </main></ThemeSystemContext.Provider>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root is missing');
createRoot(root).render(<RuntimeAPIProvider apis={apis}><SyncProvider sdk={opencodeClient} directory="/fixture"><I18nProvider><Fixture /></I18nProvider></SyncProvider></RuntimeAPIProvider>);
Object.assign(window, { workspaceFixtureExports: exports });
