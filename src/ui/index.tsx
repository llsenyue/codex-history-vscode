import React from 'react';
import { render } from 'ink';
import App from './app.js';
import { HistoryManager } from '../historyManager.js';

interface UiOptions {
  limit?: number;
}

export function launchUI(manager: HistoryManager, options: UiOptions = {}) {
  const limit = options.limit ?? 50;
  const ink = render(<App manager={manager} limit={limit} />);
  return ink;
}
