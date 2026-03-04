# ⚡ PolyAlpha - Advanced High-Frequency Copy Trading Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Polymarket](https://img.shields.io/badge/Platform-Polymarket-purple.svg)](https://polymarket.com/)
[![Docker](https://img.shields.io/badge/Deployment-Docker-blue.svg)](https://www.docker.com/)

**The ultimate open-source solution for automated copy-trading on Polymarket (Polygon/Matic).**
Designed for speed, reliability, and profitability. Dominate the prediction markets by mirroring the best traders in real-time.

---

## 🌟 Why PolyAlpha?

PolyAlpha isn't just a script; it's a **professional-grade trading engine**.

### 🚀 **Ultra-Low Latency Execution ("Fresh Orders")**
*   **Direct Blockchain Monitoring**: Bypasses slow APIs by listening directly to the Polygon blockchain (WebSocket/RPC) for `TransferSingle` and `TransferBatch` events.
*   **Front-Running Capability**: Detects and executes copy trades milliseconds after the target trader moves. Catches the "fresh order" before the crowd.

### 🛡️ **Advanced Risk Management (SafetyGuardian™)**
*   **Auto Stop-Loss**: Automatically dumps positions if they drop below -15% (configurable).
*   **Smart Take-Profit**: Secures gains automatically when prices hit $0.98.
*   **Panic Sell Mode**: Emergency liquidation protocol if market conditions turn adverse.
*   **Deep Loss Protection**: Intelligently ignores "dead" positions (>80% loss) to save gas and focus on winning trades.

### 💰 **Automated Profit Redemption**
*   **Auto-Claim Winnings**: The bot monitors your winning positions and automatically redeems them for USDC via the CTF Exchange contract.
*   **Gnosis Safe & EOA Support**: Works seamlessly with both standard wallets and multi-sig proxy wallets.

### 🧠 **Intelligent Copy Strategies**
*   **Adaptive Sizing**: Choose between `PERCENTAGE` (copy % of trader's size), `FIXED` (flat $ amount), or `ADAPTIVE` (dynamic scaling).
*   **Tiered Multipliers**: Apply different multipliers based on trade size (e.g., copy small trades 1x, big trades 0.5x).
*   **Whale Filtering**: Filter out noise by setting minimum/maximum trade sizes.

### 📊 **Real-Time Dashboard**
*   **Live PnL Tracking**: Visualize your daily profits and ROI instantly.
*   **Active Position Monitor**: See exactly what the bot is holding and its current market value.
*   **Trade History**: Full log of every action taken by the bot.

### ⚡ **Enterprise-Grade Architecture**
*   **RPC Rotation Manager**: Automatically switches between Alchemy, QuickNode, and Public RPCs to avoid rate limits and downtime.
*   **Dockerized**: Deploys in seconds with a single command.
*   **TypeScript Core**: Type-safe, robust, and maintainable codebase.

---

## 💻 Windows Users (Easy Start)

For Windows users, we provide simple `.bat` scripts to manage the bot without typing commands.

1.  **Install/Setup:** Double-click `install.bat` (Run this first!)
    *   *Installs all dependencies and builds the bot engine.*
2.  **Start Bot:** Double-click `start_bot.bat`
    *   *Launches the bot and the dashboard.*
3.  **Update Bot:** Double-click `update.bat`
    *   *Pulls the latest features from GitHub and updates the system.*

---

## 🚀 Installation (Manual / Linux / Mac)

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Docker](https://www.docker.com/) (Optional, recommended)
- A Polymarket Account (Proxy Wallet Key)

### Quick Start (Docker)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/polyalpha-copybot.git
   cd polyalpha-copybot
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your Private Key and Settings
   ```

3. **Run:**
   ```bash
   docker compose up --build -d
   ```

4. **Access Dashboard:**
   Open `http://localhost:4405` in your browser.
   - **User:** `admin`
   - **Pass:** `admin123` (Change in .env!)

---

## 🛠 Configuration (.env)

Customize the bot to fit your risk profile.

| Variable | Description | Default |
|----------|-------------|---------|
| `PROXY_WALLET_PK` | Your Polymarket Proxy Private Key | **Required** |
| `USER_ADDRESSES` | Comma-separated list of traders to copy | **Required** |
| `MAX_POSITION_SIZE_USD` | Max exposure per single market | `1.2` |
| `COPY_PERCENTAGE` | % of the trader's order to copy | `10.0` |
| `PANIC_THRESHOLD` | Stop-loss percentage (-0.15 = -15%) | `-0.15` |
| `TAKE_PROFIT_THRESHOLD` | Price to auto-sell at ($0.98) | `0.98` |

---

## 💖 Support the Development

This bot is **100% Free and Open Source**. If it helps you make profit, please consider donating to support maintenance and new features!

**Join our Discord Community:**
[https://discord.gg/y2pKtgTYEE](https://discord.gg/y2pKtgTYEE)

**EVM (ETH/Polygon/BSC):**
```
0x5da643C6d0E72C18fa5D63178Ea116e1309BD9d0
```

**Solana:**
```
YQLE7Heob5oXKy4nyjQCPP46xdFKzbTh7EGJ5jmTA1v
```

**Sui:**
```
0x2d9e999dd90ff4fdf321c01e1d6c3a2785ff4fcae3c67853a694d61aae82a233
```

---

**Disclaimer:** This software is for educational purposes only. Use at your own risk. The developers are not responsible for any financial losses. Cryptocurrency trading involves high risk.
