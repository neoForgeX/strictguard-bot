const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const schedule = require('node-schedule'); 
const PDFDocument = require('pdfkit');     
const db = require('./db');

// Ensure media folder exists
fs.ensureDirSync('./media');

// ⚙️ CONFIGURATION
const DEVELOPER_NUMBER = '27617763264@s.whatsapp.net'; // REPLACE THIS WITH YOUR NUMBER
const REPORT_TIME = '59 23 * * *'; 

let currentStrictness = 1;
const BAD_WORDS = ['idiot', 'scam', 'fool', 'stupid', 'crypto']; 
const COOLDOWN_TIME = 5 * 60 * 1000;

let pendingUpdates = {}; 
let commandCooldowns = {};

async function startBot() {
    currentStrictness = await db.getStrictness();
    console.log(`🔒 Initial Strictness: ${currentStrictness}`);

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
            console.log('✅ Bot is connected!');
            setupDailyReport(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        // 🕵️ SPY LOGGER START 🕵️
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();
        const rawSender = msg.key.participant || msg.key.remoteJid;
        const rawGroup = msg.key.remoteJid;
        
        console.log(`[DEBUG] Received: "${rawText}" | From: ${rawSender} | Group: ${rawGroup}`);
        
        if (msg.key.fromMe) {
            console.log(`[DEBUG] Ignored: Message is from Me (The Bot)`);
            return;
        }
        // 🕵️ SPY LOGGER END 🕵️

        const remoteJid = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        if (!remoteJid.endsWith('@g.us')) return; 

        // 1. UPDATE STATS
        const groupName = (await sock.groupMetadata(remoteJid)).subject;
        db.updateStat(remoteJid, groupName, 'msg');

        const lowerText = rawText.toLowerCase();

        // Admin Status Check
        const getAdminStatus = async () => {
            try {
                const meta = await sock.groupMetadata(remoteJid);
                const participant = meta.participants.find(p => p.id === sender);
                return participant?.admin === 'admin' || participant?.admin === 'superadmin';
            } catch (e) { return false; }
        };
        const isAdmin = await getAdminStatus();

        // ===============================================
        // 🔄 PENDING UPDATE HANDLER
        // ===============================================
        if (isAdmin && pendingUpdates[sender]) {
            const updateType = pendingUpdates[sender]; 
            let imagePath = null;
            let finalCaption = rawText;

            if (msg.message.imageMessage) {
                console.log(`Downloading image for ${updateType}...`);
                const buffer = await downloadMediaMessage(
                    msg, 'buffer', {}, 
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );
                imagePath = `./media/${updateType}.jpg`; 
                await fs.writeFile(imagePath, buffer);
            }

            await db.setContent(updateType, finalCaption, imagePath);
            await sock.sendMessage(remoteJid, { text: `✅ ${updateType} updated successfully!` });
            
            delete pendingUpdates[sender]; 
            return; 
        }

        // ===============================================
        // 🛠️ ADMIN COMMANDS
        // ===============================================
        if (rawText.startsWith('!') && isAdmin) {
            const args = rawText.split(' ');
            const command = args[0].toLowerCase();

            switch (command) {
                case '!ping': // Added for testing
                    await sock.sendMessage(remoteJid, { text: 'Pong! 🏓 I am listening.' });
                    return;

                case '!strict': 
                    const newLvl = parseInt(args[1]);
                    if ([0, 1, 2].includes(newLvl)) {
                        await db.setStrictness(newLvl);
                        currentStrictness = newLvl;
                        await sock.sendMessage(remoteJid, { text: `✅ Strictness set to Level ${newLvl}` });
                    }
                    return;

                case '!vip': 
                    const vipUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (vipUser) {
                        await db.addVip(vipUser);
                        await sock.sendMessage(remoteJid, { text: `✅ Added @${vipUser.split('@')[0]} to VIP list.`, mentions: [vipUser] });
                    } else await sock.sendMessage(remoteJid, { text: '⚠️ Usage: !vip @user' });
                    return;

                case '!un-vip': 
                    const unvipUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (unvipUser) {
                        await db.removeVip(unvipUser);
                        await sock.sendMessage(remoteJid, { text: `✅ Removed @${unvipUser.split('@')[0]} from VIPs.`, mentions: [unvipUser] });
                    }
                    return;

                case '!pardon': 
                    const pardonUser = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (pardonUser) {
                        await db.resetWarnings(pardonUser);
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

        // ===============================================
        // 📢 PUBLIC COMMANDS (With Cooldown)
        // ===============================================
        
        const checkCooldown = (key) => {
            if (isAdmin) return true; 
            const lastUsed = commandCooldowns[key] || 0;
            const now = Date.now();
            if (now - lastUsed < COOLDOWN_TIME) return false;
            commandCooldowns[key] = now;
            return true;
        };

        if (rawText.toLowerCase() === '!rules') {
            const cooldownKey = `${remoteJid}_rules`;
            if (!checkCooldown(cooldownKey)) return; 

            const content = await db.getContent('rules');
            if (content) {
                if (content.image_path && fs.existsSync(content.image_path)) {
                    await sock.sendMessage(remoteJid, { image: { url: content.image_path }, caption: content.text_content });
                } else {
                    await sock.sendMessage(remoteJid, { text: content.text_content || "No rules set yet." });
                }
            } else {
                await sock.sendMessage(remoteJid, { text: "No rules defined yet." });
            }
            return;
        }

        if (rawText.toLowerCase() === '!welcome') {
            const cooldownKey = `${remoteJid}_welcome`;
            if (!checkCooldown(cooldownKey)) return;

            const content = await db.getContent('welcome');
            if (content) {
                if (content.image_path && fs.existsSync(content.image_path)) {
                    await sock.sendMessage(remoteJid, { image: { url: content.image_path }, caption: content.text_content });
                } else {
                    await sock.sendMessage(remoteJid, { text: content.text_content || "No welcome message set yet." });
                }
            } else {
                await sock.sendMessage(remoteJid, { text: "No welcome message defined yet." });
            }
            return;
        }

        // ===============================================
        // 🛡️ SECURITY CHECKS
        // ===============================================
        
        const isVip = await db.isVip(sender);
        if (isAdmin || isVip) return; 

        let violationReason = null;
        const swearRegex = new RegExp(`\\b(${BAD_WORDS.join('|')})\\b`, 'i');
        if (swearRegex.test(lowerText)) violationReason = "Profanity";

        if (!violationReason && currentStrictness > 0) {
            if (currentStrictness === 1) {
                if (/(t\.me|telegram\.me|chat\.whatsapp\.com|discord\.gg)/gi.test(lowerText)) violationReason = "Spam Link";
            } else if (currentStrictness === 2) {
                if (/(https?:\/\/|www\.)/gi.test(lowerText)) violationReason = "Unauthorized Link";
            }
        }

        if (violationReason) {
            console.log(`Violation: ${violationReason}`);
            db.updateStat(remoteJid, groupName, 'violation');

            try { await sock.sendMessage(remoteJid, { delete: msg.key }); } catch (e) {}

            const strikes = await db.addWarning(sender);
            
            if (strikes >= 3) {
                db.updateStat(remoteJid, groupName, 'kick');
                await sock.sendMessage(remoteJid, { text: `🚫 @${sender.split('@')[0]} removed for ${violationReason}.`, mentions: [sender] });
                await sock.groupParticipantsUpdate(remoteJid, [sender], "remove");
                db.resetWarnings(sender);
            } else {
                await sock.sendMessage(remoteJid, { text: `⚠️ @${sender.split('@')[0]} Warning! ${violationReason} detected. Strike ${strikes}/3.`, mentions: [sender] });
            }
        }
    });
}

// 📊 DAILY REPORT GENERATOR
function setupDailyReport(sock) {
    schedule.scheduleJob(REPORT_TIME, async () => {
        console.log("Generating Daily Report...");
        const stats = await db.getDailyStats();
        
        if (stats.length === 0) {
            console.log("No stats to report today.");
            return;
        }

        const doc = new PDFDocument();
        const filePath = './media/daily_report.pdf';
        const stream = fs.createWriteStream(filePath);

        doc.pipe(stream);

        doc.fontSize(20).text(`Daily Security Report`, { align: 'center' });
        doc.fontSize(12).text(`Date: ${new Date().toDateString()}`, { align: 'center' });
        doc.moveDown();

        doc.fontSize(14).text('Group Activity Summary', { underline: true });
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
                console.log("Report sent!");
                await db.resetDailyStats();
            } catch (err) {
                console.log("Failed to send report:", err);
            }
        });
    });
}

startBot();
