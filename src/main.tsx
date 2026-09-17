import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import WalletProvider from './wallet/WalletProvider'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/tokens.css'
import './styles/global.css'
import './styles/pet.css'

/**
 * 桌宠窗口（`?pet=1`）必须在 **React 挂载之前**给 `<html>` 打标记。
 *
 * 理由：桌宠窗是 Electron 的 `transparent: true` 无边框窗。而全局
 * `body` 有自己的深色底 —— 不抹掉的话，透明窗会渲染成一块黑方块。
 * 这件事**在浏览器里预览是看不出来的**（浏览器窗口本来就不透明），
 * 只有真起 Electron 才会暴露。
 *
 * 放在这里而不是组件里：CSS 一进 body 就生效，等 React 挂载再改
 * 会先闪一下黑底。
 */
if (new URLSearchParams(window.location.search).get('pet') === '1') {
  document.documentElement.classList.add('pet-standalone')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <WalletProvider>
        <App />
      </WalletProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
