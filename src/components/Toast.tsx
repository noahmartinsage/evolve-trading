import React, { useEffect } from 'react'
import { useStore } from '../store/Store'

export default function Toast() {
  const { state, dispatch } = useStore()
  useEffect(() => {
    if (!state.toast) return
    const t = setTimeout(() => dispatch({ type: 'SET_TOAST', msg: null }), 2500)
    return () => clearTimeout(t)
  }, [state.toast, dispatch])

  if (!state.toast) return null
  return (
    <div style={{
      position: 'fixed', bottom: 40, left: '50%', transform: 'translateX(-50%)',
      background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
      borderRadius: 10, padding: '10px 20px', zIndex: 9999,
      fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-main)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    }}>
      {state.toast}
    </div>
  )
}
