const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// BIGINT (int8) comes back as a string by default. COUNT(*) and the identity
// columns are int8, so parse them to plain numbers like SQLite did.
types.setTypeParser(20, (v) => parseInt(v, 10));

// Connection settings, in order of precedence:
//   1. DATABASE_URL            (postgres://user:pass@host:5432/dbname)
//   2. globals.json            (dbHost, dbPort, dbName, dbUser, dbPassword)
//   3. standard PG* variables  (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD)
const globals = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'globals.json'), 'utf8'));
const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {
            host: globals.dbHost ?? undefined,
            port: globals.dbPort ?? undefined,
            database: globals.dbName ?? undefined,
            user: globals.dbUser ?? undefined,
            password: globals.dbPassword ?? undefined,
        }
);
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

// Timestamps stay as 'YYYY-MM-DD HH:MM:SS' UTC text, exactly what SQLite's
// datetime('now') produced, so string comparisons and API output don't change.
const NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

// get -> first row (or undefined), all -> every row, run -> affected row count.
// Same verbs as better-sqlite3, but async and with $1, $2... placeholders.
function exec(target) {
    return {
        get: async (sql, params = []) => (await target.query(sql, params)).rows[0],
        all: async (sql, params = []) => (await target.query(sql, params)).rows,
        run: async (sql, params = []) => (await target.query(sql, params)).rowCount,
    };
}

const db = { ...exec(pool), pool, NOW };

// db.transaction(async (t, ...args) => {...}) -> async (...args) => result
// `t` has the same get/all/run methods but is pinned to one connection.
db.transaction = (fn) => async (...args) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(exec(client), ...args);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
        throw err;
    } finally {
        client.release();
    }
};

// `seq` replaces SQLite's implicit rowid: a stable insertion order that
// message/DM pagination relies on.
const schema = `
CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT NULL,
    owner_id BIGINT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    joined_at TEXT NOT NULL DEFAULT (${NOW}),
    UNIQUE (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    seq BIGINT GENERATED ALWAYS AS IDENTITY,
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    content TEXT NOT NULL,
    frank TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (${NOW}),
    edited_at TEXT DEFAULT NULL,
    expires_at TEXT DEFAULT NULL,
    burn_after_read INTEGER NOT NULL DEFAULT 0,
    viewed INTEGER NOT NULL DEFAULT 0,
    reply_to_id TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by BIGINT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (${NOW}),
    expires_at TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    username TEXT NOT NULL,
    pfp TEXT DEFAULT NULL,
    updated_at TEXT NOT NULL DEFAULT (${NOW}),
    last_active TEXT DEFAULT NULL,
    auto_delete_after_days INTEGER DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS user_keys (
    user_id     BIGINT PRIMARY KEY,
    public_key  TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    verified_at TEXT DEFAULT NULL,
    created_at  TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS channel_keys (
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL,
    wrapped_key TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS dms (
    seq             BIGINT GENERATED ALWAYS AS IDENTITY,
    id              TEXT PRIMARY KEY,
    sender_id       BIGINT NOT NULL,
    recipient_id    BIGINT NOT NULL,
    content         TEXT NOT NULL,
    encryption_mode TEXT NOT NULL DEFAULT 'none',
    expires_at      TEXT DEFAULT NULL,
    burn_after_read INTEGER NOT NULL DEFAULT 0,
    viewed          INTEGER NOT NULL DEFAULT 0,
    reply_to_id     TEXT DEFAULT NULL,
    created_at      TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS dm_settings (
    user_a          BIGINT NOT NULL,
    user_b          BIGINT NOT NULL,
    encryption_mode TEXT NOT NULL DEFAULT 'none',
    PRIMARY KEY (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS dm_keys (
    user_a      BIGINT NOT NULL,
    user_b      BIGINT NOT NULL,
    user_id     BIGINT NOT NULL,
    wrapped_key TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (${NOW}),
    PRIMARY KEY (user_a, user_b, user_id)
);

CREATE TABLE IF NOT EXISTS pins (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    pinned_by  BIGINT NOT NULL,
    pinned_at  TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS dm_reads (
    user_id      BIGINT NOT NULL,
    partner_id   BIGINT NOT NULL,
    last_read_at TEXT NOT NULL DEFAULT (${NOW}),
    PRIMARY KEY (user_id, partner_id)
);

CREATE TABLE IF NOT EXISTS channel_reads (
    user_id      BIGINT NOT NULL,
    channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_at TEXT NOT NULL DEFAULT (${NOW}),
    PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS reports (
    id             TEXT PRIMARY KEY,
    message_id     TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    server_id      TEXT NOT NULL,
    reporter_id    BIGINT NOT NULL,
    content        TEXT NOT NULL,
    frank_verified INTEGER DEFAULT NULL,
    reported_at    TEXT NOT NULL DEFAULT (${NOW})
);

CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
CREATE INDEX IF NOT EXISTS idx_memberships_server ON memberships(server_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_invites_server ON invites(server_id);
CREATE INDEX IF NOT EXISTS idx_user_keys_verified ON user_keys(verified_at);
CREATE INDEX IF NOT EXISTS idx_dms_recipient ON dms(recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dms_sender ON dms(sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pins_channel ON pins(channel_id, pinned_at);
CREATE INDEX IF NOT EXISTS idx_reports_server ON reports(server_id);
`;

// Resolves once the schema exists. index.js waits on this before listening.
// An advisory lock keeps two instances booting at once from racing on CREATE.
db.ready = (async () => {
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock(727001)');
        await client.query(schema);
    } finally {
        try { await client.query('SELECT pg_advisory_unlock(727001)'); } catch { /* released on disconnect */ }
        client.release();
    }
})();

module.exports = db;
