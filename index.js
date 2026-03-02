const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require("@google/generative-ai"); // 🧠 AI Import
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

// 🔑 PASTE YOUR GEMINI API KEY HERE
const GEMINI_API_KEY = "YOUR_API_KEY_HERE"; 

const DEVELOPER_NUMBER = 'OO123456789@s.whatsapp.net'; 
const REPORT_TIME = '59 23 * * *'; 

const FLOOD_WINDOW = 8000;  
const FLOOD_LIMIT = 5;      
const MENTION_LIMIT = 5; 
const COOLDOWN_TIME = 5 * 60 * 1000; 

// Layer 1: Instant Block List (Saves AI Quota)
const BAD_WORDS = [
   ];

// ==========================================
// 🧠 AI BRAIN SETUP
// ==========================================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

async function analyzeSentiment(text) {
    if (!text || text.length < 4) return "SAFE"; // Too short for AI

    try {
        const prompt = `
        You are a strict WhatsApp Group Moderator. 
        Analyze this message for: Hate Speech, Bullying, Sexual Harassment, Scams, or Severe Toxicity.
        
        Message: "${text}"

        Reply ONLY with one word.
        If safe: "SAFE"
        If violating: "HATE", "BULLYING", "SEXUAL", "SCAM", "TOXIC"
        `;

        const result = await model.generateContent(prompt);
        const verdict = result.response.text().trim().toUpperCase();
        
        // Safety check to ensure AI didn't hallucinate a sentence
        const validVerdicts = ["SAFE", "HATE", "BULLYING", "SEXUAL", "SCAM", "TOXIC"];
        return validVerdicts.includes(verdict) ? verdict : "SAFE";
    } catch (error) {
        console.error("⚠️ AI Error:", error.message);
        return "SAFE"; // Fail open if AI is down
    }
}

