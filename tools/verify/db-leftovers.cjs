const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('server/data/mintlite.db', { readOnly: true });
const lid = db.prepare('select id from ledgers where deleted_at is null').get().id;
const all = (s, ...p) => db.prepare(s).all(...p);
console.log('accounts:');
for (const a of all('select id,name,type,kind,balance_cents,include_in_net from accounts where ledger_id=? and deleted_at is null', lid)) {
  const n = all('select count(*) n from transactions where ledger_id=? and deleted_at is null and (account_id=? or to_account_id=?)', lid, a.id, a.id)[0].n;
  console.log('  ', JSON.stringify({ ...a, tx: n }));
}
console.log('tags:');
for (const t of all('select id,name from tags where ledger_id=? and deleted_at is null', lid)) {
  const n = all('select count(*) n from transaction_tags tt join transactions t on t.id=tt.transaction_id where t.ledger_id=? and t.deleted_at is null and tt.tag_id=?', lid, t.id)[0].n;
  console.log('  ', JSON.stringify({ ...t, tx: n }));
}
console.log('categories without tx:');
for (const c of all('select id,name from categories where ledger_id=? and deleted_at is null', lid)) {
  const n = all('select count(*) n from transactions where ledger_id=? and deleted_at is null and category_id=?', lid, c.id)[0].n;
  if (!n) console.log('  ', JSON.stringify({ ...c, tx: 0 }));
}
db.close();
