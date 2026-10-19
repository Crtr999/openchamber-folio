import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { extractDocumentAttachments } from '@/sync/document-attachments';
import { ArtifactMetaBar } from './ArtifactMetaBar';

/** Bounded text/image preview, never a claim to reproduce the Office layout. */
export function OfficeTextArtifact({ src, name, download }: { src: string; name: string; download?: React.ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = React.useState<{ kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; text: string; images: { name: string; url: string }[] }>({ kind: 'loading' });
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => {
    let active = true; const urls: string[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    setState({ kind: 'loading' });
    void (async () => {
      try {
        // src is minted by FilesView's authenticated asset resolver.
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok || Number(response.headers.get('content-length')) > 20 * 1024 * 1024) throw new Error('office_read_failed');
        const blob = await response.blob();
        if (blob.size > 20 * 1024 * 1024) throw new Error('office_too_large');
        const extracted = await extractDocumentAttachments(new File([blob], name));
        if (!extracted) throw new Error('office_empty');
        const text = await extracted.textFile.text();
        if (!active || controller.signal.aborted) return;
        const images = extracted.images.map((image) => { const url = URL.createObjectURL(image); urls.push(url); return { name: image.name, url }; });
        setState({ kind: 'ready', text, images });
      } catch { if (active) setState({ kind: 'error' }); }
      finally { clearTimeout(timer); }
    })();
    return () => { active = false; clearTimeout(timer); controller.abort(); urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [src, name, attempt]);
  return <div className="flex h-full min-h-0 flex-col">
    <ArtifactMetaBar items={[name]} />
    <p className="border-b px-4 py-2 typography-meta text-muted-foreground">{t('workspace.officePreview')}</p>
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {state.kind === 'loading' && <p role="status">{t('workspace.loading')}</p>}
      {state.kind === 'error' && <div role="alert" className="space-y-3"><p>{t('workspace.error')}</p><Button variant="outline" onClick={retry}>{t('filesView.tree.actions.refreshTitle')}</Button>{download}</div>}
      {state.kind === 'ready' && <><pre className="whitespace-pre-wrap break-words font-mono typography-meta">{state.text}</pre><div className="mt-6 space-y-4">{state.images.map((image) => <figure key={image.name}><img src={image.url} alt={image.name} className="max-w-full rounded-md border" /><figcaption className="mt-1 typography-meta text-muted-foreground">{image.name}</figcaption></figure>)}</div></>}
    </div>
  </div>;
}
