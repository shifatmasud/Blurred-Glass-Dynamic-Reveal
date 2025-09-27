import React from 'react';
import ReactDOM from 'react-dom/client';
// Fix: Import the Clarity component directly.
import { Clarity } from './framer.tsx';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <Clarity />
  </React.StrictMode>
); 
 