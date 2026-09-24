import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import * as actions from './state/actions';
import { store } from './state/store';
import { buildDiscardPatch, buildStagePatch } from '@shared/diff/patch';
import { invoke } from './api';
import './styles/global.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/diff.css';
import './styles/dialogs.css';
import './styles/review.css';
import './styles/help.css';
// Exposed for automated smoke tests and debugging from the devtools console.
// `invoke` lets a smoke script drive a raw IPC method a friendly action does not cover (e.g. forcing
// a push with no upstream set, to reproduce a specific error for the error-explanation smoke test).
(window as unknown as { __gitgood: unknown }).__gitgood = { store, actions, diff: { buildDiscardPatch, buildStagePatch }, invoke };

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
