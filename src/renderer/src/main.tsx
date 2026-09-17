import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import * as actions from './state/actions';
import { store } from './state/store';
import { buildDiscardPatch, buildStagePatch } from '@shared/diff/patch';
import './styles/global.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/diff.css';
import './styles/dialogs.css';

// Exposed for automated smoke tests and debugging from the devtools console.
(window as unknown as { __gitgood: unknown }).__gitgood = { store, actions, diff: { buildDiscardPatch, buildStagePatch } };

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
