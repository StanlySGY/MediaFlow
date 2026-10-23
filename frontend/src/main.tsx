import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

// `reducedMotion="user"` makes the OS "reduce motion" setting apply to every
// framer-motion animation in one place. Without it the CSS block in index.css
// still stops CSS animations, but the route/view transitions keep moving —
// so the preference was only half honoured.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </ErrorBoundary>
  </React.StrictMode>,
)
