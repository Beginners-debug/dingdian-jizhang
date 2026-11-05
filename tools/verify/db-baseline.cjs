const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('server/data/mintlite.db', { readOnly: true });
const all = (s, ...p) => db.prepare(s).all(...p);
const led = all('select id, name from ledgers where deleted_at is null');
for (const l of led) {
  console.log(
    JSON.stringify({
      ledger: l.name,
      id: l.id.slice(0, 8),
      tx: all('select count(*) n from transactions where ledger_id=? and deleted_at is null', l.id)[0].n,
      mint: all(
        "select count(*) n from transactions where ledger_id=? and deleted_at is null and external_id like 'mint:%'",
        l.id,
      )[0].n,
      accounts: all('select count(*) n from accounts where ledger_id=? and deleted_at is null', l.id)[0].n,
      tags: all('select count(*) n from tags where ledger_id=? and deleted_at is null', l.id)[0].n,
      members: all('select name from members where ledger_id=? and deleted_at is null', l.id).map((r) => r.name),
      categories: all('select count(*) n from categories where ledger_id=? and deleted_at is null', l.id)[0].n,
    }),
  );
}
console.log(
  'orphans(ledger deleted):',
  JSON.stringify(
    all(
      'select l.name, count(t.id) n from ledgers l left join transactions t on t.ledger_id=l.id and t.deleted_at is null where l.deleted_at is not null group by l.id',
    ),
  ),
);
db.close();
