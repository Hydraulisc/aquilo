const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'database.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT NULL,
    owner_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(server_id, user_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    edited_at TEXT DEFAULT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT DEFAULT NULL,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
CREATE INDEX IF NOT EXISTS idx_memberships_server ON memberships(server_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invites_server ON invites(server_id);

CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    username   TEXT NOT NULL,
    pfp        TEXT DEFAULT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_keys (
    user_id     INTEGER PRIMARY KEY,
    public_key  TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    verified_at TEXT DEFAULT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_keys_verified ON user_keys(verified_at);

CREATE TABLE IF NOT EXISTS channel_keys (
    channel_id  TEXT NOT NULL,
    user_id     INTEGER NOT NULL,
    wrapped_key TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (channel_id, user_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dms (
    id              TEXT PRIMARY KEY,
    sender_id       INTEGER NOT NULL,
    recipient_id    INTEGER NOT NULL,
    content         TEXT NOT NULL,
    encryption_mode TEXT NOT NULL DEFAULT 'none',
    expires_at      TEXT DEFAULT NULL,
    burn_after_read INTEGER NOT NULL DEFAULT 0,
    viewed          INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dm_settings (
    user_a          INTEGER NOT NULL,
    user_b          INTEGER NOT NULL,
    encryption_mode TEXT NOT NULL DEFAULT 'none',
    PRIMARY KEY (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS dm_keys (
    user_a      INTEGER NOT NULL,
    user_b      INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    wrapped_key TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_a, user_b, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dms_recipient ON dms(recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dms_sender ON dms(sender_id, created_at);
`);

// Run a named migration once its condition holds
// log only when it actually runs
function migrate(name, condition, fn) {
    if (!condition) return;
    fn();
    console.log(`[migration] applied: ${name}`);
}

// Server no longer holds AES keys 
// encryption is client-side via PGP-wrapped channel keys
const serverKeysCols = db.prepare("PRAGMA table_info(server_keys)").all();
migrate('drop-server_keys', serverKeysCols.length > 0,
    () => db.exec('DROP TABLE server_keys'));

// Migrate messages table
const msgCols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
migrate('messages.expires_at', !msgCols.includes('expires_at'),
    () => db.exec("ALTER TABLE messages ADD COLUMN expires_at TEXT DEFAULT NULL"));
migrate('messages.burn_after_read', !msgCols.includes('burn_after_read'),
    () => db.exec("ALTER TABLE messages ADD COLUMN burn_after_read INTEGER NOT NULL DEFAULT 0"));
migrate('messages.viewed', !msgCols.includes('viewed'),
    () => db.exec("ALTER TABLE messages ADD COLUMN viewed INTEGER NOT NULL DEFAULT 0"));

// Migrate users table
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
migrate('users.last_active', !userCols.includes('last_active'), () => {
    db.exec("ALTER TABLE users ADD COLUMN last_active TEXT DEFAULT NULL");
    db.exec("UPDATE users SET last_active = datetime('now') WHERE last_active IS NULL");
});
migrate('users.auto_delete_after_days', !userCols.includes('auto_delete_after_days'),
    () => db.exec("ALTER TABLE users ADD COLUMN auto_delete_after_days INTEGER DEFAULT NULL"));

// Replies (reference only)
migrate('messages.reply_to_id', !msgCols.includes('reply_to_id'),
    () => db.exec("ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT NULL"));
const dmCols = db.prepare("PRAGMA table_info(dms)").all().map(c => c.name);
migrate('dms.reply_to_id', !dmCols.includes('reply_to_id'),
    () => db.exec("ALTER TABLE dms ADD COLUMN reply_to_id TEXT DEFAULT NULL"));

// Pins and DM read tracking
db.exec(`
CREATE TABLE IF NOT EXISTS pins (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    pinned_by  INTEGER NOT NULL,
    pinned_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pins_channel ON pins(channel_id, pinned_at);

CREATE TABLE IF NOT EXISTS dm_reads (
    user_id      INTEGER NOT NULL,
    partner_id   INTEGER NOT NULL,
    last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, partner_id)
);

CREATE TABLE IF NOT EXISTS channel_reads (
    user_id      INTEGER NOT NULL,
    channel_id   TEXT NOT NULL,
    last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, channel_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
`);

module.exports = db;
