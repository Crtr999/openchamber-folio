import React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProjectSettingsPanel } from '@/components/sections/projects/ProjectSettingsPanel';
import type { ProjectIdentitySaveData } from '@/components/sections/projects/useProjectIdentityForm';
import type { ProjectEntry } from '@/lib/api/types';
import { ZdrPinSettings } from './ZdrPinSettings';
import { useZdrLockStore } from '@/stores/useZdrLockStore';
import { isPathGuarded } from '@/lib/zdrLock';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';

interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectEntry | null;
  onSave: (data: ProjectIdentitySaveData) => void | Promise<void>;
}

export const ProjectEditDialog: React.FC<ProjectEditDialogProps> = ({
  open,
  onOpenChange,
  project,
  onSave,
}) => {
  const { t } = useI18n();
  const privateDirectories = useZdrLockStore(state => state.directories);
  const guarded = !isVSCodeRuntime() && isPathGuarded(privateDirectories, project?.path);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-2xl gap-0 overflow-hidden p-0">
        <ScrollableOverlay outerClassName="max-h-[min(90vh,48rem)]" className="w-full bg-transparent">
          <div className="w-full p-3 sm:p-6 sm:pt-8">
            {open && project ? (
              <>
                {guarded && <SettingsSection title={t('zdr.settings')} divider={false}><ZdrPinSettings /></SettingsSection>}
                <ProjectSettingsPanel project={project} onIdentitySave={onSave} showWorktrees={false} />
              </>
            ) : null}
          </div>
        </ScrollableOverlay>
      </DialogContent>
    </Dialog>
  );
};
