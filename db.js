const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./spam.db');

// Initialize Tables
db.serialize(() => {
    // Groups: Stores settings like strictness (0=Off, 1=No Links, 2=No Images)
    db.run(`CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, 
        name TEXT, 
        active INTEGER DEFAULT 0,
        strictness INTEGER DEFAULT 0 
    )`);

    // Content: Stores Rules and Welcome messages
    db.run(`CREATE TABLE IF NOT EXISTS content (
        group_id TEXT, 
        type TEXT, 
        text_content TEXT, 
        image_path TEXT,
        PRIMARY KEY (group_id, type)
    )`);

    // Stats: Counts messages for the daily PDF
    db.run(`CREATE TABLE IF NOT EXISTS stats (
        group_id TEXT, 
        date TEXT, 
        msg_count INTEGER DEFAULT 0, 
        violation_count INTEGER DEFAULT 0, 
        kick_count INTEGER DEFAULT 0,
        PRIMARY KEY (group_id, date)
    )`);

    // Warnings: Tracks strikes for users (3 strikes = kick)
    db.run(`CREATE TABLE IF NOT EXISTS warnings (
        group_id TEXT, 
        user_id TEXT, 
        count INTEGER DEFAULT 0,
        PRIMARY KEY (group_id, user_id)
    )`);

    // VIPs: Users who are immune to rules
    db.run(`CREATE TABLE IF NOT EXISTS vips (
        group_id TEXT, 
        user_id TEXT, 
        PRIMARY KEY (group_id, user_id)
    )`);
});

// --- HELPER FUNCTIONS ---

const getToday = () => new Date().toISOString().split('T')[0];

module.exports = {
    // Group Management
    isGroupActive: (id) => new Promise(r => db.get("SELECT active FROM groups WHERE id = ?", [id], (err, row) => r(row ? row.active : 0))),
    setGroupName: (id, name) => db.run("INSERT OR REPLACE INTO groups (id, name, active) VALUES (?, ?, 1)", [id, name]),
    getStrictness: (id) => new Promise(r => db.get("SELECT strictness FROM groups WHERE id = ?", [id], (err, row) => r(row ? row.strictness : 0))),
    setStrictness: (id, level) => db.run("UPDATE groups SET strictness = ? WHERE id = ?", [level, id]),

    // Content (Rules/Welcome)
    getContent: (id, type) => new Promise(r => db.get("SELECT * FROM content WHERE group_id = ? AND type = ?", [id, type], (err, row) => r(row))),
    setContent: (id, type, text, img) => db.run("INSERT OR REPLACE INTO content (group_id, type, text_content, image_path) VALUES (?, ?, ?, ?)", [id, type, text, img]),

    // Stats & Strikes
    updateStat: (id, _, col) => {
        const date = getToday();
        db.run(`INSERT OR IGNORE INTO stats (group_id, date) VALUES (?, ?)`, [id, date], () => {
            db.run(`UPDATE stats SET ${col}_count = ${col}_count + 1 WHERE group_id = ? AND date = ?`, [id, date]);
        });
    },
    getDailyStats: () => new Promise(r => db.all("SELECT groups.name as group_name, stats.* FROM stats LEFT JOIN groups ON stats.group_id = groups.id WHERE date = ?", [getToday()], (err, rows) => r(rows || []))),
    resetDailyStats: () => {}, // Kept for logic compatibility, stats persist in DB

    addWarning: (gid, uid) => new Promise(r => {
        db.get("SELECT count FROM warnings WHERE group_id = ? AND user_id = ?", [gid, uid], (err, row) => {
            const newCount = (row ? row.count : 0) + 1;
            db.run("INSERT OR REPLACE INTO warnings (group_id, user_id, count) VALUES (?, ?, ?)", [gid, uid, newCount]);
            r(newCount);
        });
    }),
    resetWarnings: (gid, uid) => db.run("DELETE FROM warnings WHERE group_id = ? AND user_id = ?", [gid, uid]),

    // VIPs
    isVip: (gid, uid) => new Promise(r => db.get("SELECT 1 FROM vips WHERE group_id = ? AND user_id = ?", [gid, uid], (err, row) => r(!!row))),
    addVip: (gid, uid) => db.run("INSERT OR IGNORE INTO vips (group_id, user_id) VALUES (?, ?)", [gid, uid]),
    removeVip: (gid, uid) => db.run("DELETE FROM vips WHERE group_id = ? AND user_id = ?", [gid, uid]),
    
    // Testing
    getAllGroups: () => new Promise(r => db.all("SELECT * FROM groups", [], (err, rows) => r(rows)))
};
