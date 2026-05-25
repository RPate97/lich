import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// Placeholder App — real components land in Task 14 (LEV-416).
function App(): JSX.Element {
  return <div>lich dashboard — UI components land in Task 14</div>;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
