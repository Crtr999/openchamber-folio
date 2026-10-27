import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { WorkingStepBatch, WorkingStepRecord } from '../lib/turns/types';
import { formatWorkedDuration } from '../lib/turns/workingStepBatches';
import { FadeInOnReveal } from '../message/FadeInOnReveal';
import ReasoningPart from '../message/parts/ReasoningPart';
import { StaticToolRow } from '../message/parts/ProgressiveGroup';
import ToolPart from '../message/parts/ToolPart';
import { ToolRevealOnMount } from '../message/parts/ToolRevealOnMount';
import { hasToolInputDetails, isExpandableTool } from '../message/parts/toolRenderUtils';
import type { ToolPopupContent } from '../message/types';
import { LiveActivityCollapse } from './LiveActivityCollapse';

const STEP_PILL_TITLE_CLASS = 'typography-meta !text-[length:var(--text-meta)] !leading-5 sm:!leading-6 font-medium tracking-normal';
const MIN_STEP_DWELL_MS = 220;
const PENDING_INPUT_HOLD_MS = 320;

interface WorkingStepGroupProps {
    batch: WorkingStepBatch;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    animatedToolIds: Set<string>;
}

export const WorkingStepGroup: React.FC<WorkingStepGroupProps> = React.memo(({
    batch,
    isMobile,
    alwaysShowActions,
    expandedTools,
    onToggleTool,
    onShowPopup,
    animatedToolIds,
}) => {
    const { t } = useI18n();
    const contentId = React.useId();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const [localExpandedTools, setLocalExpandedTools] = React.useState<Set<string>>(() => new Set());

    // Pace step transitions while streaming so bursts of parallel/fast tool calls
    // visibly step through 1 -> 2 -> ... -> N instead of jumping straight to N.
    const [displayedIndex, setDisplayedIndex] = React.useState<number>(0);
    const lastStepShownAtRef = React.useRef<number>(Date.now());
    const previousBatchIdRef = React.useRef<string>(batch.id);

    if (previousBatchIdRef.current !== batch.id) {
        previousBatchIdRef.current = batch.id;
        lastStepShownAtRef.current = Date.now();
    }

    const safeDisplayedIndex = batch.steps.length === 0
        ? 0
        : Math.min(displayedIndex, batch.steps.length - 1);

    React.useEffect(() => {
        if (batch.settled || batch.steps.length === 0) {
            return;
        }
        const targetIndex = batch.steps.length - 1;
        if (safeDisplayedIndex >= targetIndex) {
            return;
        }

        const currentStep = batch.steps[safeDisplayedIndex];
        const nextStep = batch.steps[safeDisplayedIndex + 1];
        if (!currentStep || !nextStep) {
            return;
        }

        const now = Date.now();
        const elapsed = Math.max(0, now - lastStepShownAtRef.current);

        // If the next step is the trailing pending tool and its streamed input
        // arguments haven't arrived yet while the current step already has details,
        // hold briefly so we don't replace a named file/command with a blank row.
        const nextIsTrailingBlankPendingTool =
            safeDisplayedIndex + 1 === targetIndex
            && nextStep.kind === 'tool'
            && !hasToolInputDetails(nextStep.part)
            && (currentStep.kind === 'reasoning' || hasToolInputDetails(currentStep.part));

        const requiredDwellMs = nextIsTrailingBlankPendingTool
            ? PENDING_INPUT_HOLD_MS
            : MIN_STEP_DWELL_MS;
        const remainingMs = Math.max(16, requiredDwellMs - elapsed);

        const timer = window.setTimeout(() => {
            lastStepShownAtRef.current = Date.now();
            setDisplayedIndex((prev) => Math.min(batch.steps.length - 1, prev + 1));
        }, remainingMs);

        return () => {
            window.clearTimeout(timer);
        };
    }, [batch.settled, batch.steps, safeDisplayedIndex]);

    // Track live wall-clock duration while the batch streams as a fallback when
    // provider parts do not carry explicit start/end timestamps.
    const liveStartedAtRef = React.useRef<number | null>(batch.settled ? null : Date.now());
    const [liveElapsedSeconds, setLiveElapsedSeconds] = React.useState<number | undefined>(undefined);

    React.useEffect(() => {
        if (!batch.settled) {
            if (liveStartedAtRef.current === null) {
                liveStartedAtRef.current = Date.now();
            }
            return;
        }
        if (liveStartedAtRef.current !== null && batch.durationSeconds === undefined) {
            const elapsed = Math.max(1, Math.round((Date.now() - liveStartedAtRef.current) / 1000));
            setLiveElapsedSeconds(elapsed);
        }
    }, [batch.settled, batch.durationSeconds]);

    const handleToggleStepTool = React.useCallback((toolId: string) => {
        onToggleTool(toolId);
        setLocalExpandedTools((prev) => {
            const next = new Set(prev);
            if (next.has(toolId)) {
                next.delete(toolId);
            } else {
                next.add(toolId);
            }
            return next;
        });
    }, [onToggleTool]);

    const isStepToolExpanded = React.useCallback((toolId: string): boolean => {
        return expandedTools.has(toolId) || localExpandedTools.has(toolId);
    }, [expandedTools, localExpandedTools]);

    const renderStepItem = React.useCallback((step: WorkingStepRecord, isLiveActiveStep = false) => {
        if (step.kind === 'reasoning') {
            return (
                <ReasoningPart
                    key={step.key}
                    part={step.part}
                    messageId={step.messageId}
                    streamPhase={step.isStreaming || isLiveActiveStep ? 'streaming' : 'completed'}
                />
            );
        }

        if (step.part.type !== 'tool') {
            return null;
        }

        const toolPart = step.part;
        const toolName = toolPart.tool?.toLowerCase() ?? '';
        const toolId = toolPart.id || step.id;
        const animateTailText = isLiveActiveStep || animatedToolIds.has(toolId);

        if (isExpandableTool(toolName)) {
            return (
                <FadeInOnReveal
                    key={step.key}
                    forceAnimation={isLiveActiveStep}
                    ignoreContextDisabled={isLiveActiveStep}
                >
                    <ToolRevealOnMount animate={animateTailText} wipe>
                        <ToolPart
                            part={toolPart}
                            isExpanded={isStepToolExpanded(toolId)}
                            onToggle={handleToggleStepTool}
                            isMobile={isMobile}
                            alwaysShowActions={alwaysShowActions}
                            onShowPopup={onShowPopup}
                            animateTailText={animateTailText}
                            forceActive={isLiveActiveStep}
                        />
                    </ToolRevealOnMount>
                </FadeInOnReveal>
            );
        }

        return (
            <FadeInOnReveal
                key={step.key}
                forceAnimation={isLiveActiveStep}
                ignoreContextDisabled={isLiveActiveStep}
            >
                <ToolRevealOnMount animate={animateTailText} wipe>
                    <StaticToolRow
                        toolName={toolName}
                        activities={[
                            {
                                id: toolId,
                                turnId: '',
                                messageId: step.messageId,
                                partIndex: step.partIndex,
                                part: toolPart,
                                kind: 'tool' as const,
                            },
                        ]}
                        animateTailText={animateTailText}
                        forceActive={isLiveActiveStep}
                    />
                </ToolRevealOnMount>
            </FadeInOnReveal>
        );
    }, [alwaysShowActions, animatedToolIds, handleToggleStepTool, isMobile, isStepToolExpanded, onShowPopup]);

    const handleToggleGroup = React.useCallback(() => {
        setIsExpanded((prev) => !prev);
    }, []);

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleToggleGroup();
        }
    }, [handleToggleGroup]);

    if (batch.steps.length === 0) {
        return null;
    }

    // While actively working on this batch, render the paced active step
    // (e.g. `Thinking... >` + scrolling box, or the active tool pill with step progress).
    // Earlier completed steps in the batch fold away automatically.
    if (!batch.settled) {
        const activeStep = batch.steps[safeDisplayedIndex] ?? batch.steps[batch.steps.length - 1];
        const showStepProgress = batch.steps.length > 1 && activeStep.kind === 'tool';
        return (
            <div
                data-working-step-group={batch.id}
                data-working-state="active"
                className={cn('my-1', showStepProgress && 'flex items-center gap-2 min-w-0')}
            >
                <div className="min-w-0">
                    {renderStepItem(activeStep, true)}
                </div>
                {showStepProgress ? (
                    <span
                        className="flex-shrink-0 typography-meta !text-[length:var(--text-meta)] tabular-nums opacity-65 select-none"
                        style={{ color: 'var(--tools-description)' }}
                    >
                        {safeDisplayedIndex + 1}/{batch.steps.length}
                    </span>
                ) : null}
            </div>
        );
    }

    const stepCount = batch.steps.length;
    const effectiveDurationSeconds = batch.durationSeconds ?? liveElapsedSeconds;
    const label = effectiveDurationSeconds !== undefined && effectiveDurationSeconds > 0
        ? t(
            stepCount === 1 ? 'chat.workingSteps.workedStep' : 'chat.workingSteps.workedSteps',
            { duration: formatWorkedDuration(effectiveDurationSeconds), count: stepCount },
        )
        : t(
            stepCount === 1 ? 'chat.workingSteps.stepSingle' : 'chat.workingSteps.stepPlural',
            { count: stepCount },
        );

    const toggleAriaLabel = isExpanded
        ? t('chat.workingSteps.collapseAria')
        : t('chat.workingSteps.expandAria');

    return (
        <div data-working-step-group={batch.id} data-working-state="settled" className="my-1.5">
            <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={contentId}
                aria-label={toggleAriaLabel}
                onClick={handleToggleGroup}
                onKeyDown={handleKeyDown}
                className={cn(
                    'oc-worked-pill group/tool inline-flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1 cursor-pointer',
                )}
            >
                <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center" style={{ color: 'var(--tools-icon)' }}>
                    <Icon name="list-unordered" className="h-3.5 w-3.5" />
                </span>
                <span className={cn('truncate tabular-nums', STEP_PILL_TITLE_CLASS)} style={{ color: 'var(--tools-title)' }}>
                    {label}
                </span>
                <span
                    aria-hidden="true"
                    className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center"
                    style={{ color: 'var(--tools-icon)' }}
                >
                    {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
                </span>
            </div>

            <LiveActivityCollapse expanded={isExpanded} id={contentId}>
                <div className="oc-worked-steps-drawer relative mt-1.5 mb-2 ml-2 pl-3 space-y-1 border-l border-[var(--oc-hairline,var(--tools-border))]">
                    {batch.steps.map((step) => renderStepItem(step, false))}
                </div>
            </LiveActivityCollapse>
        </div>
    );
});

WorkingStepGroup.displayName = 'WorkingStepGroup';
