import { cn } from '@/lib/utils';

const claudeSymbol = new URL('../../assets/provider-logos/claude-code.svg', import.meta.url).href;

/** Existing Claude symbol, inheriting the surrounding navigation's theme color. */
export function ClaudeLogo({ className }: { className?: string }) {
  return <span
    aria-hidden="true"
    className={cn('inline-block shrink-0 bg-current', className)}
    style={{
      maskImage: `url("${claudeSymbol}")`,
      WebkitMaskImage: `url("${claudeSymbol}")`,
      maskSize: 'contain',
      maskRepeat: 'no-repeat',
      maskPosition: 'center',
    }}
  />;
}
