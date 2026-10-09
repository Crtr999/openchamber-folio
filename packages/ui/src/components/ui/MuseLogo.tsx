import museCharacter from '@/assets/muse-character.jpg';
import { cn } from '@/lib/utils';

/** Official Muse character; source recorded beside the bundled asset. */
export function MuseLogo({ className }: { className?: string }) {
  return <img src={museCharacter} alt="" aria-hidden="true" draggable={false} className={cn('shrink-0 rounded-full object-cover', className)} />;
}
