import { isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { rememberUnboundDraftTarget } from '@/lib/projectProviderBinding';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const CLAUDE_PROJECT_LABEL = 'Claude';
/** Provider registered by the claude-code-provider plugin. */
export const CLAUDE_PROVIDER_ID = 'claude-code';

/**
 * Open the Claude project chat.
 *
 * This mirrors `openNativeChatGPT`: same project draft, same runtime guards,
 * same ZDR isolation. It differs in what it selects. ChatGPT can hand the
 * composer straight to a provider, because OpenCode signs in to OpenAI with
 * the subscription itself. There is no Anthropic equivalent — OpenCode's
 * `anthropic` integration only accepts an API key, and routing subscription
 * credentials through it is what Anthropic's authentication policy forbids.
 *
 * So Claude keeps the selected model as its orchestrator and reaches the
 * subscription through the `claude_code` tool, which runs the official
 * `claude` binary. The agent's own system prompt makes it hand the work over
 * and relay the answer.
 */
export async function openNativeClaude(setupError: string): Promise<void> {
  if (!isElectronShell() || !isDesktopLocalOriginActive()) return;
  // The account shortcut must not silently leave an active ZDR agent's pool.
  if (useConfigStore.getState().currentAgentName?.toLowerCase() === 'zdr') throw new Error(setupError);
  const source = useSessionUIStore.getState();
  const sourceIsCurrent = () => useSessionUIStore.getState().currentSessionId === source.currentSessionId
    && useSessionUIStore.getState().newSessionDraft === source.newSessionDraft;
  const runtime = getRuntimeKey();
  const sdk = opencodeClient.getSdkClient();
  const runtimeIsCurrent = () => getRuntimeKey() === runtime && opencodeClient.getSdkClient() === sdk && isDesktopLocalOriginActive();
  const { home } = await opencodeClient.getFilesystemHomeInfo();
  if (!runtimeIsCurrent()) return;
  if (useConfigStore.getState().currentAgentName?.toLowerCase() === 'zdr') throw new Error(setupError);
  if (!sourceIsCurrent()) return;
  if (!home) throw new Error(setupError);
  const directory = `${home.replace(/\/$/, '')}/Documents/Open Carter/Claude`;
  const projects = useProjectsStore.getState();
  const project = projects.projects.find(item => item.path === directory)
    ?? await projects.addProject(directory, { label: CLAUDE_PROJECT_LABEL });
  if (!runtimeIsCurrent()) return;
  if (!project) throw new Error(setupError);
  if (useConfigStore.getState().currentAgentName?.toLowerCase() === 'zdr') throw new Error(setupError);
  if (!sourceIsCurrent()) return;
  // Pin the provider and model exactly as ChatGPT pins `openai`. Claude is a
  // real provider here, so the composer runs Claude itself; leaving the model
  // unpinned is what previously let another model answer under a Claude label.
  const catalog = await opencodeClient.getProvidersForConfig(directory);
  if (!runtimeIsCurrent()) return;
  if (!sourceIsCurrent()) return;
  const claude = catalog.providers.find(item => item.id === CLAUDE_PROVIDER_ID && item.activation !== 'disabled');
  const models = claude ? catalog.models.filter(item => item.providerID === claude.id && item.enabled) : [];
  const selectedModel = models.find(item => item.id === useConfigStore.getState().currentModelId) ?? models[0];
  if (!selectedModel) {
    const ui = useUIStore.getState();
    ui.setSettingsProvidersOpenRequested(CLAUDE_PROVIDER_ID);
    ui.setSettingsPage('providers');
    ui.setSettingsDialogOpen(true);
    return;
  }
  projects.updateProjectMeta(project.id, { icon: 'claude', defaultAgent: CLAUDE_PROJECT_LABEL });
  useUIStore.getState().closeMainSurfaces();
  rememberUnboundDraftTarget({
    selectedProjectId: source.newSessionDraft.selectedProjectId ?? null,
    directoryOverride: source.newSessionDraft.directoryOverride ?? null,
    target: source.newSessionDraft.target,
  });
  useSessionUIStore.getState().openNewSessionDraft({ target: 'project', selectedProjectId: project.id, directoryOverride: directory });
  const draftId = useSessionUIStore.getState().newSessionDraft.draftId;
  const config = useConfigStore.getState();
  await config.activateDirectory(directory);
  if (!runtimeIsCurrent() || useSessionUIStore.getState().newSessionDraft.draftId !== draftId
    || useSessionUIStore.getState().newSessionDraft.directoryOverride !== directory
    || useSessionUIStore.getState().currentSessionId) return;
  const after = useConfigStore.getState();
  if (after.currentAgentName?.toLowerCase() === 'zdr') throw new Error(setupError);
  const provider = after.providers.find(item => item.id === CLAUDE_PROVIDER_ID);
  const model = provider?.models.find(item => item.id === selectedModel.id && item.enabled);
  if (!provider || !model) throw new Error(setupError);
  if (after.currentProviderId !== CLAUDE_PROVIDER_ID || after.currentModelId !== model.id) {
    after.setCurrentVariantOverride(null, undefined);
  }
  after.setProvider(CLAUDE_PROVIDER_ID);
  after.setModel(model.id);
}