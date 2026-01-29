const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./spam.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS warnings (user_id TEXT PRIMARY KEY, count INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER)`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('strictness', 1)`);
    db.run(`CREATE TABLE IF NOT EXISTS vips (user_id TEXT PRIMARY KEY)`);
    db.run(`CREATE TABLE IF NOT EXISTS content (type TEXT PRIMARY KEY, text_content TEXT, image_path TEXT)`);

    // NEW: Daily Stats Table
    db.run(`CREATE TABLE IF NOT EXISTS daily_stats (
        group_id TEXT PRIMARY KEY, 
        group_name TEXT, 
        msg_count INTEGER DEFAULT 0, 
        violation_count INTEGER DEFAULT 0, 
        kick_count INTEGER DEFAULT 0
    )`);
});

module.exports = {
    // ... (Keep existing export functions: addWarning, setStrictness, etc.) ...
    addWarning: (userId) => new Promise(r => {
        db.get("SELECT count FROM warnings WHERE user_id = ?", [userId], (e, row) => {
            let newCount = (row ? row.count : 0) + 1;
            if (row) db.run("UPDATE warnings SET count = ? WHERE user_id = ?", [newCount, userId]);
            else db.run("INSERT INTO warnings (user_id, count) VALUES (?, ?)", [userId, newCount]);
            r(newCount);
        });
    }),
    resetWarnings: (userId) => new Promise(r => db.run("DELETE FROM warnings WHERE user_id = ?", [userId], () => r(true))),
    setStrictness: (level) => new Promise(r => db.run("UPDATE settings SET value = ? WHERE key = 'strictness'", [level], r)),
    getStrictness: () => new Promise(r => db.get("SELECT value FROM settings WHERE key = 'strictness'", (e, row) => r(row ? row.value : 1))),
    addVip: (userId) => new Promise(r => db.run("INSERT OR IGNORE INTO vips (user_id) VALUES (?)", [userId], r)),
    removeVip: (userId) => new Promise(r => db.run("DELETE FROM vips WHERE user_id = ?", [userId], r)),
    isVip: (userId) => new Promise(r => db.get("SELECT user_id FROM vips WHERE user_id = ?", [userId], (e, row) => r(!!row))),
    setContent: (type, text, imagePath) => new Promise(r => db.run(`INSERT INTO content (type, text_content, image_path) VALUES (?, ?, ?) ON CONFLICT(type) DO UPDATE SET text_content=excluded.text_content, image_path=excluded.image_path`, [type, text, imagePath], r)),
    getContent: (type) => new Promise(r => db.get("SELECT text_content, image_path FROM content WHERE type = ?", [type], (e, row) => r(row))),

    // --- NEW: STATS LOGIC ---
    updateStat: (groupId, groupName, type) => {
        // type = 'msg' | 'violation' | 'kick'
        const col = type === 'msg' ? 'msg_count' : (type === 'violation' ? 'violation_count' : 'kick_count');
        
        db.get("SELECT group_id FROM daily_stats WHERE group_id = ?", [groupId], (err, row) => {
            if (row) {
                // Update existing row
                db.run(`UPDATE daily_stats SET ${col} = ${col} + 1, group_name = ? WHERE group_id = ?`, [groupName, groupId]);
            } else {
                // Create new row
                db.run(`INSERT INTO daily_stats (group_id, group_name, ${col}) VALUES (?, ?, 1)`, [groupId, groupName]);
            }
        });
    },
    getDailyStats: () => {
        return new Promise((resolve) => {
            db.all("SELECT * FROM daily_stats", (err, rows) => resolve(rows || []));
        });
    },
    resetDailyStats: () => {
        return new Promise((resolve) => {
            db.run("DELETE FROM daily_stats", () => resolve(true));
        });
    }
};
