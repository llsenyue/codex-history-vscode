import { jsx as _jsx } from "react/jsx-runtime";
import { render } from 'ink';
import App from './app.js';
export function launchUI(manager, options = {}) {
    const limit = options.limit ?? 50;
    const ink = render(_jsx(App, { manager: manager, limit: limit }));
    return ink;
}
