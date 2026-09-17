import React from 'react'

interface State {
  error: Error | null
}

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[EVOLVE] 未捕获渲染错误', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 14,
          background: '#04060D', color: '#E6EAF2',
          fontFamily: 'ui-monospace, monospace', padding: 24, textAlign: 'center',
        }}>
          <div style={{ fontSize: 40 }}>💥</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>界面发生未捕获错误</div>
          <div style={{ fontSize: 12, color: '#97A0B5', maxWidth: 560, wordBreak: 'break-all' }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 8, padding: '9px 22px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid #22d3ee55', background: '#0b1620', color: '#67e8f9', fontSize: 13,
            }}
          >
            重载界面
          </button>
          <div style={{ fontSize: 11, color: '#5B6478' }}>
            模拟账户状态在内存中，刷新页面即重置；链上交易不受此影响
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
