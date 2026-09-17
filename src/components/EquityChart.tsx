import React from 'react'

export default function EquityChart() {
  return (
    <div className="equity-card">
      <div className="chart-header">
        <div className="chart-title-group">
          <span className="chart-title">资金曲线 · 全策略净值（DEMO）</span>
          <span className="chart-subtitle">手绘演示曲线 · 非真实业绩</span>
        </div>
        <div className="pnl-badge">
          <span>+$7.23M · 演示数据</span>
        </div>
      </div>

      <div className="chart-body">
        <svg viewBox="0 0 756 500" className="chart-svg" preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* 网格线 */}
          {[90, 190, 290, 390, 480].map((y) => (
            <line key={`h-${y}`} x1="40" y1={y} x2="740" y2={y} stroke="var(--border)" strokeWidth="1" />
          ))}
          {[210, 340, 470, 600, 730].map((x) => (
            <line key={`v-${x}`} x1={x} y1="60" x2={x} y2="480" stroke="var(--border)" strokeWidth="1" />
          ))}

          {/* Y 轴标签 */}
          <text x="12" y="35" fill="var(--text-weak)" fontSize="10" fontFamily="var(--font-mono)">12.8M</text>
          <text x="12" y="135" fill="var(--text-weak)" fontSize="10" fontFamily="var(--font-mono)">10M</text>
          <text x="12" y="235" fill="var(--text-weak)" fontSize="10" fontFamily="var(--font-mono)">8M</text>
          <text x="12" y="335" fill="var(--text-weak)" fontSize="10" fontFamily="var(--font-mono)">6M</text>
          <text x="12" y="435" fill="var(--text-weak)" fontSize="10" fontFamily="var(--font-mono)">4M</text>

          {/* X 轴标签 */}
          <text x="200" y="495" fill="var(--text-weak)" fontSize="10" fontFamily="var(--font-cn)" textAnchor="middle">3月</text>
          <text x="330" y="495" fill="var(--text-weak)" fontSize="10" fontFamily="var(--font-cn)" textAnchor="middle">5月</text>
          <text x="460" y="495" fill="var(--text-weak)" fontSize="10" fontFamily="var(--font-cn)" textAnchor="middle">6月</text>
          <text x="590" y="495" fill="var(--text-weak)" fontSize="10" fontFamily="var(--font-cn)" textAnchor="middle">7月</text>
          <text x="720" y="495" fill="var(--text-weak)" fontSize="10" fontFamily="var(--font-cn)" textAnchor="middle">8月</text>

          {/* 面积填充 */}
          <path
            d="M40,425 C120,400 160,380 220,365 C280,350 320,330 380,280 C440,230 480,200 520,180 C560,160 600,130 650,90 C690,60 710,70 735,87 L735,460 L40,460 Z"
            fill="url(#areaGrad)"
          />

          {/* 基准 BTC 线（灰色虚线） */}
          <path
            d="M40,425 C150,415 250,405 350,395 C450,385 550,365 650,355 C690,350 710,345 735,340"
            stroke="var(--text-weak)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            fill="none"
            opacity="0.6"
          />

          {/* 主曲线（青色） */}
          <path
            d="M40,425 C120,400 160,380 220,365 C280,350 320,330 380,280 C440,230 480,200 520,180 C560,160 600,130 650,90 C690,60 710,70 735,87"
            stroke="var(--primary)"
            strokeWidth="2"
            fill="none"
          />

          {/* 里程碑点 - Python 脚本 */}
          <circle cx="200" cy="386" r="8" stroke="var(--accent)" strokeWidth="1.5" fill="none" />
          <circle cx="200" cy="386" r="4" fill="var(--accent)" />
          {/* 里程碑点 - LLM 决策 */}
          <circle cx="440" cy="292" r="8" stroke="var(--accent)" strokeWidth="1.5" fill="none" />
          <circle cx="440" cy="292" r="4" fill="var(--accent)" />
          {/* 里程碑点 - 自主闭环 */}
          <circle cx="675" cy="135" r="10" stroke="var(--accent)" strokeWidth="1.5" fill="none" />
          <circle cx="675" cy="135" r="5" fill="var(--accent)" />
          {/* 当前点 */}
          <circle cx="740" cy="92" r="12" stroke="var(--primary)" strokeWidth="1.5" fill="none" />
          <circle cx="740" cy="92" r="5" fill="var(--primary)" />

          {/* 里程碑标签 */}
          <text x="180" y="365" fill="var(--accent)" fontSize="10" fontFamily="var(--font-cn)" fontWeight="700">Python 脚本</text>
          <text x="420" y="272" fill="var(--accent)" fontSize="10" fontFamily="var(--font-cn)" fontWeight="700">LLM 决策</text>
          <text x="650" y="108" fill="var(--accent)" fontSize="10" fontFamily="var(--font-cn)" fontWeight="700">自主闭环</text>

          {/* 当前值标签 */}
          <text x="700" y="67" fill="var(--primary)" fontSize="11" fontFamily="var(--font-cn)" fontWeight="700">$12.85M</text>
        </svg>
      </div>

      <div className="chart-legend">
        <div className="legend-item">
          <span className="legend-dot" style={{ background: 'var(--primary)' }} />
          <span>策略净值 (EVOLVE 全 Agent)</span>
        </div>
        <div className="legend-item">
          <span className="legend-line" />
          <span>基准 BTC</span>
        </div>
        <div className="legend-item">
          <span className="legend-dot" style={{ background: 'var(--accent)' }} />
          <span>进化里程碑</span>
        </div>
      </div>

      <style>{`
        .equity-card {
          flex: 1;
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 16px;
          display: flex; flex-direction: column; gap: 8px;
          overflow: hidden;
        }
        .chart-header {
          display: flex; align-items: center; justify-content: space-between;
          height: 30px;
        }
        .chart-title-group {
          display: flex; align-items: center; gap: 10px;
        }
        .chart-title {
          font-family: var(--font-ui); font-size: 14px; font-weight: 600;
          color: var(--text-main);
        }
        .chart-subtitle {
          font-family: var(--font-ui); font-size: 10px; font-weight: 400;
          color: var(--text-weak); margin-top: 2px;
        }
        .pnl-badge {
          background: var(--bg-elevated); border: 1px solid var(--border-strong);
          border-radius: 14px; padding: 5px 10px;
        }
        .pnl-badge span {
          font-family: var(--font-mono); font-size: 11px; font-weight: 700;
          color: var(--up);
        }
        .chart-body {
          flex: 1; position: relative; min-height: 0;
        }
        .chart-svg {
          width: 100%; height: 100%;
          display: block;
        }
        .chart-legend {
          display: flex; align-items: center; gap: 18px;
          height: 20px; padding-top: 4px;
        }
        .legend-item {
          display: flex; align-items: center; gap: 8px;
          font-family: var(--font-ui); font-size: 10px; color: var(--text-sub);
        }
        .legend-dot {
          width: 6px; height: 6px; border-radius: 50%;
        }
        .legend-line {
          width: 12px; height: 0; border-top: 2px dashed var(--text-weak);
          opacity: 0.7;
        }
      `}</style>
    </div>
  )
}
