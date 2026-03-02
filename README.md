# 🛡️ StrictGuard (v1 Monolith)

An autonomous, AI-powered WhatsApp group moderation bot built to keep communities safe. StrictGuard uses Google's Gemini AI to understand the context of chat messages, automatically issuing warnings and removing users who violate group policies. 

This repository contains the **v1 Monolithic Architecture**, which runs the WhatsApp WebSocket gateway, the AI processing engine, and a local SQLite database inside a single Docker container.

## ✨ Key Features
* **Context-Aware AI Filtering:** Powered by `gemini-1.5-flash-8b`, the bot detects hate speech, severe toxicity, bullying, and scams. It is specifically prompted to recognize and exempt religious texts, literature, and direct quotes.
* **The 3-Strike System:** Automatically deletes violating messages, issues public warnings, and permanently bans users upon their third strike.
* **DM Command Center:** Manage all your groups privately via Direct Messages with the bot.
* **VIP Immunity:** Protect human admins and trusted members from the automated moderation filters.
* **Forensic PDF Reports:** Automatically generates and sends daily PDF reports of moderation actions, or pulls manual evidence files on specific users.
* **Persistent State:** Uses Docker volumes to save the WhatsApp cryptographic session and the SQLite database, ensuring zero data loss during reboots.

## 🛠️ Tech Stack
* **Runtime:** Node.js
* **WhatsApp API:** `@whiskeysockets/baileys` (Bypasses Meta blocks with dynamic version scraping)
* **AI Engine:** Google Generative AI SDK
* **Database:** SQLite3
* **Document Generation:** PDFKit
* **Infrastructure:** Docker & Docker Compose

## 🚀 Installation & Setup

**1. Clone the repository**
\`\`\`bash
git clone https://github.com/YourUsername/strictguard-core.git
cd strictguard-core
\`\`\`

**2. Configure Environment Variables**
Create a `.env` file in the root directory and add your Google Gemini API key:
\`\`\`text
GEMINI_API_KEY=AIzaSyYourActualKeyGoesHere...
\`\`\`

**3. Boot the Container**
Ensure Docker is installed, then build and start the bot:
\`\`\`bash
docker-compose up -d --build
\`\`\`

**4. Link Your WhatsApp Account**
Attach to the container's logs to view the connection process and the QR code:
\`\`\`bash
docker logs -f strictguard_bot
\`\`\`
Scan the QR code printed in the terminal using the "Linked Devices" feature on the WhatsApp account you want to act as the bot.

## 🎛️ Admin Commands (Direct Message)
To configure the bot, send these commands to the bot's phone number in a Direct Message. **The bot must be a Group Admin to function properly.**

| Command | Description |
| :--- | :--- |
| `!groups` | Lists all WhatsApp groups the bot is currently in with their ID numbers. |
| `!use [ID]` | Locks the Command Center onto a specific group to manage its settings. |
| `!strict [0/1/2]` | Sets the hard-coded filter level (0: AI Only, 1: Blocks Links, 2: Blocks Links & Media). |
| `!updaterules [Text]` | Overwrites the official rules for the selected group. |
| `!vip [Number]` | Grants a user Admin Immunity (e.g., `!vip 27831234567`). |
| `!evidence [Number]` | Generates a PDF forensics report containing the strike history of a user. |

## 💬 Public Commands (Group Chat)
| Command | Description |
| :--- | :--- |
| `!rules` | The bot tags the user with the custom rules set via the `!updaterules` command. |

## ⚠️ Important Notes
* **Session Data:** The `data/auth_info_baileys` directory is automatically generated upon scanning the QR code and is ignored by Git. Do not delete this folder unless you want to force the bot to log out.
* **Admin Rights:** If StrictGuard is not granted Admin privileges in a WhatsApp group, it will be unable to delete messages or remove users, and will fail silently.
