const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./spam.db');

db.serialize(() => {
    // 1. Warnings
    db.run(`CREATE TABLE IF NOT EXISTS warnings (
        group_id TEXT,
        user_id TEXT,
        count INTEGER DEFAULT 0,
        PRIMARY KEY(group_id, user_id)
    )`);

    // 2. Settings
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        group_id TEXT,
        key TEXT,
        value INTEGER,
        PRIMARY KEY(group_id, key)
    )`);

    // 3. VIPs
    db.run(`CREATE TABLE IF NOT EXISTS vips (
        group_id TEXT,
        user_id TEXT,
        PRIMARY KEY(group_id, user_id)
    )`);

    // 4. Content
    db.run(`CREATE TABLE IF NOT EXISTS content (
        group_id TEXT,
        type TEXT, 
        text_content TEXT, 
        image_path TEXT,
        PRIMARY KEY(group_id, type)
    )`);

    // 5. Daily Stats & Activation Status
    db.run(`CREATE TABLE IF NOT EXISTS daily_stats (
        group_id TEXT PRIMARY KEY, 
        group_name TEXT, 
        msg_count INTEGER DEFAULT 0, 
        violation_count INTEGER DEFAULT 0, 
        kick_count INTEGER DEFAULT 0
    )`);
});

module.exports = {
    // --- Activation Check (NEW) ---
    isGroupActive: (groupId) => {
        return new Promise((resolve) => {
            // Checks if a row exists for this group in stats (created by !set groupname)
            db.get("SELECT group_name FROM daily_stats WHERE group_id = ?", [groupId], (err, row) => {
                resolve(!!row); // Returns true if active, false if not
            });
        });
    },

    // --- Warnings ---
    addWarning: (groupId, userId) => {
        return new Promise((resolve) => {
            db.get("SELECT count FROM warnings WHERE group_id = ? AND user_id = ?", [groupId, userId], (err, row) => {
                let newCount = (row ? row.count : 0) + 1;
                if (row) {
                    db.run("UPDATE warnings SET count = ? WHERE group_id = ? AND user_id = ?", [newCount, groupId, userId]);
                } else {
                    db.run("INSERT INTO warnings (group_id, user_id, count) VALUES (?, ?, ?)", [groupId, userId, newCount]);
                }
                resolve(newCount);
            });
        });
    },
    resetWarnings: (groupId, userId) => {
        return new Promise((resolve) => {
            db.run("DELETE FROM warnings WHERE group_id = ? AND user_id = ?", [groupId, userId], () => resolve(true));
        });
    },

    // --- Strictness ---
    setStrictness: (groupId, level) => {
        return new Promise((resolve) => {
            db.run(`INSERT INTO settings (group_id, key, value) VALUES (?, 'strictness', ?) 
                    ON CONFLICT(group_id, key) DO UPDATE SET value=excluded.value`, 
                    [groupId, level], resolve);
        });
    },
    getStrictness: (groupId) => {
        return new Promise((resolve) => {
            db.get("SELECT value FROM settings WHERE group_id = ? AND key = 'strictness'", [groupId], (err, row) => {
                resolve(row ? row.value : 1); 
            });
        });
    },

    // --- VIPs ---
    addVip: (groupId, userId) => new Promise(r => db.run("INSERT OR IGNORE INTO vips (group_id, user_id) VALUES (?, ?)", [groupId, userId], r)),
    removeVip: (groupId, userId) => new Promise(r => db.run("DELETE FROM vips WHERE group_id = ? AND user_id = ?", [groupId, userId], r)),
    isVip: (groupId, userId) => new Promise(r => db.get("SELECT user_id FROM vips WHERE group_id = ? AND user_id = ?", [groupId, userId], (e, row) => r(!!row))),

    // --- Content ---
    setContent: (groupId, type, text, imagePath) => {
        return new Promise(r => {
            db.run(`INSERT INTO content (group_id, type, text_content, image_path) VALUES (?, ?, ?, ?) 
                    ON CONFLICT(group_id, type) DO UPDATE SET text_content=excluded.text_content, image_path=excluded.image_path`,
                [groupId, type, text, imagePath], r);
        });
    },
    getContent: (groupId, type) => {
        return new Promise(r => db.get("SELECT text_content, image_path FROM content WHERE group_id = ? AND type = ?", [groupId, type], (e, row) => r(row)));
    },

    // --- Stats & Activation ---
    updateStat: (groupId, groupName, type) => {
        const col = type === 'msg' ? 'msg_count' : (type === 'violation' ? 'violation_count' : 'kick_count');
        db.get("SELECT group_id FROM daily_stats WHERE group_id = ?", [groupId], (err, row) => {
            if (row) {
                db.run(`UPDATE daily_stats SET ${col} = ${col} + 1 WHERE group_id = ?`, [groupId]);
            } else {
                // NOTE: We do NOT insert new rows here anymore. 
                // Rows are only created by !set groupname. 
                // This prevents "inactive" groups from being tracked.
            }
        });
    },
    setGroupName: (groupId, name) => {
        return new Promise(r => {
            db.run(`INSERT INTO daily_stats (group_id, group_name) VALUES (?, ?) 
                    ON CONFLICT(group_id) DO UPDATE SET group_name=excluded.group_name`, 
                    [groupId, name], r);
        });
    },
    getDailyStats: () => new Promise(r => db.all("SELECT * FROM daily_stats", (e, rows) => r(rows || []))),
    resetDailyStats: () => new Promise(r => db.run("UPDATE daily_stats SET msg_count=0, violation_count=0, kick_count=0", r))
};
