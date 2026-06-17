# SQLite → PostgreSQL Conversion Notes

## Key Differences

### Placeholder syntax
- SQLite: `?` positional placeholders
- PostgreSQL: `$1, $2, ...` numbered placeholders
- **Handled by:** `convertPlaceholders()` in `connection.js`

### Date/Time functions
- SQLite: `datetime('now')`, `datetime('now', '-N days')`
- PostgreSQL: `CURRENT_TIMESTAMP`, `NOW() - INTERVAL 'N days'`
- **Strategy:** Use JavaScript `now()` helper and pass timestamps as parameters instead of DB functions

### AUTOINCREMENT
- SQLite: `INTEGER PRIMARY KEY AUTOINCREMENT`
- PostgreSQL: `SERIAL` or `BIGSERIAL`
- **Our schema:** Uses `TEXT PRIMARY KEY` with JS-generated IDs, so no AUTOINCREMENT needed

### INSERT OR IGNORE
- SQLite: `INSERT OR IGNORE INTO ...`
- PostgreSQL: `INSERT INTO ... ON CONFLICT DO NOTHING`
- **Note:** Legacy JSON migration only — not used in PG mode

### ON CONFLICT (upsert)
- SQLite: `ON CONFLICT(key) DO UPDATE SET ... = excluded.value`
- PostgreSQL: `ON CONFLICT(key) DO UPDATE SET ... = EXCLUDED.value`
- **Both work** — `excluded` is case-insensitive in both engines

### Boolean / Integer
- SQLite: `INTEGER` for booleans (0/1)
- PostgreSQL: Has native `BOOLEAN`, but `INTEGER DEFAULT 0` works too
- **Our schema:** Keep `INTEGER` for boolean fields (email_verified, verified) for compatibility

### TEXT type
- SQLite: `TEXT` for all strings
- PostgreSQL: `TEXT` works identically (unlimited length)
- **Our schema:** All string columns use `TEXT`

### CHECK constraints
- SQLite: `CHECK(role IN ('user','assistant','system'))`
- PostgreSQL: Same syntax supported
- **No changes needed**

### FOREIGN KEY enforcement
- SQLite: Requires `PRAGMA foreign_keys = ON`
- PostgreSQL: Enforced by default
- **No changes needed**

### Schema introspection
- SQLite: `sqlite_master` table
- PostgreSQL: `information_schema.tables` or `pg_class`
- **Not needed in runtime code** — schema integrity checked via `SELECT 1`

### Journal mode
- SQLite: `PRAGMA journal_mode = DELETE` (prevents WAL data loss on deploy)
- PostgreSQL: Uses WAL natively (no equivalent PRAGMA)
- **Not applicable** in PG mode

## Migration Strategy

1. Run `001_init.sql` to create all tables in PostgreSQL
2. Use `scripts/migrate-sqlite-to-pg.js` to copy data row by row
3. Set `DATABASE_URL` env var to switch to PG mode
4. Keep `DATABASE_PATH` for SQLite fallback

## Runtime Compatibility

The `connection.js` module handles all SQL differences transparently:
- Placeholder conversion (`?` → `$1, $2, ...`)
- Async interface for both SQLite and PG
- Mode detection via `DATABASE_URL` env var

Application code should:
- Use `?` placeholders (converted automatically for PG)
- Use `now()` helper instead of `datetime('now')`
- Avoid SQLite-specific functions (`sqlite_master`, `PRAGMA`)
- Use `ON CONFLICT` for upserts (works in both)
