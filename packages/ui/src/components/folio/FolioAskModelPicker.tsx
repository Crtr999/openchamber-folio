import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ModelPickerList, type ModelPickerEntry } from '@/components/model-picker/ModelPickerList';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useModelLists } from '@/hooks/useModelLists';
import { useI18n } from '@/lib/i18n';
import { askModelLabel, askVariantIds, nextAskVariant, resolveAskModel } from '@/lib/folio/ask-model';
import { useFolioAskModelStore } from '@/lib/folio/ask';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

/**
 * The model a page's Ask AI answers with.
 *
 * This is the composer control the main chat uses, sharing its picker, its
 * favourites, its recent list and its thinking-level keys, so the two surfaces
 * cannot drift apart. It reads and writes the panel's own store rather than the
 * config store, so picking here does not move the chat next to it.
 */
export function FolioAskModelPicker() {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const currentVariant = useConfigStore((state) => state.currentVariant);
  const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
  const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const selection = useFolioAskModelStore((state) => state.selection);
  const setModel = useFolioAskModelStore((state) => state.setModel);
  const { favoriteModelsList, recentModelsList } = useModelLists();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  // What the trigger shows is what the send will use, not only what has been
  // picked here, so the label and the request can never disagree.
  const model = resolveAskModel(selection, { providerID: currentProviderId, modelID: currentModelId, variant: currentVariant });
  const variants = askVariantIds(providers, model);
  const label = askModelLabel(providers, model);

  React.useEffect(() => { if (!open) setQuery(''); }, [open]);

  const level = model?.variant
    ? model.variant.charAt(0).toUpperCase() + model.variant.slice(1)
    : t('folio.askVariantNone');

  const choose = (entry: ModelPickerEntry) => {
    setModel(entry.providerID, entry.modelID, model?.variant);
    setOpen(false);
  };

  return <div className="flex min-w-0 items-center gap-0.5">
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-h-9 min-w-0 max-w-[190px] items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          aria-label={t('folio.askModel')}
          title={label || t('folio.askNoModel')}
        >
          <Icon name="pencil-ai" className={cn('size-3.5 shrink-0', !model && 'text-muted-foreground')} />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{label || t('folio.askNoModel')}</span>
          <Icon name="arrow-down-s" className="size-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="flex w-[min(320px,calc(100vw-2rem))] flex-col overflow-hidden p-0"
        constrainToMain
        collisionAvoidance={{ side: 'none', align: 'shift' }}
      >
        <ModelPickerList
          providers={providers}
          favoriteModels={favoriteModelsList}
          recentModels={recentModelsList}
          searchQuery={query}
          onSearchQueryChange={setQuery}
          onSelect={choose}
          labels={{
            searchPlaceholder: t('chat.modelControls.searchModels'),
            noResults: t('chat.modelControls.noModelsFound'),
            favorites: t('chat.modelControls.favorites'),
            recent: t('chat.modelControls.recent'),
            keyboardHint: t('chat.modelControls.keyboardHintNavigate'),
            favorite: t('chat.modelControls.favoriteAria'),
            unfavorite: t('chat.modelControls.unfavoriteAria'),
            capabilities: t('chat.modelControls.capabilities'),
            capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
            capabilityReasoning: t('chat.modelControls.capability.reasoning'),
            input: t('chat.modelControls.input'),
            output: t('chat.modelControls.output'),
            costPerMillion: t('chat.modelControls.costPerMillion'),
          }}
          selectedModel={model ? { providerID: model.providerID, modelID: model.modelID } : null}
          hiddenModels={hiddenModels}
          onVariantKey={(event, entry) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false;
            const levels = askVariantIds(providers, { providerID: entry.providerID, modelID: entry.modelID });
            if (!levels.length) return false;
            event.preventDefault();
            event.stopPropagation();
            const isSelected = entry.providerID === model?.providerID && entry.modelID === model?.modelID;
            const level = nextAskVariant(levels, isSelected ? model.variant : undefined, event.key === 'ArrowRight' ? 1 : -1);
            setModel(entry.providerID, entry.modelID, level);
            return true;
          }}
          isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
          onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
          onEscape={() => setOpen(false)}
          maxHeightClassName="max-h-[min(320px,calc(100dvh-14rem))] flex-1"
        />
      </DropdownMenuContent>
    </DropdownMenu>
    {variants.length > 0 && <button
      type="button"
      className="flex min-h-9 shrink-0 items-center rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
      aria-label={t('folio.askThinkingLevel', { level })}
      title={t('folio.askThinkingLevel', { level })}
      onClick={() => model && setModel(model.providerID, model.modelID, nextAskVariant(variants, model.variant, 1))}
    >
      {level}
    </button>}
  </div>;
}
