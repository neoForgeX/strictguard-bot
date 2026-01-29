# 🛡️ StrictGuard: WhatsApp Anti-Spam & Moderation Bot

StrictGuard is a lightweight, high-performance WhatsApp bot built with `Node.js` and `@whiskeysockets/baileys`. It is designed to protect groups from spam links, manage community rules, and provide daily activity reports to administrators.

Unlike other bots, it uses a direct WebSocket connection (no browser required), making it suitable for low-resource cloud servers (e.g., AWS t2.micro, Google e2-micro).

## ✨ Features

### 🛡️ **Security & Moderation**
* **Anti-Spam Filter:** Automatically detects and deletes invite links (Telegram, Discord, WhatsApp).
* **Variable Strictness:**
    * *Level 1:* Blocks known spam domains only.
    * *Level 2:* Blocks **ALL** links (High Security Mode).
* **Profanity Filter:** Deletes messages containing blacklisted words.
* **Strike System:** Warns users on first/second offense; kicks them on the third.
* **Admin Immunity:** Admins and VIPs are ignored by the filter.

### ⚙️ **Utilities**
* **VIP Whitelist:** Allow specific non-admin users to post links `!vip`.
* **Dynamic Rules & Welcome:** Admins can update `!rules` and `!welcome` messages (text + images) directly from WhatsApp.
* **Cooldown System:** Prevents users from spamming public commands.

### 📊 **Analytics**
* **Daily PDF Report:** Generates a PDF summary of group activity (Messages, Blocks, Kicks) and sends it to the Developer every night at 23:59.

---

## 🚀 Installation

### Prerequisites
* Node.js v18 or higher
* A phone number to act as the bot

### Setup
1.  **Clone the repository**
    ```bash
    git clone [https://github.com/neoForgeX/strictguard-bot.git](https://github.com/neoForgeX/strictguard-bot.git)
    cd strictguard-bot
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Configure the Bot**
    Open `index.js` and update the `DEVELOPER_NUMBER` constant with your WhatsApp number (format: `countrycode` + `number` + `@s.whatsapp.net`).
    ```javascript
    const DEVELOPER_NUMBER = '27831234567@s.whatsapp.net';
    ```

4.  **Run the Bot**
    ```bash
    node index.js
    ```
    *Scan the QR code that appears in the terminal using your WhatsApp (Linked Devices).*

---

## 🤖 Command Reference

### 👮 Admin Commands
*Only Group Admins can use these.*

| Command | Description |
| :--- | :--- |
| **`!strict 1`** | Set filtering to **Low** (Block known spam only). |
| **`!strict 2`** | Set filtering to **High** (Block ALL links). |
| **`!strict 0`** | Turn **OFF** the link filter. |
| **`!vip @user`** | Whitelist a user (immune to filters). |
| **`!un-vip @user`** | Remove a user from the whitelist. |
| **`!pardon @user`** | Reset a user's strike count to 0. |
| **`!updaterules`** | Follow prompt to update the `!rules` response. |
| **`!updatewelcome`** | Follow prompt to update the `!welcome` response. |

### 📢 Public Commands
*Available to all users (5-minute cooldown).*

| Command | Description |
| :--- | :--- |
| **`!rules`** | Displays group rules. |
| **`!welcome`** | Displays welcome message. |
| **`!creator`** | Shows bot credits. |

---

## 🛠️ Deployment (24/7)

To keep the bot running in the background on a server, use PM2:

```bash
# Install PM2
npm install pm2 -g

# Start the bot
pm2 start index.js --name "strictguard"

# View logs
pm2 logs

# Save process list (so it restarts after reboot)
pm2 save
pm2 startup
