const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const schedule = require('node-schedule'); 
const PDFDocument = require('pdfkit');     
const db = require('./db');

fs.ensureDirSync('./media');

// ==========================================
// ⚙️ CONFIGURATION ZONE
// ==========================================

const DEVELOPER_NUMBER = '27000000000@s.whatsapp.net'; 
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
// 🧠 STATE MEMORY
// ==========================================
let pendingUpdates = {};    // { 'admin_id': 'rules' }
let commandCooldowns = {};  // Public command limits
let floodTracker = {};      // Spam detection
let adminContext = {};      // { 'admin_id': 'TARGET_GROUP_JID' } -> Who is controlling what?
let adminGroupCache = {};   // { 'admin_id': [list_of_groups] } -> For menu selection

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
            console.log('✅ Remote Control Bot Active.');
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
        const isGroup = remoteJid.endsWith('@g.us');

        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();
        const lowerText = text.toLowerCase();

        // =======================================================
        // 🏢 GROUP HANDLER (Security & Public Commands Only)
        // =======================================================
        if (isGroup) {
            
            // 1. CHECK ACTIVATION (Gatekeeper)
            const isActive = await db.isGroupActive(remoteJid);
            if (!isActive) return; // Silent mode until activated via DM

            // 2. STATS
            try { db.updateStat(remoteJid, "EXISTING", 'msg'); } catch (e) {}

            // 3. PUBLIC COMMANDS (Anyone can use)
            const checkCooldown = (key) => {
                const lastUsed = commandCooldowns[key] || 0;
                const now = Date.now();
                if (now - lastUsed < COOLDOWN_TIME) return false;
                commandCooldowns[key] = now;
                return true;
            };

            if (lowerText === '!rules') {
                if (!checkCooldown(`${remoteJid}_rules`)) return;
                const content = await db.getContent(remoteJid, 'rules');
                if (content?.image_path && fs.existsSync(content.image_path)) {
                    await sock.sendMessage(remoteJid, { image: { url: content.image_path }, caption: content.text_content });
                } else await sock.sendMessage(remoteJid, { text: content?.text_content || "No rules set." });
                return;
            }

            if (lowerText === '!welcome') {
                if (!checkCooldown(`${remoteJid}_welcome`)) return;
                const content = await db.getContent(remoteJid, 'welcome');
                if (content?.image_path && fs.existsSync(content.image_path)) {
                    await sock.sendMessage(remoteJid, { image: { url: content.image_path }, caption: content.text_content });
                } else await sock.sendMessage(remoteJid, { text: content?.text_content || "No welcome message." });
                return;
            }

            // 4. SECURITY CHECKS (Admins/VIPs Immune)
            // We fetch the admin status just for immunity check
            let isAdmin = false;
            try {
                const meta = await sock.groupMetadata(remoteJid);
                const participant = meta.participants.find(p => p.id === sender);
                isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
            } catch (e) {}

            const isVip = await db.isVip(remoteJid, sender);
            if (isAdmin || isVip) return; 

            // -- Security Logic --
            const groupStrictness = await db.getStrictness(remoteJid);
            let violationReason = null;

            // Flood
            const floodKey = `${remoteJid}_${sender}`;
            const now = Date.now();
            const userFlood = floodTracker[floodKey] || { count: 0, lastTime: 0 };
            if (now - userFlood.lastTime > FLOOD_WINDOW) { userFlood.count = 1; userFlood.lastTime = now; }
            else { userFlood.count++; }
            floodTracker[floodKey] = userFlood;
            if (userFlood.count > FLOOD_LIMIT) violationReason = "Spam Flooding";

            // Profanity
            if (!violationReason) {
                const swearRegex = new RegExp(`\\b(${BAD_WORDS.join('|')})\\b`, 'i');
                if (swearRegex.test(lowerText)) violationReason = "Profanity";
            }

            // Links
            if (!violationReason && groupStrictness > 0) {
                if (groupStrictness === 1 && /(t\.me|telegram\.me|chat\.whatsapp\.com|discord\.gg)/gi.test(lowerText)) violationReason = "Spam Link";
                else if (groupStrictness === 2 && /(https?:\/\/|www\.)/gi.test(lowerText)) violationReason = "Unauthorized Link";
            }

            if (violationReason) {
                try {
                    db.updateStat(remoteJid, "EXISTING", 'violation');
                    try { await sock.sendMessage(remoteJid, { delete: msg.key }); } catch (e) {}
                    const strikes = await db.addWarning(remoteJid, sender);
                    if (strikes >= 3) {
                        db.updateStat(remoteJid, "EXISTING", 'kick');
                        await sock.sendMessage(remoteJid, { text: `🚫 @${sender.split('@')[0]} removed for ${violationReason}.`, mentions: [sender] });
                        await sock.groupParticipantsUpdate(remoteJid, [sender], "remove");
                        db.resetWarnings(remoteJid, sender);
                    } else {
                        const warnMsg = await sock.sendMessage(remoteJid, { text: `⚠️ @${sender.split('@')[0]} Warning! ${violationReason} detected. Strike ${strikes}/3.`, mentions: [sender] });
                        setTimeout(() => sock.sendMessage(remoteJid, { delete: warnMsg.key }).catch(()=>{}), 10000);
                    }
                } catch (e) {}
            }
            return; // END OF GROUP LOGIC
        }

        // =======================================================
        // 🎮 DM HANDLER (Admin Remote Control)
        // =======================================================
        if (!isGroup) {
            
            // 1. PENDING CONTENT UPDATES (Rules/Welcome)
            if (pendingUpdates[sender]) {
                const targetGroup = adminContext[sender];
                if (!targetGroup) {
                    await sock.sendMessage(remoteJid, { text: "⚠️ Error: Connection lost. Select a group again with !groups" });
                    delete pendingUpdates[sender];
                    return;
                }

                const updateType = pendingUpdates[sender];
                let imagePath = null;
                let finalCaption = text;

                if (msg.message.imageMessage) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                        const safeGroup = targetGroup.replace('@g.us', '');
                        imagePath = `./media/${safeGroup}_${updateType}.jpg`; 
                        await fs.writeFile(imagePath, buffer);
                    } catch (e) {}
                }

                await db.setContent(targetGroup, updateType, finalCaption, imagePath);
                await sock.sendMessage(remoteJid, { text: `✅ ${updateType} updated for the target group!` });
                
                // Optional: Post it immediately to group to confirm?
                // await sock.sendMessage(targetGroup, { text: `📢 New ${updateType} posted!` });
                
                delete pendingUpdates[sender];
                return;
            }

            // 2. REMOTE COMMANDS
            const args = text.split(' ');
            const command = args[0].toLowerCase();

            // --- A. CONNECTION COMMANDS ---

            if (command === '!groups') {
                try {
                    const allGroups = await sock.groupFetchAllParticipating();
                    let adminGroups = [];
                    
                    // Filter: Only groups where SENDER is an Admin
                    for (const [jid, metadata] of Object.entries(allGroups)) {
                        const participant = metadata.participants.find(p => p.id === sender);
                        if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
                            adminGroups.push({ id: jid, subject: metadata.subject });
                        }
                    }

                    if (adminGroups.length === 0) {
                        return await sock.sendMessage(remoteJid, { text: "❌ You are not an admin in any groups I am in." });
                    }

                    adminGroupCache[sender] = adminGroups;
                    
                    let menu = "📋 *Your Admin Groups:*\nReply with `!use <number>` to select one.\n\n";
                    adminGroups.forEach((g, i) => {
                        menu += `${i + 1}. ${g.subject}\n`;
                    });
                    
                    await sock.sendMessage(remoteJid, { text: menu });
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: "❌ Error fetching groups." });
                }
                return;
            }

            if (command === '!use') {
                const index = parseInt(args[1]) - 1;
                const cached = adminGroupCache[sender];
                
                if (!cached || !cached[index]) {
                    return await sock.sendMessage(remoteJid, { text: "⚠️ Invalid number. Use !groups first." });
                }

                const selectedGroup = cached[index];
                adminContext[sender] = selectedGroup.id;
                
                // Auto-Activate if not active
                const isActive = await db.isGroupActive(selectedGroup.id);
                if (!isActive) {
                    await db.setGroupName(selectedGroup.id, selectedGroup.subject); // Default name
                }

                await sock.sendMessage(remoteJid, { text: `🎮 Connected to: *${selectedGroup.subject}*\n\nCommands you type now will apply to that group.` });
                return;
            }

            // --- B. CONTEXT CHECK ---
            // Everything below requires a selected group
            const targetGroup = adminContext[sender];
            if (!targetGroup) {
                if (command.startsWith('!')) await sock.sendMessage(remoteJid, { text: "⚠️ No group connected. Send `!groups` then `!use <number>`." });
                return;
            }

            // --- C. MANAGEMENT COMMANDS ---

            switch (command) {
                case '!ping':
                    await sock.sendMessage(remoteJid, { text: "🏓 Bot is responsive." });
                    return;

                case '!set':
                    // !set groupname My Cool Group
                    if (args[1] === 'groupname') {
                        const newName = text.split(' ').slice(2).join(' ');
                        await db.setGroupName(targetGroup, newName);
                        await sock.sendMessage(remoteJid, { text: `✅ Target group reporting name set to: *${newName}*` });
                    }
                    return;

                case '!strict':
                    const level = parseInt(args[1]);
                    if ([0, 1, 2].includes(level)) {
                        await db.setStrictness(targetGroup, level);
                        await sock.sendMessage(remoteJid, { text: `✅ Strictness set to Level ${level} for the group.` });
                    }
                    return;

                case '!vip':
                    // In DM, user likely types "!vip 2783..." or shares a contact. 
                    // To keep it simple, let's assume they copy-paste the JID or number.
                    // Or easier: "Reply to this message with the contact" (too complex).
                    // Simple Regex for number:
                    const num = text.match(/\d+/g)?.join('');
                    if (num && num.length > 9) {
                        const vipJid = num + "@s.whatsapp.net";
                        await db.addVip(targetGroup, vipJid);
                        await sock.sendMessage(remoteJid, { text: `✅ Added ${num} to VIP.` });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "⚠️ Usage: !vip 27831234567" });
                    }
                    return;

                case '!updaterules':
                    pendingUpdates[sender] = 'rules';
                    await sock.sendMessage(remoteJid, { text: "📝 Send the new Rules text/image now." });
                    return;

                case '!updatewelcome':
                    pendingUpdates[sender] = 'welcome';
                    await sock.sendMessage(remoteJid, { text: "👋 Send the new Welcome text/image now." });
                    return;

                // --- D. PUBLIC POSTING COMMANDS ---
                // "Commands like rules and welcome return etc are shown in the groups"
                
                case '!rules':
                    const rContent = await db.getContent(targetGroup, 'rules');
                    if (rContent) {
                        if (rContent.image_path && fs.existsSync(rContent.image_path)) {
                            await sock.sendMessage(targetGroup, { image: { url: rContent.image_path }, caption: rContent.text_content });
                        } else await sock.sendMessage(targetGroup, { text: rContent.text_content || "No rules." });
                        await sock.sendMessage(remoteJid, { text: "✅ Rules posted to group." });
                    } else await sock.sendMessage(remoteJid, { text: "⚠️ No rules content set yet." });
                    return;

                case '!welcome':
                    const wContent = await db.getContent(targetGroup, 'welcome');
                    if (wContent) {
                        if (wContent.image_path && fs.existsSync(wContent.image_path)) {
                            await sock.sendMessage(targetGroup, { image: { url: wContent.image_path }, caption: wContent.text_content });
                        } else await sock.sendMessage(targetGroup, { text: wContent.text_content || "No welcome." });
                        await sock.sendMessage(remoteJid, { text: "✅ Welcome posted to group." });
                    } else await sock.sendMessage(remoteJid, { text: "⚠️ No welcome content set yet." });
                    return;
            }
        }
    });
}

function setupDailyReport(sock) {
    schedule.scheduleJob(REPORT_TIME, async () => {
        const stats = await db.getDailyStats();
        if (stats.length === 0) return;
        const doc = new PDFDocument();
        const filePath = './media/daily_report.pdf';
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);
        doc.fontSize(20).text(`Daily Security Report`, { align: 'center' });
        doc.moveDown();
        stats.forEach((group, index) => {
            doc.fontSize(12).font('Helvetica-Bold').text(`${index + 1}. ${group.group_name}`);
            doc.fontSize(10).font('Helvetica')
               .text(`   - Messages: ${group.msg_count}`)
               .text(`   - Blocked: ${group.violation_count}`)
               .text(`   - Kicked: ${group.kick_count}`);
            doc.moveDown();
        });
        doc.end();
        stream.on('finish', async () => {
            try {
                await sock.sendMessage(DEVELOPER_NUMBER, { 
                    document: fs.readFileSync(filePath), 
                    mimetype: 'application/pdf', 
                    fileName: `Report_${new Date().toISOString().split('T')[0]}.pdf`
                });
                await db.resetDailyStats();
            } catch (err) {}
        });
    });
}

startBot();
