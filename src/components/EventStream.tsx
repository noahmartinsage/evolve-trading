import React from 'react'

export interface StreamEvent {
  time: string
  agent: string
  agentColor: string
  text: string
}

export default function EventStream({ events, title = '实时事件流' }: { events: StreamEvent[]; title?: string }) {
  return (
    <div className="event-card">
      <div className="event-header">
        <span className="event-title">{title}</span>
        <div className="live-badge">
          <span className="live-dot" />
          <span className="live-text">实时</span>
        </div>
      </div>
      <div className="event-list">
        {events.slice(0, 8).map((e, i) => (
          <div key={i} className="event-row">
            <span className="event-time">{e.time}</span>
            <span className="event-agent" style={{ color: e.agentColor }}>{e.agent}</span>
            <span className="event-text">{e.text}</span>
          </div>
        ))}
      </div>
      <style>{`
        .event-card {
          flex: 1; min-height: 0;
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 12px 14px;
          display: flex; flex-direction: column;
          overflow: hidden;
        }
        .event-header {
          display: flex; align-items: center; justify-content: space-between;
          padding-bottom: 6px; border-bottom: 1px solid var(--border);
          margin-bottom: 4px; flex-shrink: 0;
        }
        .event-title {
          font-family: var(--font-ui); font-size: 14px; font-weight: 600;
          color: var(--text-main);
        }
        .live-badge {
          display: flex; align-items: center; gap: 5px;
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 3px 8px;
        }
        .live-dot {
          width: 5.2px; height: 5.2px; border-radius: 50%;
          background: var(--up);
          animation: liveBlink 1.2s infinite;
        }
        @keyframes liveBlink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        .live-text {
          font-family: var(--font-mono); font-size: 9px; font-weight: 700;
          color: var(--up);
        }
        .event-list { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
        .event-row {
          display: flex; align-items: center; gap: 8px;
          height: 32px; flex-shrink: 0;
        }
        .event-time {
          width: 54px; flex-shrink: 0;
          font-family: var(--font-mono); font-size: 10px; font-weight: 400;
          color: var(--text-weak);
        }
        .event-agent {
          font-family: var(--font-mono); font-size: 10px; font-weight: 500;
          flex-shrink: 0;
        }
        .event-text {
          flex: 1; min-width: 0;
          font-family: var(--font-ui); font-size: 10px; font-weight: 400;
          color: var(--text-sub);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
      `}</style>
    </div>
  )
}
