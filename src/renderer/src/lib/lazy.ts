import { createElement, lazy, useState, type ComponentProps, type ComponentType } from 'react';

const preloaders: (() => void)[] = [];
let preloadScheduled = false;

/** Fetches every lazy chunk once the app is idle after first paint, so first open never waits on (or flashes) a Suspense fallback. */
function schedulePreload(): void {
  if (preloadScheduled) return;
  preloadScheduled = true;
  const run = () => preloaders.forEach((preload) => preload());
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}

/**
 * `React.lazy` for a named export, so heavy views and dialogs ship as separate chunks. Chunks are preloaded on idle;
 * a component mounted after its module has loaded renders directly (React 19 holds a lazy component's first render back
 * ~300 ms behind the Suspense fallback even when the chunk is cached). Props are inferred from the module's export.
 */
export function lazyExport<M extends Record<string, any>, K extends keyof M & string>(load: () => Promise<M>, name: K): ComponentType<ComponentProps<M[K]>> {
  let loaded: ComponentType<ComponentProps<M[K]>> | null = null;
  const remember = (m: M): ComponentType<ComponentProps<M[K]>> => (loaded = m[name]);
  // A lazy component is a valid ComponentType at runtime; React's types only lack the overlap for generic props.
  const Lazy = lazy<ComponentType<ComponentProps<M[K]>>>(() => load().then((m) => ({ default: remember(m) }))) as unknown as ComponentType<ComponentProps<M[K]>>;
  preloaders.push(() => void load().then(remember).catch(() => undefined));
  schedulePreload();
  // The choice is made once per mount, so a mounted dialog is never remounted (losing its state) when its module finishes loading.
  return function LazyExport(props: ComponentProps<M[K]>) {
    const [Direct] = useState(() => loaded);
    return createElement(Direct ?? Lazy, props);
  };
}
