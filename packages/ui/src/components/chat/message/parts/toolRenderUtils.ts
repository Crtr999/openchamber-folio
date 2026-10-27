import type { Part, ToolInput, ToolPart as ToolPartType } from '@/lib/opencode/model';
import { OPENCODE_TOOLS, normalizeToolName, type ToolName } from '@/lib/opencode/tools';

// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.read, OPENCODE_TOOLS.skill]);

const STANDALONE_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.subagent]);

export const isExpandableTool = (toolName: ToolName): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: ToolName): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStaticTool = (toolName: ToolName): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};

const STREAMING_STRING_FIELD_PATTERN =
    /"(path|filePath|file_path|command|pattern|query|url|description|prompt|id|title|directory|search)"\s*:\s*"((?:[^"\\]|\\.)*)/g;

const unescapePartialJsonString = (rawValue: string): string => {
    return rawValue
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');
};

let lastRawString: string | null = null;
let lastParsedInput: ToolInput | undefined;

export const parseStreamingToolInput = (raw: string | undefined): ToolInput | undefined => {
    if (!raw) {
        return undefined;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return undefined;
    }
    if (trimmed === lastRawString) {
        return lastParsedInput;
    }

    const extracted: Record<string, string> = {};
    let foundAny = false;
    STREAMING_STRING_FIELD_PATTERN.lastIndex = 0;
    let match = STREAMING_STRING_FIELD_PATTERN.exec(trimmed);
    while (match !== null) {
        const key = match[1];
        const value = match[2];
        if (key && value !== undefined) {
            extracted[key] = unescapePartialJsonString(value);
            foundAny = true;
        }
        match = STREAMING_STRING_FIELD_PATTERN.exec(trimmed);
    }

    const parsedResult: ToolInput | undefined = foundAny ? extracted : undefined;
    lastRawString = trimmed;
    lastParsedInput = parsedResult;
    return parsedResult;
};

export const getEffectiveToolInput = (
    state: ToolPartType['state'] | { input?: ToolInput; raw?: string } | undefined,
): ToolInput | undefined => {
    if (!state) {
        return undefined;
    }
    const input = state.input;
    if (input && Object.keys(input).length > 0) {
        return input;
    }
    if ('raw' in state && state.raw !== undefined && state.raw.length > 0) {
        return parseStreamingToolInput(state.raw) ?? input;
    }
    return input;
};

export const hasToolInputDetails = (part: Part): boolean => {
    if (part.type !== 'tool') {
        return true;
    }
    const effectiveInput = getEffectiveToolInput(part.state);
    if (!effectiveInput) {
        return false;
    }
    return Object.keys(effectiveInput).length > 0;
};
