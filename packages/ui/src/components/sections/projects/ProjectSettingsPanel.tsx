import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { HomeFriendAvatar } from '@/components/chat/HomeFriendAvatar';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';
import { ProjectActionsSection } from '@/components/sections/projects/ProjectActionsSection';
import { ProjectIdentityFields } from '@/components/sections/projects/ProjectIdentityFields';
import { ProjectSettingsSubsection } from '@/components/sections/projects/ProjectSettingsSubsection';
import { SharedProjectConfigSection } from '@/components/sections/projects/SharedProjectConfigSection';
import {
  useProjectIdentityForm,
  type ProjectIdentitySaveData,
} from '@/components/sections/projects/useProjectIdentityForm';
import { useProjectIdentityAutoSave } from '@/components/sections/projects/useProjectIdentityAutoSave';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ProjectRulesSnapshot } from '@/lib/api/project-rules-schema';
import type { ProjectEntry } from '@/lib/api/types';
import {
  FRIEND_BODIES,
  FRIEND_COLORS,
  buildGuardrailPoliciesAndPermissions,
  folderFriendAppearance,
  folderFriendKey,
  folderFriendName,
  folderFriendRole,
  friendColorVariable,
  readFriendProfiles,
  saveFriendProfile,
  summarizeFolderGuardrails,
  type FolderGuardrailEffect,
  type FolderGuardrailState,
} from '@/lib/friends';
import { clearProviderBindingCache } from '@/lib/projectProviderBinding';
import { getRuntimeKey } from '@/lib/runtime-switch';

type ProjectSettingsPanelProps = {
  project: ProjectEntry | null;
  onIdentitySave: (data: ProjectIdentitySaveData) => void | Promise<void>;
  /**
   * The project-edit dialog hides the worktree section — worktrees have
   * their own full-page surface (project menu → Manage worktrees). Settings
   * keeps the full panel.
   */
  showWorktrees?: boolean;
};

const GUARDRAIL_ITEMS: ReadonlyArray<{
  key: keyof Omit<FolderGuardrailState, 'zdrLocked' | 'allowedProviders'>;
  label: string;
}> = [
  { key: 'computerUse', label: 'Virtual Computer (CarterBot)' },
  { key: 'macControl', label: 'Mac App Control' },
  { key: 'browserControl', label: 'Browser Automation' },
  { key: 'webAccess', label: 'Web Search & Fetch' },
  { key: 'fileAndShell', label: 'File Edits & Shell' },
  { key: 'externalDirectory', label: 'Outside Folder Access' },
  { key: 'subagents', label: 'Specialist Subagents' },
];

