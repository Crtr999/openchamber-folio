import { plugin } from 'bun';

/**
 * Bun's test runner has no bundler, so `import.meta.glob` — a Vite build-time
 * expansion — does not exist and any module that calls it throws on import.
 *
 * `useProviderLogo` is currently the only caller. It is reached by every model
 * picker, so without this a test cannot render any of them, and the usual
 * workaround is to replace the module under test, which hides the real
 * behaviour. Expanding the call to an empty map lets the module load and take
 * its own remote-logo path, which is a real code path with a real result.
 *
 * This only runs under `bun test`. Vite still does the real expansion in the
 * app build, so nothing about the shipped app changes. A second
 * `import.meta.glob` call site needs its path added here.
 */
plugin({
  name: 'openchamber-vite-glob',
  setup(build) {
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const expanded = source.replace(/import\.meta\.glob(<[^>]*>)?\((?:[^()]|\([^()]*\))*\)/, '{}');
      if (expanded === source) return undefined;
      return { contents: expanded, loader: 'ts' };
    });
  },
});
