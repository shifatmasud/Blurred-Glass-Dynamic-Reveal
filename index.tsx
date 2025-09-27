import React from 'react';
import ReactDOM from 'react-dom/client';
// Fix: Import the main App component instead of the Clarity component directly.
import { ClarityApp } from './framer.tsx';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {/* Fix: Render the App component as the root of the application. */}
    <ClarityApp />
  </React.StrictMode>
);
