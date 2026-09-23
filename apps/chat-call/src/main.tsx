import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@moq-web/app-kit/shell';
import '@moq-web/app-kit/styles.css';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultMode="system">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
