import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initDesktopBridge } from './services/tauriBridge';

initDesktopBridge();

createRoot(document.getElementById('root')!).render(<App />);
