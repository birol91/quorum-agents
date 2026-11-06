import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { apply } from './store.ts';
import './styles.css';

// Dev/demo hook: lets the run driver inject synthetic events to exercise the
// UI (arrows, cards, panels) without live sessions. Harmless in production.
(window as unknown as { __quorumApply?: typeof apply }).__quorumApply = apply;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
