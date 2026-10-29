import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// StrictMode double-mounts effects in dev (expect a doubled camera-init log);
// the camera effect's cancelled flag and the voice cleanup make it safe.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
