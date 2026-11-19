/**
 * main.tsx - React root of the webview (C1).
 * Responsibility: createRoot(#root).render(<App />). No logic.
 * Depends on: App.tsx. Depended on by: webview/index.html.
 */
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';

createRoot(document.getElementById('root')!).render(<App />);
