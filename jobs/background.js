const db = require('../database/helpers');
const typing = require('../utils/typing');

// Runs every 60 seconds: delete expired messages and DMs, sweep stale typing state
setInterval(async () => {
    try {
        await db.deleteExpiredMessages();
        await db.deleteExpiredDms();
        typing.sweep();
    } catch (err) {
        console.error('[expiry job]', err.message);
    }
}, 60 * 1000);

// Runs every 24 hours: dead man's switch
const DAY_MS = 24 * 60 * 60 * 1000;
async function runDeadMansSwitch() {
    try {
        const targets = await db.getUsersForDeletion();
        for (const { id } of targets) {
            await db.deleteUserAndData(id);
            console.log(`[dead man's switch] deleted user ${id}`);
        }
    } catch (err) {
        console.error('[dead man\'s switch]', err.message);
    }
}
// run once on startup (after the schema exists) to catch any overdue accounts
db.ready.then(runDeadMansSwitch, () => { /* index.js reports and exits on db failure */ });
setInterval(runDeadMansSwitch, DAY_MS);
