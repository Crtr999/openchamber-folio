import { isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { rememberUnboundDraftTarget } from '@/lib/projectProviderBinding';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Open the ordinary OpenCode project chat, with website history kept separately. */
export async function openNativeChatGPT(setupError: string): Promise<void> {
  if (isElectronShell() && !isDesktopLocalOriginActive()) return;
  // The account shortcut must not silently leave an active ZDR agent's pool.
  if (useConfigStore.getState().currentAgentName?.toLowerCase() === 'zdr') throw new Error(setupError);
  const activeAgent = useConfigStore.getState().currentAgentName;
  const source = useSessionUIStore.getState();
  const sourceIsCurrent = () => useSessionUIStore.getState().currentSessionId === source.currentSessionId
    && useSessionUIStore.getState().newSessionDraft === source.newSessionDraft
    && useConfigStore.getState().currentAgentName === activeAgent;
  const runtime = getRuntimeKey();
  const sdk = opencodeClient.getSdkClient();
  const runtimeIsCurrent = () => getRuntimeKey() === runtime && opencodeClient.getSdkClient() === sdk && (!isElectronShell() || isDesktopLocalOriginActive());
  const { home } = await opencodeClient.getFilesystemHomeInfo();
  if (!runtimeIsCurrent()) return;
  if (useConfigStore.getState().currentAgentName?.toLowerCase() === 'zdr') throw new Error(setupError);
  if (!sourceIsCurrent()) return;
  if (!home) throw new Error(setupError);
  const directory = `${home.replace(/\/$/, '')}/Documents/Open Carter/ChatGPT`;
  const projects = useProjectsStore.getState();
  const project = projects.projects.find(item => item.path === directory)
    ?? await projects.addProject(directory, { label: 'ChatGPT' });
  if (!runtimeIsCurrent()) return;
  if (!project) throw new Error(setupError);
  if (useConfigStore.getState().currentAgentName?.toLowerCase() === 'zdr') throw new Error(setupError);
  if (!sourceIsCurrent()) return;
  const catalog = await opencodeClient.getProvidersForConfig(directory);
  if (!runtimeIsCurrent()) return;
  if (useConfigStore.getState().currentAgentName?.toLowerCase() === 'zdr') throw new Error(setupError);
  if (!sourceIsCurrent()) return;
  const connected = catalog.providers.find(item => item.id === 'openai' && item.activation !== 'disabled');
  const models = connected ? catalog.models.filter(item => item.providerID === connected.id && item.enabled) : [];
  const selectedModel = models.find(item => item.id === useConfigStore.getState().currentModelId) ?? models[0];
  if (!selectedModel) {
    const ui = useUIStore.getState();
    ui.setSettingsProvidersOpenRequested('openai');
    ui.setSettingsPage('providers');
    ui.setSettingsDialogOpen(true);
    return;
  }
  projects.updateProjectMeta(project.id, { icon: 'chatgpt', defaultAgent: 'ChatGPT' });
  useUIStore.getState().closeMainSurfaces();
  rememberUnboundDraftTarget({
    selectedProjectId: source.newSessionDraft.selectedProjectId ?? null,
    directoryOverride: source.newSessionDraft.directoryOverride ?? null,
    target: source.newSessionDraft.target,
  });
  useSessionUIStore.getState().openNewSessionDraft({ target: 'project', selectedProjectId: project.id, directoryOverride: directory });
  const draftId = useSessionUIStore.getState().newSessionDraft.draftId;
  const targetAgent = activeAgent?.toLowerCase() === 'claude' ? 'ChatGPT' : activeAgent;
  useConfigStore.getState().setAgent(targetAgent);
  const selectionBeforeActivation = useConfigStore.getState();
  await useConfigStore.getState().activateDirectory(directory);
  if (!runtimeIsCurrent() || useSessionUIStore.getState().newSessionDraft.draftId !== draftId
    || useSessionUIStore.getState().newSessionDraft.directoryOverride !== directory
    || useSessionUIStore.getState().currentSessionId) return;
  const config = useConfigStore.getState();
  if (config.currentAgentName?.toLowerCase() === 'zdr') throw new Error(setupError);
  // A newer composer choice owns the draft, including while its project loads.
  if (config.currentAgentName !== targetAgent || (config.selectionSource === 'manual'
    && (selectionBeforeActivation.selectionSource !== 'manual'
      || config.currentProviderId !== selectionBeforeActivation.currentProviderId
      || config.currentModelId !== selectionBeforeActivation.currentModelId))) return;
  if (config.currentVariantSelection.override !== undefined
    && config.currentVariantSelection.override !== selectionBeforeActivation.currentVariantSelection.override) return;
  const provider = config.providers.find(item => item.id === 'openai');
  const model = provider?.models.find(item => item.id === selectedModel.id && item.enabled);
  if (!provider || !model) throw new Error(setupError);
  if (config.currentProviderId !== 'openai' || config.currentModelId !== model.id) {
    config.setCurrentVariantOverride(null, undefined);
  }
  config.setProvider('openai');
  config.setModel(model.id);
}
