/** Session-only free-model guard. Ordinary project chats are unchanged. */
export function createFreeTeamGuard({ directory, model, models = [model], profiles, now = Date.now }) {
  const frozenModel = root => {
    const selected = root.metadata?.aiTaskModel;
    // Session metadata is JSON from the SDK. Exact reviewed pairs establish
    // identity; discovered opencode candidates additionally need catalog proof
    // in enforce before any model or transport request.
    if (!selected || !selected.id
      || !(models.some(item => item.providerID === selected.providerID && item.id === selected.id) || selected.providerID === 'opencode')
      || Object.keys(selected).some(key => !['providerID', 'id', 'variant'].includes(key))
      || selected.variant !== undefined && selected.variant !== 'default'
      || root.model?.providerID !== selected.providerID || root.model?.id !== selected.id
      || root.model?.variant !== undefined && root.model.variant !== 'default') throw new Error('Free team frozen task model could not be verified.');
    return selected;
  };
  // Returns the tagged task root, whose model every descendant must keep.
  const tagged = async (ctx, sessionID) => {
    const seen = new Set();
    let id = sessionID;
    for (let depth = 0; depth < 5; depth += 1) {
      if (!id || seen.has(id)) throw new Error('Free team session ancestry could not be verified.');
      seen.add(id);
      const session = await ctx.session.get({ sessionID: id }, { signal: AbortSignal.timeout(5000) });
      if (session.location.directory !== directory) throw new Error('Free team project scope mismatch.');
      if (session.metadata?.aiTaskRunId) {
        if (id === sessionID && (session.outcome || session.metadata?.openchamber || await ctx.storage?.get(`unlocked:${id}`))) {
          await ctx.storage?.set(`unlocked:${id}`, true);
          return null;
        }
        return session;
      }
      if (!session.parentID) return null;
      id = session.parentID;
    }
    throw new Error('Free team session ancestry exceeded its limit.');
  };
  const enforce = async (ctx, event) => {
    const root = await tagged(ctx, event.sessionID);
    if (!root) return;
    // The task's own model is chosen per run, but only from the reviewed list.
    const selected = frozenModel(root);
    const model = models.find(item => item.providerID === selected.providerID && item.id === selected.id)
      ?? (selected.providerID === 'opencode' ? { providerID: 'opencode', id: selected.id } : null);
    if (!model || event.model?.providerID !== model.providerID || event.model?.id !== model.id
      || event.model?.variant !== undefined && event.model.variant !== 'default') {
      throw new Error('Free-only team work refuses an auxiliary, switched or fallback model.');
    }
    const catalog = await ctx.model.list(undefined, { signal: AbortSignal.timeout(5000) });
    const matches = catalog.data.filter(item => item.providerID === model.providerID && item.id === model.id);
    const current = matches.length === 1 ? matches[0] : null;
    // Reviewed subscription models must stay unpriced; every other model must price at zero.
    const subscription = model.billing === 'subscription';
    if (!current?.enabled || !current.capabilities.tools || !Array.isArray(current.cost)
      || (subscription ? current.cost.length !== 0 : !current.cost.length || !current.cost.some(tier => !tier.tier))
      || current.cost.some(tier => Object.keys(tier).some(key => !['tier', 'input', 'output', 'cache'].includes(key))
        || tier.input !== 0 || tier.output !== 0 || tier.cache?.read !== 0 || tier.cache?.write !== 0
        || Object.keys(tier.cache).some(key => !['read', 'write'].includes(key)))) {
      throw new Error('Free-only team model pricing or availability could not be verified.');
    }
    const gate = await ctx.storage.get('free-team-cooldown');
    if (gate?.until > now()) throw new Error('Free provider is cooling down. No paid fallback is allowed.');
  };
  return {
    id: 'open-carter-free-team-guard',
    async setup(ctx) {
      if (profiles) {
        // Inherited manager rules must not grant a child's unrelated tools or
        // erase its narrowly admitted tools. This is rules replacement, never
        // a reply to a pending permission request.
        const scopePermissions = async (event, isPrompt = false) => {
          if (isPrompt && await ctx.storage?.get(`prompted:${event.sessionID}`)) {
            await ctx.storage?.set(`unlocked:${event.sessionID}`, true);
          }
          const root = await tagged(ctx, event.sessionID);
          if (!root) return;
          const selected = frozenModel(root);
          const session = await ctx.session.get({ sessionID: event.sessionID }, { signal: AbortSignal.timeout(5000) });
          const profile = profiles.find(item => item.id === session.agent);
          if (!profile) throw new Error('Free team agent is not admitted by the reviewed profile.');
          if (session.model?.providerID !== selected.providerID || session.model?.id !== selected.id
            || session.model?.variant !== undefined && session.model.variant !== 'default') throw new Error('Free team child must inherit the frozen task model.');
          await ctx.session.update({ sessionID: event.sessionID, permissions: profile.permissions }, { signal: AbortSignal.timeout(5000) });
          if (isPrompt && session.metadata?.aiTaskRunId) await ctx.storage?.set(`prompted:${event.sessionID}`, true);
        };
        await ctx.session.hook('prompt', event => scopePermissions(event, true));
        await ctx.session.hook('context', event => scopePermissions(event, false));
      }
      // Preserve the task's existing human title without a separately selected
      // maintenance model. Ordinary chat titles retain their normal behavior.
      await ctx.session.hook('title', async event => {
        if (!await tagged(ctx, event.sessionID)) return;
        const session = await ctx.session.get({ sessionID: event.sessionID }, { signal: AbortSignal.timeout(5000) });
        event.result = session.title;
      });
      // model.request covers primary, compaction, title and transient generation.
      // Native transport guards provide a second check before HTTP/WebSocket I/O.
      for (const kind of ['model.request', 'http.request', 'experimental.ws.handshake']) {
        await ctx.session.hook(kind, event => enforce(ctx, event));
      }
      await ctx.session.hook('retry', async event => {
        if (!await tagged(ctx, event.sessionID)) return;
        if (event.error.status !== 429) {
          if (event.attempt >= 3) event.decision = { retry: false };
          return;
        }
        const delay = Math.max(event.decision?.delay ?? 0, 30000 * 2 ** Math.min(event.attempt, 3));
        await ctx.storage.set('free-team-cooldown', { until: now() + delay, status: 429, attempt: event.attempt });
        event.decision = event.attempt < 3 && delay <= 300000 ? { retry: true, delay } : { retry: false };
      });
    },
  };
}
