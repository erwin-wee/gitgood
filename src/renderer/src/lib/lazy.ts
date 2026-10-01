import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** `React.lazy` for a named export, so heavy views and dialogs load as separate chunks on first use. Props are inferred from the module's export. */
export function lazyExport<M extends Record<string, any>, K extends keyof M & string>(load: () => Promise<M>, name: K): LazyExoticComponent<M[K] extends ComponentType<any> ? M[K] : never> {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
