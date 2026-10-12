// A stand-in for Cloudflare D1 built on sql.js (SQLite in WebAssembly), so the Worker can be tested anywhere.
import initSqlJs from 'sql.js';

export async function makeD1() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const fix = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  class Stmt {
    constructor(sql, args) { this.sql = sql; this.args = args || []; }
    bind(...a) { return new Stmt(this.sql, fix(a)); }
    rows() { const st = db.prepare(this.sql); st.bind(this.args); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
    exec() { if (/returning/i.test(this.sql)) return { results: this.rows(), meta: { changes: 1 } }; db.run(this.sql, this.args); return { meta: { changes: db.getRowsModified() } }; }
    async first(col) { const r = this.rows()[0]; if (!r) return null; return col ? r[col] : r; }
    async all() { return { results: this.rows(), success: true }; }
    async run() { return this.exec(); }
  }
  return {
    raw: db,
    prepare: sql => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => (/^\s*select/i.test(s.sql) ? { results: s.rows() } : s.exec())); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  };
}