const FolderFriendAndGuardrailsSection: React.FC<{ project: ProjectEntry }> = ({ project }) => {
  const { files } = useRuntimeAPIs();
  const runtime = getRuntimeKey();
  const [profiles, setProfiles] = React.useState(() => {
    try { return typeof localStorage !== 'undefined' ? readFriendProfiles(localStorage, runtime) : null; }
    catch { return null; }
  });
  const key = folderFriendKey(project.path);
  const initialLook = folderFriendAppearance(profiles, project.path, project.color);
  const [friendName, setFriendName] = React.useState(() => folderFriendName(profiles, project));
  const [friendRole, setFriendRole] = React.useState(() => folderFriendRole(profiles, project));
  const [body, setBody] = React.useState(initialLook.body);
  const [color, setColor] = React.useState(initialLook.color);
  const [friendSaved, setFriendSaved] = React.useState(false);

  const [configSnap, setConfigSnap] = React.useState<ProjectRulesSnapshot | null>(null);
  const [rulesSnap, setRulesSnap] = React.useState<ProjectRulesSnapshot | null>(null);
  const [memorySnap, setMemorySnap] = React.useState<ProjectRulesSnapshot | null>(null);
  const [rulesDraft, setRulesDraft] = React.useState('');
  const [memoryDraft, setMemoryDraft] = React.useState('');
  const [guardrails, setGuardrails] = React.useState<FolderGuardrailState>(() =>
    summarizeFolderGuardrails(undefined, undefined, project.path),
  );
  const [savingGuardrails, setSavingGuardrails] = React.useState(false);
  const [savingRules, setSavingRules] = React.useState(false);
  const [savingMemory, setSavingMemory] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    if (!files.readProjectRules) return;
    void Promise.all([
      files.readProjectRules(project.path, 'configuration').catch(() => null),
      files.readProjectRules(project.path, 'instructions').catch(() => null),
      files.readProjectRules(project.path, 'memory').catch(() => null),
    ]).then(([cfg, ins, mem]) => {
      if (!alive) return;
      if (cfg) {
        setConfigSnap(cfg);
        const summary = summarizeFolderGuardrails(
          {
            ruleSources: [{
              policies: cfg.settings.policies.map(p => ({ action: 'provider.use', ...p })),
              permissions: cfg.settings.permissions ?? [],
            }],
          },
          undefined,
          project.path,
        );
        setGuardrails(summary);
      }
      if (ins) { setRulesSnap(ins); setRulesDraft(ins.content); }
      if (mem) { setMemorySnap(mem); setMemoryDraft(mem.content); }
    });
    return () => { alive = false; };
  }, [files, project.path]);

  const handleSaveFriendLook = () => {
    if (!profiles || !friendName.trim()) return;
    const next = saveFriendProfile(localStorage, runtime, key, {
      name: friendName.trim(),
      role: friendRole.trim() || undefined,
      body,
      color,
    }, profiles.revision);
    setProfiles(next);
    setFriendSaved(true);
    window.dispatchEvent(new Event('open-carter:friends-updated'));
  };

  const handleSaveGuardrails = async () => {
    if (!files.saveProjectRules || !configSnap || savingGuardrails) return;
    setSavingGuardrails(true);
    try {
      const built = buildGuardrailPoliciesAndPermissions(guardrails, configSnap.settings.permissions ?? []);
      const next = await files.saveProjectRules({
        directory: project.path,
        kind: 'configuration',
        expectedRevision: configSnap.revision,
        content: '',
        settings: {
          ...configSnap.settings,
          defaultAgent: guardrails.zdrLocked ? 'zdr' : (configSnap.settings.defaultAgent || 'operator'),
          model: guardrails.zdrLocked && !configSnap.settings.model.startsWith('openrouter-zdr/')
            ? 'openrouter-zdr/anthropic/claude-sonnet-5'
            : configSnap.settings.model,
          share: guardrails.zdrLocked ? 'disabled' : configSnap.settings.share,
          policies: built.policies,
          permissions: built.permissions,
        },
      });
      setConfigSnap(next);
      clearProviderBindingCache();
    } finally {
      setSavingGuardrails(false);
    }
  };

  const handleSaveMarkdown = async (kind: 'instructions' | 'memory') => {
    if (!files.saveProjectRules) return;
    const snap = kind === 'instructions' ? rulesSnap : memorySnap;
    const content = kind === 'instructions' ? rulesDraft : memoryDraft;
    if (!snap) return;
    if (kind === 'instructions') setSavingRules(true); else setSavingMemory(true);
    try {
      const next = await files.saveProjectRules({
        directory: project.path,
        kind,
        expectedRevision: snap.revision,
        content,
        settings: snap.settings,
      });
      if (kind === 'instructions') { setRulesSnap(next); setRulesDraft(next.content); }
      else { setMemorySnap(next); setMemoryDraft(next.content); }
    } finally {
      if (kind === 'instructions') setSavingRules(false); else setSavingMemory(false);
    }
  };

  return (
    <>
      <ProjectSettingsSubsection
        title="Folder Friend Identity & Avatar"
        info="Each folder is a Friend. Customize its face, name, and role across Home and the left sidebar."
      >
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <HomeFriendAvatar body={body} color={color} className="size-12 shrink-0" />
            <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={friendName}
                maxLength={32}
                placeholder="Friend name"
                onChange={e => { setFriendName(e.target.value); setFriendSaved(false); }}
                className="h-8 text-xs"
              />
              <Input
                value={friendRole}
                maxLength={80}
                placeholder="Role & specialty"
                onChange={e => { setFriendRole(e.target.value); setFriendSaved(false); }}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FRIEND_BODIES.map(b => (
              <Button
                key={b}
                type="button"
                variant="chip"
                size="icon"
                className="size-9"
                aria-pressed={body === b}
                onClick={() => { setBody(b); setFriendSaved(false); }}
              >
                <HomeFriendAvatar body={b} color={color} className="size-6" />
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {FRIEND_COLORS.map(c => (
                <Button
                  key={c}
                  type="button"
                  variant="chip"
                  size="icon"
                  className="size-7 rounded-full"
                  aria-pressed={color === c}
                  onClick={() => { setColor(c); setFriendSaved(false); }}
                >
                  <span className="size-4 rounded-full" style={{ background: friendColorVariable(c) }} />
                </Button>
              ))}
            </div>
            <Button type="button" size="xs" onClick={handleSaveFriendLook}>
              {friendSaved ? 'Saved Friend' : 'Save Friend Look'}
            </Button>
          </div>
        </div>
      </ProjectSettingsSubsection>

      <ProjectSettingsSubsection
        title="Folder Guardrails & Capabilities"
        info="Capabilities are built in and launched on demand when needed, bounded by these folder guardrails."
      >
        <div className="space-y-3 text-xs">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 p-2.5">
            <div>
              <div className="font-semibold text-foreground">Strict ZDR Endpoint Lock (openrouter-zdr)</div>
              <div className="text-[11px] text-muted-foreground">Blocks CarterBot, web tools, outside folders, and non-ZDR models.</div>
            </div>
            <Button
              type="button"
              size="xs"
              variant={guardrails.zdrLocked ? 'default' : 'outline'}
              onClick={() => setGuardrails(prev => prev.zdrLocked ? {
                ...prev,
                zdrLocked: false,
                allowedProviders: [],
                computerUse: 'ask',
                macControl: 'ask',
                browserControl: 'ask',
                webAccess: 'allow',
                externalDirectory: 'ask',
                subagents: 'allow',
              } : {
                ...prev,
                zdrLocked: true,
                allowedProviders: ['openrouter-zdr'],
                computerUse: 'deny',
                macControl: 'deny',
                browserControl: 'deny',
                webAccess: 'deny',
                externalDirectory: 'deny',
                subagents: 'deny',
              })}
            >
              {guardrails.zdrLocked ? 'Locked (ZDR)' : 'Enable ZDR Lock'}
            </Button>
          </div>
          <div className="divide-y divide-border/50 rounded-md border border-border/60 px-2.5">
            {GUARDRAIL_ITEMS.map(item => (
              <div key={item.key} className="flex items-center justify-between py-1.5">
                <span className="font-medium text-foreground">{item.label}</span>
                <div className="flex gap-1">
                  {(['allow', 'ask', 'deny'] as const).map((eff: FolderGuardrailEffect) => (
                    <Button
                      key={eff}
                      type="button"
                      size="xs"
                      variant={guardrails[item.key] === eff ? 'default' : 'ghost'}
                      disabled={guardrails.zdrLocked && item.key !== 'fileAndShell'}
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setGuardrails(prev => ({ ...prev, [item.key]: eff }))}
                    >
                      {eff === 'allow' ? 'Allow' : eff === 'ask' ? 'Ask' : 'Block'}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button type="button" size="xs" disabled={!configSnap || savingGuardrails} onClick={() => void handleSaveGuardrails()}>
              {savingGuardrails ? 'Saving…' : 'Save Guardrails'}
            </Button>
          </div>
        </div>
      </ProjectSettingsSubsection>

      <ProjectSettingsSubsection
        title="Folder Rules (AGENTS.md) & Shared Memory (MEMORY.md)"
        info="Shared across every conversation and sub-conversation in this folder."
      >
        <div className="space-y-3 text-xs">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">Rules &amp; Personality (AGENTS.md)</span>
              <Button type="button" size="xs" variant="outline" disabled={!rulesSnap || savingRules || rulesDraft === rulesSnap.content} onClick={() => void handleSaveMarkdown('instructions')}>
                {savingRules ? 'Saving…' : 'Save Rules'}
              </Button>
            </div>
            <Textarea
              value={rulesDraft}
              onChange={e => setRulesDraft(e.target.value)}
              placeholder="Folder instructions, citation rules, and persona..."
              className="min-h-24 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">Shared Friend Memory (MEMORY.md)</span>
              <Button type="button" size="xs" variant="outline" disabled={!memorySnap || savingMemory || memoryDraft === memorySnap.content} onClick={() => void handleSaveMarkdown('memory')}>
                {savingMemory ? 'Saving…' : 'Save Memory'}
              </Button>
            </div>
            <Textarea
              value={memoryDraft}
              onChange={e => setMemoryDraft(e.target.value)}
              placeholder="Durable memory and context shared by all chats in this folder..."
              className="min-h-24 font-mono text-xs"
            />
          </div>
        </div>
      </ProjectSettingsSubsection>
    </>
  );
};

export const ProjectSettingsPanel: React.FC<ProjectSettingsPanelProps> = ({
  project,
  onIdentitySave,
  showWorktrees = true,
}) => {
  const form = useProjectIdentityForm(project);

  const projectRef = React.useMemo(() => {
    if (!project) {
      return null;
    }
    return { id: project.id, path: project.path };
  }, [project]);

  const handleIdentitySave = React.useCallback(async (data: ProjectIdentitySaveData) => {
    await onIdentitySave(data);
  }, [onIdentitySave]);

  useProjectIdentityAutoSave(form, handleIdentitySave);

  if (!project || !projectRef) {
    return null;
  }

  return (
    <div className="space-y-0">
      <ProjectIdentityFields form={form} />
      <FolderFriendAndGuardrailsSection key={project.id} project={project} />
      <ProjectActionsSection projectRef={projectRef} />
      {showWorktrees ? <WorktreeSectionContent projectRef={projectRef} /> : null}
      <SharedProjectConfigSection projectRef={projectRef} />
    </div>
  );
};
