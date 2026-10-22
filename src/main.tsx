import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './theme.css'

document.documentElement.dataset.platform = window.launcher?.platform ?? 'web'
try {
  const theme = localStorage.getItem('lua-theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
} catch { /* Preference only. */ }

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
