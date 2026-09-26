import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { emojiGroups } from '@/lib/folio/emoji';
import { iconPrefix, noteIconGroupOrder, noteIcons } from '@/lib/folio/icons';

type Tab = 'emoji' | 'icons' | 'upload';
const tabs: readonly Tab[] = ['emoji', 'icons', 'upload'];
const maxUploadBytes = 5 * 1024 * 1024;

/** Downscales an uploaded picture to a small square so it stays cheap to store with the page. */
async function toIconDataURL(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.85);
}

/** Notion-style icon picker: Emoji, grey Icons, or an uploaded image, plus Remove. */
export function FolioIconPicker({ onPick, onRemove, onClose }: { onPick: (value: string) => void; onRemove: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = React.useState<Tab>('emoji');
  const [filter, setFilter] = React.useState('');
  const [uploadError, setUploadError] = React.useState('');
  const fileRef = React.useRef<HTMLInputElement>(null);
  const q = filter.trim().toLowerCase();

  const emoji = React.useMemo(() => emojiGroups
    .map(({ group, entries }) => ({ group, entries: q ? entries.filter((e) => e.keywords.includes(q)) : entries }))
    .filter(({ entries }) => entries.length), [q]);
  const icons = React.useMemo(() => noteIconGroupOrder
    .map((group) => ({ group, names: noteIcons.filter((option) => option.group === group && (!q || option.icon.replace(/-/g, ' ').includes(q))).map((option) => option.icon) }))
    .filter(({ names }) => names.length), [q]);

  const upload = async (file: File | undefined) => {
    setUploadError('');
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > maxUploadBytes) { setUploadError(t('folio.uploadInvalid')); return; }
    try { onPick(await toIconDataURL(file)); } catch { setUploadError(t('folio.uploadInvalid')); }
  };

  return <>
    <div className="fixed inset-0 z-30" onClick={onClose} />
    <div role="dialog" aria-label={t('folio.icon')} className="absolute left-0 top-16 z-40 flex w-[min(408px,calc(100vw-2rem))] flex-col rounded-xl border border-border bg-background shadow-2xl"
      onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
      <div className="flex items-center gap-1 border-b border-border px-2 pt-1.5">
        {tabs.map((name) => <button key={name} type="button" onClick={() => setTab(name)}
          className={cn('-mb-px border-b-2 px-2 pb-1.5 pt-1 text-sm', tab === name ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          {t(name === 'emoji' ? 'folio.iconEmoji' : name === 'icons' ? 'folio.iconIcons' : 'folio.iconUpload')}
        </button>)}
        <button type="button" className="ml-auto rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-interactive-hover hover:text-foreground" onClick={onRemove}>{t('folio.remove')}</button>
      </div>
      {tab !== 'upload' && <div className="px-2 pt-2">
        <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background/40 px-2 text-sm">
          <Icon name="search" className="size-3.5 shrink-0 text-muted-foreground" />
          <input autoFocus className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" placeholder={t('folio.iconFilter')} aria-label={t('folio.iconFilter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>}
      <div className="max-h-80 overflow-y-auto p-2">
        {tab === 'emoji' && (emoji.length ? emoji.map(({ group, entries }) => <section key={group} className="mb-2">
          <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">{t(`folio.emojiGroup.${group}`)}</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(2rem,1fr))] gap-0.5">{entries.map((entry) => <button key={entry.emoji} type="button" title={entry.keywords} aria-label={entry.keywords}
            className="flex size-8 items-center justify-center rounded-md text-[22px] leading-none hover:bg-interactive-hover" onClick={() => onPick(entry.emoji)}>{entry.emoji}</button>)}</div>
        </section>) : <div className="p-2 text-sm text-muted-foreground">{t('folio.noMatches')}</div>)}
        {tab === 'icons' && (icons.length ? icons.map(({ group, names }) => <section key={group} className="mb-2">
          <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">{t(`folio.iconGroup.${group}`)}</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(2rem,1fr))] gap-0.5">{names.map((name) => <button key={name} type="button" title={name.replace(/-/g, ' ')} aria-label={name.replace(/-/g, ' ')}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground" onClick={() => onPick(iconPrefix + name)}><Icon name={name} className="size-5" /></button>)}</div>
        </section>) : <div className="p-2 text-sm text-muted-foreground">{t('folio.noMatches')}</div>)}
        {tab === 'upload' && <div className="flex flex-col items-center gap-2 py-4"
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files[0]); }}>
          <button type="button" className="w-full rounded-md border border-border px-3 py-2 text-sm hover:bg-interactive-hover" onClick={() => fileRef.current?.click()}>{t('folio.uploadImage')}</button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
          <p className="text-xs text-muted-foreground">{t('folio.uploadHint')}</p>
          {uploadError && <p role="alert" className="text-xs text-[var(--status-error)]">{uploadError}</p>}
        </div>}
      </div>
    </div>
  </>;
}
