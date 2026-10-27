import type { Part, ToolPart as ToolPartType } from '@/lib/opencode/model';
import { filterVisibleParts, isEmptyTextPart, normalizeParts } from '../../message/partUtils';
import { isStandaloneTool } from '../../message/parts/toolRenderUtils';
import type { WorkingStepBatch, WorkingStepRecord } from './types';

export interface WorkingBatchMessageInput {
    info: {
        id: string;
        time?: {
            created?: number;
            completed?: number;
        };
    };
    parts: Part[];
}

export const formatWorkedDuration = (seconds: number): string => {
    const safeSeconds = Math.max(1, Math.round(seconds));
    if (safeSeconds < 60) {
        return `${safeSeconds}s`;
    }
    if (safeSeconds < 3600) {
        const mins = Math.floor(safeSeconds / 60);
        const secs = safeSeconds % 60;
        return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    }
    const hours = Math.floor(safeSeconds / 3600);
    const mins = Math.floor((safeSeconds % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
};

export const getMessagePartKey = (messageId: string, part: Part, partIndex: number): string => {
    const partId = part.id && part.id.length > 0
        ? part.id
        : `part-${partIndex}-${part.type}`;
    return `${messageId}:${partId}`;
};

const isToolActive = (toolPart: ToolPartType): boolean => {
    const status = toolPart.state?.status;
    return status === 'pending' || status === 'running';
};

const isToolFinalized = (toolPart: ToolPartType): boolean => {
    const state = toolPart.state;
    if (!state || state.status === 'pending' || state.status === 'running') {
        return false;
    }
    const endTime = state.time?.end;
    const startTime = state.time?.start;
    if (endTime === undefined) {
        return false;
    }
    if (startTime !== undefined && endTime < startTime) {
        return false;
    }
    return true;
};

const shouldIncludeToolPart = (toolPart: ToolPartType): boolean => {
    return isToolActive(toolPart) || isToolFinalized(toolPart);
};

const computeBatchDurationSeconds = (
    steps: readonly WorkingStepRecord[],
    messageById: ReadonlyMap<string, WorkingBatchMessageInput>,
    fallbackStartAt?: number,
): number | undefined => {
    if (steps.length === 0) return undefined;

    let minStart: number | undefined;
    let maxEnd: number | undefined;

    for (const step of steps) {
        if (step.startedAt !== undefined && step.startedAt > 0) {
            minStart = minStart !== undefined ? Math.min(minStart, step.startedAt) : step.startedAt;
        }
        if (step.endedAt !== undefined && step.endedAt > 0) {
            maxEnd = maxEnd !== undefined ? Math.max(maxEnd, step.endedAt) : step.endedAt;
        }
    }

    if (minStart === undefined) {
        const firstMsg = messageById.get(steps[0].messageId);
        const created = firstMsg?.info.time?.created;
        minStart = (created !== undefined && created > 0 ? created : undefined) ?? fallbackStartAt;
    }

    if (maxEnd === undefined) {
        const lastMsg = messageById.get(steps[steps.length - 1].messageId);
        const completed = lastMsg?.info.time?.completed;
        maxEnd = completed !== undefined && completed > 0 ? completed : undefined;
    }

    if (minStart !== undefined && maxEnd !== undefined && maxEnd >= minStart) {
        return Math.max(1, Math.round((maxEnd - minStart) / 1000));
    }

    return undefined;
};

export interface ProjectWorkingStepBatchesInput {
    assistantMessages: readonly WorkingBatchMessageInput[];
    showReasoningTraces: boolean;
    isTurnWorking: boolean;
    streamingMessageId?: string | null;
    turnStartedAt?: number;
}

export const projectWorkingStepBatches = (
    input: ProjectWorkingStepBatchesInput,
): WorkingStepBatch[] => {
    const {
        assistantMessages,
        showReasoningTraces,
        isTurnWorking,
        streamingMessageId,
        turnStartedAt,
    } = input;

    if (assistantMessages.length === 0) {
        return [];
    }

    const messageById = new Map<string, WorkingBatchMessageInput>();
    assistantMessages.forEach((msg) => {
        messageById.set(msg.info.id, msg);
    });

    const batches: WorkingStepBatch[] = [];
    let currentSteps: WorkingStepRecord[] = [];
    const lastMessage = assistantMessages[assistantMessages.length - 1];

    const flushCurrentBatch = (settled: boolean) => {
        if (currentSteps.length === 0) return;
        const firstStep = currentSteps[0];
        const isFirstBatch = batches.length === 0;
        const durationSeconds = computeBatchDurationSeconds(
            currentSteps,
            messageById,
            isFirstBatch ? turnStartedAt : undefined,
        );
        batches.push({
            id: `working-batch-${firstStep.key}`,
            anchorMessageId: firstStep.messageId,
            anchorPartKey: firstStep.key,
            steps: currentSteps,
            settled,
            durationSeconds,
        });
        currentSteps = [];
    };

    for (const message of assistantMessages) {
        const messageId = message.info.id;
        const messageIsStreaming = isTurnWorking && (
            streamingMessageId
                ? messageId === streamingMessageId
                : message === lastMessage
        );
        const visibleParts = filterVisibleParts(normalizeParts(message.parts), {
            includeReasoning: showReasoningTraces,
        });

        visibleParts.forEach((part, partIndex) => {
            const key = getMessagePartKey(messageId, part, partIndex);

            if (part.type === 'text') {
                if (!isEmptyTextPart(part)) {
                    flushCurrentBatch(true);
                }
                return;
            }

            if (part.type === 'reasoning') {
                if (!showReasoningTraces) return;
                const startedAt = part.time?.start;
                const endedAt = part.time?.end;
                const isStreaming = messageIsStreaming && endedAt === undefined;
                const hasText = Boolean(part.text && part.text.trim().length > 0);
                if (!hasText && !isStreaming) return;

                currentSteps.push({
                    id: part.id && part.id.length > 0 ? part.id : key,
                    key,
                    messageId,
                    partIndex,
                    part,
                    kind: 'reasoning',
                    startedAt,
                    endedAt,
                    isStreaming,
                });
                return;
            }

            if (part.type === 'tool') {
                const toolName = part.tool?.toLowerCase() ?? '';
                if (isStandaloneTool(toolName)) {
                    flushCurrentBatch(true);
                    return;
                }
                if (!shouldIncludeToolPart(part)) {
                    return;
                }
                const state = part.state;
                const startedAt = state && state.status !== 'pending' ? state.time?.start : undefined;
                const endedAt = state && (state.status === 'completed' || state.status === 'error') ? state.time?.end : undefined;
                const isStreaming = isToolActive(part);

                currentSteps.push({
                    id: part.id && part.id.length > 0 ? part.id : key,
                    key,
                    messageId,
                    partIndex,
                    part,
                    kind: 'tool',
                    startedAt,
                    endedAt,
                    isStreaming,
                });
            }
        });
    }

    if (currentSteps.length > 0) {
        flushCurrentBatch(!isTurnWorking);
    }

    return batches;
};
