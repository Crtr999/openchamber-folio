import { describe, expect, test } from 'bun:test'
import { allowedProvidersFromPolicies } from './opencode/projection'
import {
  agentAllowedByBinding,
  consumeUnboundDraftTarget,
  filterProvidersByBinding,
  isBoundAgentName,
  isStrictlyZdrBound,
  pickBoundModel,
  providerBindingFromFolderName,
  rememberUnboundDraftTarget,
} from './projectProviderBinding'

type Entries = Parameters<typeof allowedProvidersFromPolicies>[0]
const doc = (policies: Array<{ action: string; resource: string; effect: 'allow' | 'deny' }>) =>
  ({ type: 'document', path: '/x/opencode.json', info: { experimental: { policies } } }) as unknown as Entries[number]

describe('allowedProvidersFromPolicies', () => {
  test('deny-all plus allows binds the folder (Claude folder config)', () => {
    expect(allowedProvidersFromPolicies([doc([
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'claude-code', effect: 'allow' },
      { action: 'provider.use', resource: 'gemini-cli', effect: 'allow' },
    ])])).toEqual(['claude-code', 'gemini-cli'])
  })
  test('no deny-all, or no allows, leaves the folder unbound', () => {
    expect(allowedProvidersFromPolicies([doc([{ action: 'provider.use', resource: 'openai', effect: 'allow' }])])).toBeNull()
    expect(allowedProvidersFromPolicies([doc([{ action: 'provider.use', resource: '*', effect: 'deny' }])])).toBeNull()
    expect(allowedProvidersFromPolicies([doc([{ action: 'provider.use', resource: 'openai', effect: 'deny' }])])).toBeNull()
    expect(allowedProvidersFromPolicies([])).toBeNull()
  })
  test('policies from several documents combine', () => {
    expect(allowedProvidersFromPolicies([
      doc([{ action: 'provider.use', resource: '*', effect: 'deny' }]),
      doc([{ action: 'provider.use', resource: 'openai', effect: 'allow' }]),
    ])).toEqual(['openai'])
  })
})

describe('provider binding helpers', () => {
  const providers = [
    { id: 'openai', models: [{ id: 'gpt-5.5' }] },
    { id: 'claude-code', models: [{ id: 'sonnet' }, { id: 'opus' }] },
    { id: 'empty', models: [] },
  ]
  test('filters providers, and leaves unbound folders alone', () => {
    expect(filterProvidersByBinding(providers, ['claude-code']).map((p) => p.id)).toEqual(['claude-code'])
    expect(filterProvidersByBinding(providers, null)).toHaveLength(3)
    expect(filterProvidersByBinding(providers, [])).toHaveLength(3)
  })
  test('hides only agents pinned to a disallowed provider', () => {
    expect(agentAllowedByBinding({ model: { providerID: 'openai' } }, ['claude-code'])).toBe(false)
    expect(agentAllowedByBinding({}, ['claude-code'])).toBe(true)
    expect(agentAllowedByBinding({ model: { providerID: 'openai' } }, null)).toBe(true)
  })
  test('picks the preferred model when allowed, else the first allowed model', () => {
    expect(pickBoundModel({ providers, binding: ['claude-code'], preferred: { providerId: 'claude-code', modelId: 'opus' } }))
      .toEqual({ providerId: 'claude-code', modelId: 'opus' })
    expect(pickBoundModel({ providers, binding: ['claude-code'], preferred: { providerId: 'openai', modelId: 'gpt-5.5' } }))
      .toEqual({ providerId: 'claude-code', modelId: 'sonnet' })
    expect(pickBoundModel({ providers, binding: ['missing'] })).toBeNull()
  })
  test('derives a fallback binding only for Open Carter workspace folders and ZDR Legal folders', () => {
    expect(providerBindingFromFolderName('/Users/c/Documents/Open Carter/Claude')).toEqual(['claude-code'])
    expect(providerBindingFromFolderName('/Users/c/Documents/Open Carter/ChatGPT')).toEqual(['openai'])
    expect(providerBindingFromFolderName('/Users/c/Built Apps/ZDR Management')).toEqual(['openrouter-zdr'])
    expect(providerBindingFromFolderName('/Users/c/code/Claude')).toBeNull()
    expect(isStrictlyZdrBound(['openrouter-zdr'])).toBe(true)
    expect(isStrictlyZdrBound(['openai'])).toBe(false)
  })
  test('remembers and restores unbound draft target when leaving Claude/ChatGPT/ZDR folders for an outside agent', () => {
    expect(isBoundAgentName('Claude')).toBe(true)
    expect(isBoundAgentName('ChatGPT')).toBe(true)
    expect(isBoundAgentName('zdr')).toBe(true)
    expect(isBoundAgentName('manager')).toBe(false)

    rememberUnboundDraftTarget({
      selectedProjectId: 'proj-business-launch',
      directoryOverride: '/Users/c/Documents/Business Launch',
      target: 'project',
    })
    // Entering another bound folder does not overwrite the remembered unbound folder
    rememberUnboundDraftTarget({
      selectedProjectId: 'proj-claude',
      directoryOverride: '/Users/c/Documents/Open Carter/Claude',
      target: 'project',
    })
    expect(consumeUnboundDraftTarget('__chat__')).toEqual({
      selectedProjectId: 'proj-business-launch',
      directoryOverride: '/Users/c/Documents/Business Launch',
      target: 'project',
    })
    // Once consumed, falls back to All Chats
    expect(consumeUnboundDraftTarget('__chat__')).toEqual({
      selectedProjectId: '__chat__',
      directoryOverride: null,
      target: 'chat',
    })
  })
})
