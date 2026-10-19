import { describe, expect, test } from 'bun:test'
import { planSavedSelectionRestore } from './savedSelectionRestore'

const a = { providerId: 'claude-code', modelId: 'sonnet' }
const b = { providerId: 'openai', modelId: 'gpt-5.5' }

describe('planSavedSelectionRestore', () => {
  test('keeps the session model when only the agent was remembered with no per-agent model', () => {
    expect(planSavedSelectionRestore({ savedAgentName: 'Claude', agentExists: true, agentModel: null, sessionModel: a }))
      .toEqual({ agent: 'Claude', models: [a] })
  })
  test('prefers the per-agent model, then the session model, without duplicates', () => {
    expect(planSavedSelectionRestore({ savedAgentName: 'x', agentExists: true, agentModel: a, sessionModel: b }).models).toEqual([a, b])
    expect(planSavedSelectionRestore({ savedAgentName: 'x', agentExists: true, agentModel: a, sessionModel: a }).models).toEqual([a])
  })
  test('ignores an agent that no longer exists but still restores the model', () => {
    expect(planSavedSelectionRestore({ savedAgentName: 'gone', agentExists: false, agentModel: null, sessionModel: b }))
      .toEqual({ agent: null, models: [b] })
  })
  test('plans nothing for a session with no memory, so only then do defaults apply', () => {
    expect(planSavedSelectionRestore({ savedAgentName: null, agentExists: false, agentModel: null, sessionModel: null }))
      .toEqual({ agent: null, models: [] })
  })
})
