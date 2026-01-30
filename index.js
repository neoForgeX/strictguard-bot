const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const schedule = require('node-schedule'); 
const PDFDocument = require('pdfkit');     
const db = require('./db');

// Ensure media folder exists
fs.ensureDirSync('./media');

// ==========================================
// ⚙️ CONFIGURATION ZONE
// ==========================================

const DEVELOPER_NUMBER = '27812345678@s.whatsapp.net'; 
const REPORT_TIME = '59 23 * * *'; 

// Spam Flood Settings
const FLOOD_WINDOW = 8000;  
const FLOOD_LIMIT = 5;      

const BAD_WORDS = [
    'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'dick', 'pussy', 'bastard', 
    'whore', 'slut', 'cock', 'bollocks', 'wanker', 'piss', 'crap', 'douche', 
    'fag', 'twat', 'prick', 'arse', 'motherfucker', 'dumbass', 'jackass', 
    'nigger', 'nigga', 'faggot', 'retard', 
    'crypto', 'investment', 'forex', 'binance', 'bitcoin'
];

const COOLDOWN_TIME = 5 * 60 * 1000; 

// ==========================================
// 🧠 STATE MEMORY (Per Group)
// ==========================================
let pendingUpdates = {}; 
let commandCooldowns = {}; 
let floodTracker = {}; 

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["StrictGuard Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot is connected. Waiting for activation commands...');
            setupDailyReport(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        if (msg.key.fromMe) return; 

        const remoteJid = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        if (!remoteJid.endsWith('@g.us')) return; 

        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();
        const lowerText = text.toLowerCase();

        // ===============================================
        // 🚪 GATEKEEPER (ACTIVATION CHECK)
        // ===============================================
        
        // 1. Is this an activation command?
        const isActivationCommand = lowerText.startsWith('!set groupname');
        
        // 2. Is the group already active?
        const isActive = await db.isGroupActive(remoteJid);

        // 3. The Logic: 
        // If it's NOT active AND it's NOT an activation command -> Ignore completely.
        if (!isActive && !isActivationCommand) {
            return; 
        }

        // ===============================================
        // 🤖 BOT LOGIC (Only runs if passed Gatekeeper)
        // ===============================================

        // 1. UPDATE STATS
        try {
            // We pass a dummy name here because db.updateStat now ONLY updates existing rows.
            // It won't create new rows for inactive groups.
            db.updateStat(remoteJid, "EXISTING", 'msg');
        } catch (e) {}

        // 2. ADMIN CHECK
        const getAdminStatus = async () => {
            try {
                const meta = await sock.groupMetadata(remoteJid);
                const participant = meta.participants.find(p => p.id === sender);
                return participant?.admin === 'admin' || participant?.admin === 'superadmin';
            } catch (e) { return false; }
        };
        const isAdmin = await getAdminStatus();

        // 3. PENDING UPDATES (Per Admin)
        if (isAdmin && pendingUpdates[sender]) {
            const updateType = pendingUpdates[sender]; 
            let imagePath = null;
            let finalCaption = text;

            if (msg.message.imageMessage) {
                try {
                    const buffer = await downloadMediaMessage(
                        msg, 'buffer', {}, 
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );
                    const safeGroup = remoteJid.replace('@g.us', '');
                    imagePath = `./media/${safeGroup}_${updateType}.jpg`; 
                    await fs.writeFile(imagePath, buffer);
                } catch (e) { console.log("Error downloading media:", e); }
            }
            await db.setContent(remoteJid, updateType, finalCaption, imagePath);
            await sock.sendMessage(remoteJid, { text: `✅ ${updateType} updated for THIS group!` });
            delete pendingUpdates[sender]; 
            return; 
        }

        // 4. ADMIN COMMANDS
        if (text.startsWith('!') && isAdmin) {
            const args = text.split(' ');
            const command = args[0].toLowerCase();

            switch (command) {
                case '!ping':
                    await sock.sendMessage(remoteJid, { text: 'Pong! 🏓 Secured & Active.' });
                    return;

                case '!set': 
                    // Usage: !set groupname My Cool Group
                    if (args[1] === 'groupname') {
                        const newName = text.split(' ').slice(2).join(' '); 
                        if (newName) {
                            await db.setGroupName(remoteJid, newName);
                            await sock.sendMessage(remoteJid, { text: `✅ Activated! Group profile set to: *${newName}*` });
                        } else {
                            await sock.sendMessage(remoteJid, { text: '⚠️ Usage: !set groupname Your Group Name' });
                        }
                    }
                    return;

                case '!strict': 
                    const newLvl = parseInt(args[1]);
                    if ([0, 1, 2].includes(newLvl)) {
                        await db.setStrictness(remoteJid, newLvl);
                        await sock.sendMessage(remoteJid, { text: `✅ Settings Updated: Strictness Level ${newLvl}` });
                    }
                    return;

                case '!vip': 
                    const vipUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (vipUser) {
                        await db.addVip(remoteJid, vipUser);
                        await sock.sendMessage(remoteJid, { text: `✅ Added @${vipUser.split('@')[0]} to VIP list.`, mentions: [vipUser] });
                    }
                    return;

                case '!un-vip': 
                    const unvipUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (unvipUser) {
                        await db.removeVip(remoteJid, unvipUser);
                        await sock.sendMessage(remoteJid, { text: `✅ Removed @${unvipUser.split('@')[0]} from VIPs.`, mentions: [unvipUser] });
                    }
                    return;

                case '!pardon': 
                    const pardonUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (pardonUser) {
                        await db.resetWarnings(remoteJid, pardonUser);
                        await sock.sendMessage(remoteJid, { text: `✅ Strikes reset for @${pardonUser.split('@')[0]}.`, mentions: [pardonUser] });
                    }
                    return;

                case '!updaterules':
                    pendingUpdates[sender] = 'rules';
                    await sock.sendMessage(remoteJid, { text: '📝 *Update Rules:*\nSend text/image in the next message.' });
                    return;

                case '!updatewelcome':
                    pendingUpdates[sender] = 'welcome';
                    await sock.sendMessage(remoteJid, { text: '👋 *Update Welcome:*\nSend text/image in the next message.' });
                    return;
            }
        }

        // 5. PUBLIC COMMANDS
        const checkCooldown = (key) => {
            if (isAdmin) return true; 
            const lastUsed = commandCooldowns[key] || 0;
            const now = Date.now();
            if (now - lastUsed < COOLDOWN_TIME) return false;
            commandCooldowns[key] = now;
            return true;
        };

        if (text.toLowerCase() === '!rules') {
            if (!checkCooldown(`${remoteJid}_rules`)) return; 
            const content = await db.getContent(remoteJid, 'rules');
            if (content) {
                if (content.image_path && fs.existsSync(content.image_path)) {
                    await sock.sendMessage(remoteJid, { image: { url: content.image_path }, caption: content.text_content });
                } else await sock.sendMessage(remoteJid, { text: content.text_content || "No rules set yet." });
            } else await sock.sendMessage(remoteJid, { text: "No rules defined for this group." });
            return;
        }

        if (text.toLowerCase() === '!welcome') {
            if (!checkCooldown(`${remoteJid}_welcome`)) return;
            const content = await db.getContent(remoteJid, 'welcome');
            if (content) {
                if (content.image_path && fs.existsSync(content.image_path)) {
                    await sock.sendMessage(remoteJid, { image: { url: content.image_path }, caption: content.text_content });
                } else await sock.sendMessage(remoteJid, { text: content.text_content || "No welcome message set yet." });
            } else await sock.sendMessage(remoteJid, { text: "No welcome message defined for this group." });
            return;
        }

        // ===============================================
        // 🛡️ SECURITY & PROTECTION LAYERS
        // ===============================================
        
        const isVip = await db.isVip(remoteJid, sender);
        if (isAdmin || isVip) return; 

        // Fetch Group Specific Strictness
        const groupStrictness = await db.getStrictness(remoteJid);
        let violationReason = null;
        
        // --- Layer 1: Flood Protection ---
        const floodKey = `${remoteJid}_${sender}`;
        const now = Date.now();
        const userFlood = floodTracker[floodKey] || { count: 0, lastTime: 0 };
        
        if (now - userFlood.lastTime > FLOOD_WINDOW) {
            userFlood.count = 1;
            userFlood.lastTime = now;
        } else {
            userFlood.count++;
        }
        floodTracker[floodKey] = userFlood;

        if (userFlood.count > FLOOD_LIMIT) {
            violationReason = "Spam Flooding";
        }

        // --- Layer 2: Profanity ---
        if (!violationReason) {
            const swearRegex = new RegExp(`\\b(${BAD_WORDS.join('|')})\\b`, 'i');
            if (swearRegex.test(lowerText)) violationReason = "Profanity";
        }

        // --- Layer 3: Link Check ---
        if (!violationReason && groupStrictness > 0) {
            if (groupStrictness === 1) {
                if (/(t\.me|telegram\.me|chat\.whatsapp\.com|discord\.gg)/gi.test(lowerText)) violationReason = "Spam Link";
            } else if (groupStrictness === 2) {
                if (/(https?:\/\/|www\.)/gi.test(lowerText)) violationReason = "Unauthorized Link";
            }
        }

        // --- PUNISHMENT ---
        if (violationReason) {
            try {
                // Since group is Active, stats row MUST exist.
                db.updateStat(remoteJid, "EXISTING", 'violation');

                try { await sock.sendMessage(remoteJid, { delete: msg.key }); } catch (e) {}

                const strikes = await db.addWarning(remoteJid, sender);
                
                if (strikes >= 3) {
                    db.updateStat(remoteJid, "EXISTING", 'kick');
                    await sock.sendMessage(remoteJid, { text: `🚫 @${sender.split('@')[0]} removed for ${violationReason}.`, mentions: [sender] });
                    await sock.groupParticipantsUpdate(remoteJid, [sender], "remove");
                    db.resetWarnings(remoteJid, sender);
                } else {
                    await sock.sendMessage(remoteJid, { text: `⚠️ @${sender.split('@')[0]} Warning! ${violationReason} detected. Strike ${strikes}/3.`, mentions: [sender] });
                }
            } catch (err) {
                console.log("Error during punishment:", err);
            }
        }
    });
}

