# 🛡️ StrictGuard: Multi-Group WhatsApp Security Bot

StrictGuard is a professional-grade WhatsApp moderation bot built with `Node.js` and `@whiskeysockets/baileys`. It is designed to protect multiple groups simultaneously, with unique settings, rules, and welcome messages for each community.

The bot operates in **Silent Mode** by default. It will not interfere with a group until an Admin explicitly activates it.

## ✨ Features

### 🏢 **Multi-Group Architecture**
* **Per-Group Isolation:** Settings for Group A do not affect Group B.
* **Activation Gatekeeper:** The bot ignores all messages until activated via `!set groupname`.
* **Custom Profiles:** Each group has its own Rules, Welcome Message, and VIP list.

### 🛡️ **Security & Moderation**
* **Flood Protection:** Automatically detects and removes users who spam text (5+ messages in 8 seconds).
* **Anti-Link System:**
    * *Level 1:* Blocks known spam domains (Telegram, Discord, WhatsApp Invites).
    * *Level 2:* Blocks **ALL** links (High Security Mode).
* **Profanity Filter:** Deletes messages containing blacklisted words.
* **Strike System:** Warns users on 1st/2nd offense; kicks them on the 3rd.
* **Admin Immunity:** Admins and VIPs are ignored by all filters.

### 📊 **Analytics**
* **Daily PDF Report:** Generates a PDF summary of activity across *all* active groups (Messages, Blocks, Kicks) and sends it to the Developer every night at 23:59.

---

## 🚀 Installation

### Prerequisites
* Node.js v18 or higher
* A phone number to act as the bot
* SQLite3 (Pre-installed with the package)

### Setup
1.  **Clone the repository**
    ```bash
    git clone [https://github.com/neoforgex/strictguard-bot.git](https://github.com/neoforgex/strictguard-bot.git)
    cd strictguard-bot
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Configure the Bot**
    Open `index.js` and update the `DEVELOPER_NUMBER` with your WhatsApp number (format: `countrycode` + `number` + `@s.whatsapp.net`).
    ```javascript
    const DEVELOPER_NUMBER = '27812345267@s.whatsapp.net';
    ```

4.  **Run the Bot**
    ```bash
    node index.js
    ```
    *Scan the QR code that appears in the terminal using your WhatsApp (Linked Devices).*

---

## 🤖 Command Reference

### 🟢 Activation (Required First)
*The bot does nothing until you run this command.*

| Command | Description |
| :--- | :--- |
| **`!set groupname [Name]`** | Activates the bot for the current group and sets the display name for the daily report.<br>_Example: `!set groupname Crypto Traders ZA`_ |

### 👮 Admin Commands
*Only Group Admins can use these.*

| Command | Description |
| :--- | :--- |
| **`!strict 1`** | Set filtering to **Low** (Block known spam only). |
| **`!strict 2`** | Set filtering to **High** (Block ALL links). |
| **`!vip @user`** | Whitelist a user (immune to filters/flooding). |
| **`!un-vip @user`** | Remove a user from the whitelist. |
| **`!pardon @user`** | Reset a user's strike count to 0. |
| **`!updaterules`** | Follow prompt to update the `!rules` response for *this group only*. |
| **`!updatewelcome`** | Follow prompt to update the `!welcome` response for *this group only*. |

### 📢 Public Commands
*Available to all users (5-minute cooldown).*

| Command | Description |
| :--- | :--- |
| **`!rules`** | Displays specific rules for the current group. |
| **`!welcome`** | Displays the welcome message for the current group. |
| **`!ping`** | Checks if the bot is active and listening. |

---

## 🛠️ Deployment (24/7)

To keep the bot running in the background on a Linux server:

```bash
# Install PM2
npm install pm2 -g

# Start the bot
pm2 start index.js --name "strictguard"

# View logs
pm2 logs strictguard

# Save process list (so it restarts after reboot)
pm2 save
pm2 startup
