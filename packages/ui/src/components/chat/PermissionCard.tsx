import React from 'react';
import { formatPathForDisplay } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import type { PermissionRequest } from '@/types/permission';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";
import { DiffPreview, WritePreview } from './DiffPreview';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getVisiblePermissionPatterns } from './permissionCardPatterns';
import { permissionFilePreviewsSchema } from './permissionFilePreviews';
import { toolFileDiffs } from '@/lib/opencode/tools';
import { getPermissionToolPresentation, getToolDisplayName } from './permissionToolPresentation';
import { permissionSummaryMetadataSchema, summarizePermission, type PermissionTarget } from './permissionSummary';
import { usePermissionFromSubagent, usePermissionResponse } from './usePermissionResponse';
import { PermissionActions } from './PermissionActions';

const PERMISSION_BASH_CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0.5rem',
  fontSize: 'var(--text-meta)',
  lineHeight: '1.25rem',
  background: 'rgb(var(--muted) / 0.3)',
  borderRadius: '0.25rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
  overflow: 'visible',
};

const PERMISSION_BASH_CODE_TAG_PROPS = {
  style: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'break-word',
  } as React.CSSProperties,
};

const PERMISSION_JSON_CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0.5rem',
  fontSize: 'var(--text-meta)',
  lineHeight: '1.25rem',
  background: 'rgb(var(--muted) / 0.3)',
  borderRadius: '0.25rem',
};

interface PermissionCardProps {
  permission: PermissionRequest;
  onResponse?: (response: 'once' | 'always' | 'reject') => void;
}

const SAFETY_KIND_LABEL_KEYS = new Map<string, I18nKey>([
  ['read_only', 'routing.safetyKind.readOnly'],
  ['writes_project', 'routing.safetyKind.writesProject'],
  ['git_history', 'routing.safetyKind.gitHistory'],
  ['deletes_data', 'routing.safetyKind.deletesData'],
  ['system_change', 'routing.safetyKind.systemChange'],
  ['external_side_effect', 'routing.safetyKind.externalSideEffect'],
  ['data_exfiltration', 'routing.safetyKind.dataExfiltration'],
]);

const safetyKindLabelKey = (kind: string): I18nKey => SAFETY_KIND_LABEL_KEYS.get(kind) ?? 'routing.safetyKind.unknown';

