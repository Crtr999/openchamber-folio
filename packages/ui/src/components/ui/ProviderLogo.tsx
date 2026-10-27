import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';
import { getProviderLogoFallbackIcon, getProviderLogoInitials } from './providerLogoFallback';

// Full-color marks must not be inverted in dark themes.
const KEEP_COLOR_LOGOS = new Set(['gemini', 'gemini-cli', 'opencarter-gemini-website', 'gemini-website']);

interface ProviderLogoProps {
    providerId: string;
    alt?: string;
    className?: string;
    onError?: () => void;
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
    providerId,
    alt,
    className,
    onError: externalOnError
}) => {
    const { src, onError: handleInternalError, hasLogo } = useProviderLogo(providerId);
    const fallbackIcon = getProviderLogoFallbackIcon(providerId);

    const handleError = React.useCallback(() => {
        handleInternalError();
        externalOnError?.();
    }, [handleInternalError, externalOnError]);

    if (!hasLogo || !src) {
        return fallbackIcon ? <Icon name={fallbackIcon} className={cn('text-muted-foreground', className)} />
            : <span aria-label={alt || providerId} className={cn('inline-flex shrink-0 items-center justify-center text-[0.625rem] font-semibold leading-none', className)}>{getProviderLogoInitials(providerId)}</span>;
    }

    return (
        <img
            src={src}
            alt={alt || `${providerId} logo`}
            className={cn(!KEEP_COLOR_LOGOS.has(providerId) && 'dark:invert', 'object-contain', className)}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            draggable={false}
            onError={handleError}
        />
    );
};
