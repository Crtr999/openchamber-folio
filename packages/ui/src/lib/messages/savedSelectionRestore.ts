type ModelRef = { providerId: string; modelId: string }

/**
 * What a reopened session should put back in the composer from what this
 * device remembers about it.
 *
 * The session's own model always outranks the agent's pinned/default model and
 * the settings default: `setAgent` alone resolves those defaults, so the
 * caller must switch the agent first and then apply `models` in order, never
 * the other way round and never stop at "agent restored".
 */
export const planSavedSelectionRestore = ({
  savedAgentName,
  agentExists,
  agentModel,
  sessionModel,
}: {
  savedAgentName: string | null
  agentExists: boolean
  /** The model remembered for `savedAgentName` in this session. */
  agentModel: ModelRef | null
  /** The last model this session used, whatever the agent. */
  sessionModel: ModelRef | null
}): { agent: string | null; models: ModelRef[] } => {
  const models: ModelRef[] = []
  for (const candidate of [agentModel, sessionModel]) {
    if (!candidate?.providerId || !candidate.modelId) continue
    if (models.some((m) => m.providerId === candidate.providerId && m.modelId === candidate.modelId)) continue
    models.push(candidate)
  }
  return { agent: savedAgentName && agentExists ? savedAgentName : null, models }
}
