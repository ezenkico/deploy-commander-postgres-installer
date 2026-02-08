import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

console.log("Sent");
    window.parent.postMessage({
      type: "rpc.call",
      wireId: "test",
      request: "run",
      payload: {
        check: "Yep"
      }
    }, "*")

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
