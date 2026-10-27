import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, ToolPart } from '@/lib/opencode/model';
import { getEffectiveToolInput, hasToolInputDetails, parseStreamingToolInput } from '../../message/parts/toolRenderUtils';
import type { ChatMessageEntry } from './types';
import { formatWorkedDuration, projectWorkingStepBatches } from './workingStepBatches';

function assistant(id: string, parts: Part[], options: Partial<AssistantMessage> = {}): ChatMessageEntry {
    return {
        info: {
            id,
            sessionID: 'session',
            role: 'assistant',
            time: { created: 1_000 },
            modelID: 'model',
            providerID: 'provider',
            agent: 'build',
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            ...options,
        },
        parts,
    };
}

function text(id: string, content: string): Part {
    return { type: 'text', id, messageID: 'msg', sessionID: 'session', text: content };
}

function reasoning(id: string, content: string, start = 1_000, end?: number): Part {
    return {
        type: 'reasoning',
        id,
        messageID: 'msg',
        sessionID: 'session',
        text: content,
        time: { start, end },
    };
}

function tool(id: string, name: string, status: 'running' | 'completed' = 'completed', start = 1_000, end?: number): ToolPart {
    return {
        id,
        callID: id,
        type: 'tool',
        tool: name,
        messageID: 'msg',
        sessionID: 'session',
        state: status === 'running'
            ? { status: 'running', input: {}, metadata: {}, time: { start } }
            : { status: 'completed', input: {}, output: 'ok', metadata: {}, time: { start, end: end ?? start + 1_000 } },
    };
}

describe('formatWorkedDuration', () => {
    test('formats seconds and minutes cleanly', () => {
        expect(formatWorkedDuration(1)).toBe('1s');
        expect(formatWorkedDuration(11)).toBe('11s');
        expect(formatWorkedDuration(60)).toBe('1m');
        expect(formatWorkedDuration(94)).toBe('1m 34s');
    });
});

describe('projectWorkingStepBatches', () => {
    test('settles an initial thinking step once prose arrives and keeps the trailing working batch active while streaming', () => {
        const msg1 = assistant('m1', [
            reasoning('r1', 'Initial check', 1_000, 12_000),
            text('t1', "I'll dig into what Google actually changed and what the current working bridge looks like, then build it."),
            reasoning('r2', 'Checking wrapper repository', 12_000, 20_000),
            tool('tool1', 'webfetch', 'completed', 20_000, 24_000),
        ]);
        const msg2 = assistant('m2', [
            reasoning('r3', 'Streaming new thought', 24_000),
        ]);

        const batches = projectWorkingStepBatches({
            assistantMessages: [msg1, msg2],
            showReasoningTraces: true,
            isTurnWorking: true,
            streamingMessageId: 'm2',
        });

        expect(batches).toHaveLength(2);
        expect(batches[0]).toMatchObject({
            anchorMessageId: 'm1',
            settled: true,
            durationSeconds: 11,
        });
        expect(batches[0]?.steps).toHaveLength(1);

        expect(batches[1]).toMatchObject({
            anchorMessageId: 'm1',
            settled: false,
        });
        expect(batches[1]?.steps.map((s) => s.id)).toEqual(['r2', 'tool1', 'r3']);
        expect(batches[1]?.steps[2]?.isStreaming).toBe(true);
    });

    test('settles the multi-message working batch with total step count and duration once the final answer arrives', () => {
        const msg1 = assistant('m1', [
            reasoning('r1', 'Initial check', 1_000, 12_000),
            text('t1', 'Starting investigation.'),
            reasoning('r2', 'Step 1', 12_000, 40_000),
            tool('tool1', 'webfetch', 'completed', 40_000, 70_000),
        ]);
        const msg2 = assistant('m2', [
            reasoning('r3', 'Step 3', 70_000, 106_000),
            text('t2', 'Here is the final answer.'),
        ], { finish: 'stop', time: { created: 70_000, completed: 106_000 } });

        const batches = projectWorkingStepBatches({
            assistantMessages: [msg1, msg2],
            showReasoningTraces: true,
            isTurnWorking: false,
        });

        expect(batches).toHaveLength(2);
        expect(batches[0]?.settled).toBe(true);
        expect(batches[0]?.durationSeconds).toBe(11);
        expect(batches[0]?.steps).toHaveLength(1);

        expect(batches[1]?.settled).toBe(true);
        expect(batches[1]?.durationSeconds).toBe(94);
        expect(batches[1]?.steps).toHaveLength(3);
    });
});

describe('parseStreamingToolInput & getEffectiveToolInput', () => {
    test('parses complete and partial streaming raw JSON tool inputs when state.input is empty', () => {
        expect(parseStreamingToolInput('{"path":"/Users/carter/AGENTS.md"}')).toEqual({
            path: '/Users/carter/AGENTS.md',
        });
        expect(parseStreamingToolInput('{"path":"/Users/carter/MEMORY.md')).toEqual({
            path: '/Users/carter/MEMORY.md',
        });

        const pendingPart: ToolPart = {
            id: 'call_1',
            callID: 'call_1',
            type: 'tool',
            tool: 'read',
            messageID: 'msg_1',
            sessionID: 'ses_1',
            state: {
                status: 'pending',
                input: {},
                raw: '{"path":"/Users/carter/AGENTS.md"}',
            },
        };
        expect(getEffectiveToolInput(pendingPart.state)).toEqual({
            path: '/Users/carter/AGENTS.md',
        });
        expect(hasToolInputDetails(pendingPart)).toBe(true);
    });
});
