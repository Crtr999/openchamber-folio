import React from 'react';

import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';

/**
 * Read-only Word (.docx) preview. The bytes come from the same scoped raw-file
 * URL the PDF and media viewers use, and docx-preview lays the document out as
 * pages. Nothing is ever written back, so the file cannot be corrupted here.
 */
export const DocxArtifact: React.FC<{
  src: string;
  name: string;
  sizeBytes: number | null;
  download?: React.ReactNode;
}> = ({ src, name, sizeBytes, download }) => {
  const { t } = useI18n();
  const pagesRef = React.useRef<HTMLDivElement | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');

  React.useEffect(() => {
    const host = pagesRef.current;
    if (!src || !host) return;
    let cancelled = false;
    const controller = new AbortController();
    setState('loading');
    host.replaceChildren();
    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const { renderAsync } = await import('docx-preview');
        if (cancelled) return;
        await renderAsync(bytes, host, host, {
          className: 'oc-docx',
          inWrapper: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          useBase64URL: true,
        });
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [src]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={['DOCX', formatArtifactSize(sizeBytes)]} />
      <div className="oc-docx-scroll relative min-h-0 flex-1 overflow-auto bg-[var(--surface-background)] px-4 py-6">
        {state === 'loading' ? (
          <div className="absolute inset-x-0 top-10 mx-auto w-[min(640px,90%)] space-y-3" aria-busy="true">
            {[92, 80, 88, 70, 95, 60].map((width, index) => <div key={index} className="oc-shimmer h-3 rounded" style={{ width: `${width}%` }} />)}
          </div>
        ) : null}
        {state === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="typography-ui-header text-foreground">{name}</div>
            <div className="max-w-md typography-ui text-muted-foreground">{t('filesView.artifact.docx.error')}</div>
            {download}
          </div>
        ) : null}
        <div ref={pagesRef} aria-label={name} className={state === 'error' ? 'hidden' : 'oc-docx-pages'} />
      </div>
    </div>
  );
};