/** The safety-net hold notice and what the request wants to do. */
export const PermissionRequestContent: React.FC<{ permission: PermissionRequest }> = ({ permission }) => {
  const { t } = useI18n();
  // Set while the routing safety net stopped auto-accept for this request.
  const held = useRoutingStore((state) => state.held[permission.id] ?? null);
  // v2 names the requested capability `action` (`shell`, `edit`, `webfetch`, ...).
  // A `write` asks for the `edit` action, so both land on the edit branch.
  const toolName = permission.action || 'unknown';
  const tool = toolName.toLowerCase();
  const isBashTool = tool === 'shell' || tool === 'bash' || tool === 'shell_command';

  const metadata = permission.metadata ?? {};
  const getMeta = (key: string, fallback: string = ''): string => {
    const val = metadata[key];
    return typeof val === 'string' ? val : (typeof val === 'number' ? String(val) : fallback);
  };
  const getMetaNum = (key: string): number | undefined => {
    const val = metadata[key];
    return typeof val === 'number' ? val : undefined;
  };
  const getMetaBool = (key: string): boolean => {
    const val = metadata[key];
    return Boolean(val);
  };
  const displayToolName = getToolDisplayName(toolName);
  // A v2 shell request carries no metadata: the commands it wants to run are
  // the requested resources.
  const bashCommand = isBashTool
    ? getMeta('command') || getMeta('cmd') || getMeta('script') || (permission.resources ?? []).join('\n')
    : '';
  const visiblePatterns = getVisiblePermissionPatterns(permission.resources, bashCommand);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const summary = summarizePermission(
    toolName,
    permission.resources ?? [],
    permissionSummaryMetadataSchema.parse(permission.metadata),
    Object.keys(metadata).length > 0,
  );
  const hasFilePreviews = (displayToolName === 'edit' || displayToolName === 'write')
    && permissionFilePreviewsSchema.parse(permission.metadata?.files).length > 0;
  // Shell commands and file diffs already name their subject below.
  const targets: PermissionTarget[] = isBashTool
    ? visiblePatterns.map((value) => ({ value, isPath: false }))
    : hasFilePreviews ? [] : summary.targets;
  const showTarget = (target: PermissionTarget): string => (target.isPath ? formatPathForDisplay(target.value, homeDirectory) : target.value);

  const renderToolContent = () => {

    if (displayToolName === 'edit' || displayToolName === 'write') {
      const files = permissionFilePreviewsSchema.parse(permission.metadata?.files);
      if (files.length > 0) {
        return (
          <ScrollableOverlay outerClassName="max-h-[60vh]" className="tool-output-surface p-1 rounded-xl border border-border/20 bg-transparent">
            {files.map((file, index) => (
              <DiffPreview key={`${file.file}:${index}`} diff={file.patch} filePath={file.file} />
            ))}
          </ScrollableOverlay>
        );
      }
    }

    if (isBashTool) {
      const description = getMeta('description');
      const workingDir = getMeta('cwd') || getMeta('working_directory') || getMeta('directory') || getMeta('path');
      const timeout = getMetaNum('timeout');
 
      return (
        <>
          {description && (
            <div className="typography-meta text-muted-foreground mb-2">{description}</div>
          )}
          {workingDir && (
            <div className="typography-meta text-muted-foreground mb-2">
              <span className="font-semibold">{t('chat.permissionCard.workingDirectory')}</span> <code className="px-1 py-0.5 bg-muted/30 rounded">{workingDir}</code>
            </div>
          )}
          {timeout && (
            <div className="typography-meta text-muted-foreground mb-2">
              <span className="font-semibold">{t('chat.permissionCard.timeout')}</span> {timeout}ms
            </div>
          )}
          {}
          {bashCommand && (
            <div>
              <WorkerHighlightedCode
                language="bash"
                code={bashCommand}
                style={PERMISSION_BASH_CUSTOM_STYLE}
                codeStyle={PERMISSION_BASH_CODE_TAG_PROPS.style}
                wrap
              />
            </div>
          )}
        </>
      );
    }

    if (tool === 'edit' || tool === 'patch' || tool === 'multiedit' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
      // v2 previews the change as `metadata.files: FileDiff.Info[]`.
      const previews = toolFileDiffs(metadata);
      const filePath = previews[0]?.file || getMeta('path') || getMeta('file_path') || getMeta('filename') || getMeta('filePath') || getMeta('filepath');
      const changes = previews[0]?.patch || getMeta('changes') || getMeta('diff');
      const replaceAll = getMetaBool('replace_all') || getMetaBool('replaceAll');

      return (
        <>
          {replaceAll && (
            <div className="typography-meta text-muted-foreground mb-2">
              <span className="font-semibold">{t('chat.permissionCard.replaceAll')}</span>
            </div>
          )}
          {changes && (
            <ScrollableOverlay outerClassName="max-h-[60vh]" className="tool-output-surface p-1 rounded-xl border border-border/20 bg-transparent">
              <DiffPreview diff={changes} filePath={filePath} />
            </ScrollableOverlay>
          )}
        </>
      );
    }

    if (tool === 'write' || tool === 'create' || tool === 'file_write') {
      const filePath = getMeta('path') || getMeta('file_path') || getMeta('filename') || getMeta('filePath') || getMeta('filepath');
      const content = getMeta('content') || getMeta('text') || getMeta('data');

      if (content) {
        return (
          <ScrollableOverlay outerClassName="max-h-[60vh]" className="tool-output-surface p-1 rounded-xl border border-border/20 bg-transparent">
            <WritePreview content={content} filePath={filePath} />
          </ScrollableOverlay>
        );
      }

      return null;
    }

    if (tool === 'webfetch' || tool === 'fetch' || tool === 'curl' || tool === 'wget') {
      const url = getMeta('url') || getMeta('uri') || getMeta('endpoint');
      const method = getMeta('method') || 'GET';
      const headers = metadata.headers && typeof metadata.headers === 'object' ? (metadata.headers as Record<string, unknown>) : undefined;
      const body = getMeta('body') || getMeta('data') || getMeta('payload');
      const timeout = getMetaNum('timeout');
      const format = getMeta('format') || getMeta('responseType');

      return (
        <>
          {url && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.request')}</div>
              <div className="flex items-center gap-2">
                <span className="typography-meta font-semibold px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                  {method}
                </span>
                <code className="typography-meta px-2 py-1 bg-muted/30 rounded flex-1 break-all">
                  {url}
                </code>
              </div>
            </div>
          )}
          {headers && Object.keys(headers).length > 0 && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.headers')}</div>
              <ScrollableOverlay outerClassName="max-h-24" className="p-0">
                <WorkerHighlightedCode
                  language="json"
                  code={JSON.stringify(headers, null, 2)}
                  style={PERMISSION_JSON_CUSTOM_STYLE}
                  wrap
                />
              </ScrollableOverlay>
            </div>
          )}
          {body && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.body')}</div>
              <ScrollableOverlay outerClassName="max-h-32" className="p-0">
                <WorkerHighlightedCode
                  language={typeof body === 'object' ? 'json' : 'text'}
                  code={typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body)}
                  style={PERMISSION_JSON_CUSTOM_STYLE}
                  wrap
                />
              </ScrollableOverlay>
            </div>
          )}
          {(timeout || format) && (
            <div className="typography-meta text-muted-foreground">
              {timeout && <span>Timeout: {timeout}ms</span>}
              {timeout && format && <span> • </span>}
              {format && <span>Response format: {format}</span>}
            </div>
          )}
        </>
      );
    }

    const genericContent = getMeta('command') || getMeta('content') || getMeta('action') || getMeta('operation');
    const description = getMeta('description');

    return (
      <>
        {description && (
          <div className="typography-meta text-muted-foreground mb-2">{description}</div>
        )}
        {genericContent && (
          <div className="mb-2">
            <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.action')}</div>
            <ScrollableOverlay outerClassName="max-h-32" className="p-0">
              <pre className="typography-meta font-mono px-2 py-1 bg-muted/30 rounded whitespace-pre-wrap break-all">
                {String(genericContent)}
              </pre>
            </ScrollableOverlay>
          </div>
        )}
        {}
      </>
    );
  };

  return (
    <>
      {held ? (
        <div className="flex items-start gap-2 px-2 py-1.5 border-b border-border/20 typography-meta text-[var(--status-warning)]">
          <Icon name="shield-keyhole" className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>
            {t('chat.permissionCard.heldBySafetyNet')}
            {held.kind ? ` · ${t(safetyKindLabelKey(held.kind))}` : ''}
          </span>
        </div>
      ) : null}

      <div className="px-2 py-2">
        {/* v2 lets the agent explain in its own words why it needs this. */}
        {permission.message ? (
          <div className="typography-meta text-foreground/80 mb-2 whitespace-pre-wrap break-words">
            {permission.message}
          </div>
        ) : null}

        <div className="mb-2">
          <div className="typography-meta font-medium text-foreground">
            {summary.tool ? t(summary.titleKey, { tool: summary.tool }) : t(summary.titleKey)}
            {summary.scope ? (
              <span className="font-normal text-muted-foreground"> {t('chat.permissionCard.summary.inPath', { path: formatPathForDisplay(summary.scope, homeDirectory) })}</span>
            ) : null}
          </div>
          {targets.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {targets.map((target, index) => (
                <li key={`${index}:${target.value}`} className="typography-meta font-mono break-all">
                  {target.file ? (
                    <>
                      <span className="text-muted-foreground">{showTarget(target)}/</span>
                      <span className="text-foreground">{target.file}</span>
                    </>
                  ) : (
                    <span className="text-foreground">{showTarget(target)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {renderToolContent()}
        <details className="mt-2">
          <summary className="typography-meta cursor-pointer text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            {t('chat.permissionCard.showDetails')}
          </summary>
          <pre dir="ltr" className="typography-meta mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 font-mono">
            {JSON.stringify(permission, null, 2)}
          </pre>
        </details>
      </div>
    </>
  );
};

/** The inline card the BTW sheet shows for its child session's requests. */
export const PermissionCard: React.FC<PermissionCardProps> = ({ permission, onResponse }) => {
  const { t } = useI18n();
  const { isResponding, hasResponded, hasError, respond } = usePermissionResponse(permission, onResponse);
  const isFromSubagent = usePermissionFromSubagent(permission);
  const tool = getPermissionToolPresentation(permission);

  if (hasResponded) {
    return null;
  }

  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <section aria-label={t('chat.permissionCard.title')} className="-mt-1 border border-border/30 rounded-xl bg-surface-elevated">
          <div className="px-2 py-1.5 border-b border-border/20 bg-muted/5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon name="question" className="h-3.5 w-3.5 text-[var(--status-warning)]" />
                <span className="typography-meta font-medium text-muted-foreground">
                  {t('chat.permissionCard.title')}
                </span>
                {isFromSubagent ? (
                  <span className="typography-micro text-muted-foreground px-1.5 py-0.5 rounded bg-foreground/5">
                    {t('chat.questionCard.fromSubagent')}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                {tool.icon}
                <span className="typography-meta text-muted-foreground font-medium">{tool.name}</span>
              </div>
            </div>
          </div>

          <PermissionRequestContent permission={permission} />

          <PermissionActions permission={permission} isResponding={isResponding} hasError={hasError} onRespond={(response) => void respond(response)} variant="inline" />
        </section>
      </div>
    </div>
  );
};
