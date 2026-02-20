// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import React from 'react';
import ReactDOM from 'react-dom/client';
import { MOQTransport, Logger, LogLevel } from '@web-moq/core';
import App from './App';
import { setTransportFactory } from './store';
import './index.css';

// Initialize log level - default to ERROR unless changed in dev settings
// Check localStorage for persisted setting from zustand persist middleware
try {
  const persistedState = localStorage.getItem('moqt-client-storage');
  if (persistedState) {
    const parsed = JSON.parse(persistedState);
    const logLevel = parsed?.state?.logLevel ?? LogLevel.ERROR;
    Logger.setLevel(logLevel);
  } else {
    Logger.setLevel(LogLevel.ERROR);
  }
} catch {
  Logger.setLevel(LogLevel.ERROR);
}

// Initialize the transport factory
setTransportFactory((config) => new MOQTransport(config));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
