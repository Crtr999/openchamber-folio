import type { JSONSchema } from 'zod/v4/core';
export const teamOutputInput: JSONSchema.BaseSchema;
export interface TeamOutputInput { filename: string; content: string }
export interface TeamOutputReceipt { version: 1; path: string; relativePath: string; bytes: number; sha256: string }
export function createTeamOutputWriter(options: { directory: string; exclusiveOutputOwnership: true }): (input: TeamOutputInput, options?: { signal?: AbortSignal }) => TeamOutputReceipt;