// ==========================================
// 💾 STATE MEMORY
// ==========================================
let pendingUpdates = {};    
let commandCooldowns = {};  
let floodTracker = {};      
let adminContext = {};      
let adminGroupCache = {};   
let pendingVerification = {}; 

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["StrictGuard AI", "ArchLinux", "2.0.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ StrictGuard AI Active.');
            setupDailyReport(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // 👋 NEW USER DETECTOR (The Gatekeeper)
    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update;
        
        // 🛑 SECURITY CHECK: Is this group active?
        const isActive = await db.isGroupActive(id);
        if (!isActive) return; 

        if (action === 'add') {
            for (const item of participants) {
                // 🛡️ Handle Object/String formats
                const participantJid = typeof item === 'object' ? item.id : item;

                const num1 = Math.floor(Math.random() * 10) + 1;
                const num2 = Math.floor(Math.random() * 10) + 1;
                const solution = num1 + num2;

                pendingVerification[participantJid] = { answer: solution, group: id, attempts: 0 };
                console.log(`🔒 Soft-Muted ${participantJid.split('@')[0]}. Answer: ${solution}`);

                try {
                    await sock.sendMessage(participantJid, { 
                        text: `👋 *Welcome!*\n\nTo prevent spam, you are muted.\nReply here with: *${num1} + ${num2}*`
                    });
                } catch (e) {
                    await sock.sendMessage(id, { text: `@${participantJid.split('@')[0]} check DMs to verify!`, mentions: [participantJid] });
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        if (msg.key.fromMe) return; 
        if (msg.key.remoteJid === 'status@broadcast') return;

        const remoteJid = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const isGroup = remoteJid.endsWith('@g.us');
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();
        const lowerText = text.toLowerCase();

        console.log(`📩 [${remoteJid}] ${sender.split('@')[0]}: ${text}`);

        // 🔒 VERIFICATION HANDLER
        if (isGroup && pendingVerification[sender] && pendingVerification[sender].group === remoteJid) {
            try { await sock.sendMessage(remoteJid, { delete: msg.key }); } catch(e){}
            return; 
        }
        if (!isGroup && pendingVerification[sender]) {
            const challenge = pendingVerification[sender];
            const userAnswer = parseInt(text.replace(/[^0-9]/g, ''));

            if (userAnswer === challenge.answer) {
                await sock.sendMessage(remoteJid, { text: "✅ *Verified!* You can chat now." });
                await sock.sendMessage(challenge.group, { text: `🎉 @${sender.split('@')[0]} verified!`, mentions: [sender] });
                delete pendingVerification[sender];
            } else {
                challenge.attempts++;
                if (challenge.attempts >= 3) {
                    await sock.sendMessage(remoteJid, { text: "❌ Failed. Removal initiated." });
                    await sock.groupParticipantsUpdate(challenge.group, [sender], "remove");
                    delete pendingVerification[sender];
                } else {
                    await sock.sendMessage(remoteJid, { text: `⚠️ Wrong.Try again.` });
                }
            }
            return;
        }

        // 🏢 GROUP LOGIC
        if (isGroup) {
            const isActive = await db.isGroupActive(remoteJid);
            if (!isActive) return; 

            try { db.updateStat(remoteJid, "EXISTING", 'msg'); } catch (e) {}

            // Admin Check
            let isAdmin = false;
            try {
                const meta = await sock.groupMetadata(remoteJid);
                const participant = meta.participants.find(p => p.id === sender);
                isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin';
            } catch (e) {}
            const isVip = await db.isVip(remoteJid, sender);
            
            // ADMINS AND VIPS ARE IMMUNE
            if (isAdmin || isVip) {
                // Process Commands for Admins
                if (lowerText === '!rules') {
                    const content = await db.getContent(remoteJid, 'rules');
                    if (content) await sock.sendMessage(remoteJid, { text: content.text_content });
                }
                return; 
            }

            // 🛡️ SECURITY SCANS
            let violationReason = null;
            const contextInfo = msg.message.extendedTextMessage?.contextInfo || msg.message.imageMessage?.contextInfo;
            const mentions = contextInfo?.mentionedJid || [];
            const strictness = await db.getStrictness(remoteJid);

            // 1. Technical Attacks (Status/Channel Spam)
            if (mentions.includes(remoteJid)) violationReason = "Status Spam";
            else if (contextInfo?.participant === 'status@broadcast') violationReason = "Status Spam";
            else if (contextInfo?.stanzaId && contextInfo?.remoteJid === 'status@broadcast') violationReason = "Status Spam";
            else if (contextInfo?.forwardedNewsletterMessageInfo) violationReason = "Channel Spam";
            else if (mentions.length > MENTION_LIMIT) violationReason = "Mass Mentioning";
            
            // 2. Strictness Levels
            if (!violationReason && strictness > 0) {
                if (msg.message.imageMessage && strictness >= 2) violationReason = "Images Blocked";
                if (!violationReason && /(chat\.whatsapp\.com|t\.me)/i.test(lowerText)) violationReason = "Links Blocked";
            }

            // 3. Layer 1: Dumb Keyword Filter (Fast)
            if (!violationReason && new RegExp(`\\b(${BAD_WORDS.join('|')})\\b`, 'i').test(lowerText)) {
                violationReason = "Profanity";
            }

            // 4. Layer 2: AI Brain (Smart) 🧠
            // Only check if it passed all other filters and has actual text
            if (!violationReason && text.length > 3) {
                const aiVerdict = await analyzeSentiment(text);
                if (aiVerdict !== "SAFE") {
                    violationReason = `Detected: ${aiVerdict}`;
                }
            }

            // Punish
            if (violationReason) {
                try { await sock.sendMessage(remoteJid, { delete: msg.key }); } catch (e) {}
                const strikes = await db.addWarning(remoteJid, sender);
                if (strikes >= 3) {
                    await sock.sendMessage(remoteJid, { text: `🚫 @${sender.split('@')[0]} removed for ${violationReason}.`, mentions: [sender] });
                    await sock.groupParticipantsUpdate(remoteJid, [sender], "remove");
                    db.resetWarnings(remoteJid, sender);
                } else {
                    const warn = await sock.sendMessage(remoteJid, { text: `⚠️ @${sender.split('@')[0]} Warning! ${violationReason}. (${strikes}/3)`, mentions: [sender] });
                    setTimeout(() => sock.sendMessage(remoteJid, { delete: warn.key }).catch(()=>{}), 10000);
                }
            }
            return;
        }

        // 🎮 DM ADMIN CONTROL
        if (!isGroup) {
            if (pendingUpdates[sender]) {
                const target = adminContext[sender];
                if (!target) return;
                await db.setContent(target, pendingUpdates[sender], text, null);
                await sock.sendMessage(remoteJid, { text: "✅ Updated!" });
                delete pendingUpdates[sender];
                return;
            }

            const args = text.split(' ');
            const cmd = args[0].toLowerCase();

            if (cmd === '!groups') {
                const groups = await sock.groupFetchAllParticipating();
                let list = "📋 *Groups:*\n";
                let i = 1;
                adminGroupCache[sender] = [];
                for (const g of Object.values(groups)) {
                    const p = g.participants.find(x => x.id === sender);
                    if (p?.admin) {
                        list += `${i}. ${g.subject}\n`;
                        adminGroupCache[sender].push({ id: g.id, subject: g.subject });
                        i++;
                    }
                }
                await sock.sendMessage(remoteJid, { text: list });
            }
            else if (cmd === '!use') {
                const idx = parseInt(args[1]) - 1;
                const target = adminGroupCache[sender]?.[idx];
                if (target) {
                    adminContext[sender] = target.id;
                    await db.setGroupName(target.id, target.subject);
                    await sock.sendMessage(remoteJid, { text: `Connected to: ${target.subject}` });
                }
            }
            else if (adminContext[sender]) {
                const target = adminContext[sender];
                if (cmd === '!strict') {
                    await db.setStrictness(target, parseInt(args[1]));
                    await sock.sendMessage(remoteJid, { text: "✅ Strictness Updated" });
                }
                else if (cmd === '!updaterules') {
                    pendingUpdates[sender] = 'rules';
                    await sock.sendMessage(remoteJid, { text: "Send new rules now." });
                }
            }
        }
    });
}

function setupDailyReport(sock) {
    schedule.scheduleJob(REPORT_TIME, async () => {
        const stats = await db.getDailyStats();
        const doc = new PDFDocument();
        const path = './media/report.pdf';
        doc.pipe(fs.createWriteStream(path));
        
        doc.fontSize(20).text("Daily Report", { align: 'center' });
        doc.moveDown();
        if (stats.length === 0) {
            doc.text("No activity today. Bot is online.");
        } else {
            stats.forEach(s => {
                doc.text(`${s.group_name || 'Group'}: ${s.msg_count} msgs, ${s.violation_count} blocked.`);
            });
        }
        doc.end();

        setTimeout(async () => {
            try {
                await sock.sendMessage(DEVELOPER_NUMBER, { 
                    document: fs.readFileSync(path), 
                    mimetype: 'application/pdf', 
                    fileName: 'Report.pdf',
                    caption: "Daily Report Sir 🫡"
                });
            } catch(e) { console.log(e); }
        }, 3000);
    });
}

startBot();