// 📊 DAILY REPORT GENERATOR
function setupDailyReport(sock) {
    schedule.scheduleJob(REPORT_TIME, async () => {
        const stats = await db.getDailyStats();
        if (stats.length === 0) return;

        const doc = new PDFDocument();
        const filePath = './media/daily_report.pdf';
        const stream = fs.createWriteStream(filePath);

        doc.pipe(stream);

        doc.fontSize(20).text(`Daily Security Report`, { align: 'center' });
        doc.fontSize(12).text(`Date: ${new Date().toDateString()}`, { align: 'center' });
        doc.moveDown();

        doc.fontSize(14).text('Active Groups Summary', { underline: true });
        doc.moveDown();

        stats.forEach((group, index) => {
            doc.fontSize(12).font('Helvetica-Bold').text(`${index + 1}. ${group.group_name}`);
            doc.fontSize(10).font('Helvetica')
               .text(`   - Messages Processed: ${group.msg_count}`)
               .text(`   - Threats Blocked: ${group.violation_count}`)
               .text(`   - Users Kicked: ${group.kick_count}`);
            doc.moveDown();
        });

        doc.end();

        stream.on('finish', async () => {
            try {
                await sock.sendMessage(DEVELOPER_NUMBER, { 
                    document: fs.readFileSync(filePath), 
                    mimetype: 'application/pdf', 
                    fileName: `Report_${new Date().toISOString().split('T')[0]}.pdf`,
                    caption: "Here is your daily activity report, Sir. 🫡"
                });
                await db.resetDailyStats();
            } catch (err) {
                console.log("Failed to send report:", err);
            }
        });
    });
}

startBot();
