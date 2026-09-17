import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('data/mirror-ledger-test.db')
console.log('tables:', db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).join(','))
console.log('events:', JSON.stringify(db.prepare('SELECT seq, kind FROM events ORDER BY seq').all()))
try {
  console.log('origins:', JSON.stringify(db.prepare('SELECT * FROM event_origins').all()))
} catch (e) {
  console.log('origins err:', (e as Error).message)
}
