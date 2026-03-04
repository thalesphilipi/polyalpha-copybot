import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ENV } from '../config/env';
import Logger from './Logger';
import BotHistory from '../models/botHistory';
import { getUserPositionModel } from '../models/userHistory';

const PORT = 4405;
const LOGS_DIR = path.join(process.cwd(), 'logs');

// Simple Basic Auth
const AUTH_USER = process.env.DASHBOARD_USER || 'admin';
const AUTH_PASS = process.env.DASHBOARD_PASS || 'admin123';

interface TraderMetrics {
    address: string;
    totalInvested: number;
    totalReturned: number;
    netProfit: number; // Realized PnL
    roi: number;
    wins: number;
    losses: number;
    winRate: number;
    totalTrades: number;
    activePositions: number;
    status: string;
}

export class DashboardService {
    public start() {
        const server = http.createServer(async (req, res) => {
            // Auth
            if (!this.checkAuth(req)) {
                this.sendAuthChallenge(res);
                return;
            }
            res.setHeader('Access-Control-Allow-Origin', '*');

            if (req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(this.getHtml());
            } else if (req.url === '/api/logs') {
                const latestFile = this.getLatestLogFile();
                if (!latestFile) {
                    res.writeHead(404);
                    res.end('No logs');
                    return;
                }
                fs.readFile(path.join(LOGS_DIR, latestFile), 'utf8', (err, data) => {
                    if (err) {
                        res.writeHead(500);
                        res.end('Error');
                        return;
                    }
                    const lines = data.split('\n').slice(-100).join('\n');
                    res.writeHead(200);
                    res.end(lines);
                });
            } else if (req.url === '/api/stats') {
                try {
                    const stats = await this.getAllTradersStats();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(stats));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: String(e) }));
                }
            } else if (req.url === '/api/activity') {
                try {
                    const act = await this.getGlobalRecentActivity();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(act));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: String(e) }));
                }
            } else if (req.url?.startsWith('/api/trader/')) {
                const address = req.url.split('/')[3];
                if (address) {
                    try {
                        const history = await this.getDetailedHistory(address);
                        const metrics = await this.calculateTraderMetrics(address);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ history, metrics }));
                    } catch (e) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: String(e) }));
                    }
                }
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        server.listen(PORT, () => {
            Logger.info(`📊 Dashboard running at http://localhost:${PORT}`);
        });
    }

    private checkAuth(req: http.IncomingMessage): boolean {
        const auth = req.headers['authorization'];
        if (!auth) return false;
        const [scheme, credentials] = auth.split(' ');
        if (scheme !== 'Basic' || !credentials) return false;
        const [user, pass] = Buffer.from(credentials, 'base64').toString().split(':');
        return user === AUTH_USER && pass === AUTH_PASS;
    }

    private sendAuthChallenge(res: http.ServerResponse) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="PolyAlpha-CopyBot Dashboard"' });
        res.end('Authentication required');
    }

    private getLatestLogFile() {
        if (!fs.existsSync(LOGS_DIR)) return null;
        const files = fs
            .readdirSync(LOGS_DIR)
            .filter((f) => f.startsWith('bot-') && f.endsWith('.log'));
        if (files.length === 0) return null;
        return files.sort().reverse()[0];
    }

    private async calculateTraderMetrics(address: string): Promise<TraderMetrics> {
        const history = await BotHistory.find({ sourceTrader: address }).lean();
        const UserPosition = getUserPositionModel(address);
        const positions = await UserPosition.find({ size: { $gt: 0.0001 } }).lean();
        const activePositionsCount = positions.length;

        let totalInvested = 0;
        let totalReturned = 0;
        let netProfit = 0;
        let wins = 0;
        let losses = 0;

        for (const trade of history) {
            if (trade.type === 'BUY') {
                totalInvested += trade.amountValue || 0;
            } else if (trade.type === 'SELL' || trade.type === 'REDEEM') {
                totalReturned += trade.amountValue || 0;
                if (trade.pnl != null) {
                    netProfit += trade.pnl;
                    if (trade.pnl > 0.01) wins++;
                    else if (trade.pnl < -0.01) losses++;
                }
            }
        }

        const roi = totalInvested > 0 ? (netProfit / totalInvested) * 100 : 0;
        const totalTrades = wins + losses;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

        return {
            address,
            totalInvested,
            totalReturned,
            netProfit,
            roi,
            wins,
            losses,
            winRate,
            totalTrades,
            activePositions: activePositionsCount,
            status: activePositionsCount > 0 ? 'Active' : 'Idle',
        };
    }

    private async getAllTradersStats() {
        const stats = [];
        for (const address of ENV.USER_ADDRESSES) {
            const metrics = await this.calculateTraderMetrics(address);
            stats.push({
                address: metrics.address,
                invested: metrics.totalInvested.toFixed(2),
                returned: metrics.totalReturned.toFixed(2),
                pnl: metrics.netProfit.toFixed(2),
                roi: metrics.roi.toFixed(1) + '%',
                winRate: metrics.winRate.toFixed(1) + '%',
                wins: metrics.wins,
                losses: metrics.losses,
                totalTrades: metrics.totalTrades,
                activePositions: metrics.activePositions,
                status: metrics.status,
            });
        }
        stats.sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
        return stats;
    }

    private async getDetailedHistory(address: string) {
        const history = await BotHistory.find({ sourceTrader: address })
            .sort({ timestamp: -1 })
            .limit(200)
            .lean();

        return history.map((h) => ({
            date: new Date(h.timestamp * 1000).toLocaleString('en-US'),
            type: h.type,
            asset: h.title || h.asset,
            outcome: h.outcome,
            price: h.price,
            value: h.amountValue.toFixed(2),
            pnl: h.pnl ? h.pnl.toFixed(2) : '-',
            roi: h.roi ? h.roi.toFixed(1) + '%' : '-',
            reason: h.reason,
            hash: h.transactionHash
        }));
    }

    private async getGlobalRecentActivity() {
        const history = await BotHistory.find({})
            .sort({ timestamp: -1 })
            .limit(100) // Increased limit
            .lean();

        return history.map((h) => ({
                timestamp: h.timestamp,
                date: new Date(h.timestamp * 1000).toLocaleString('en-US'),
                trader: h.sourceTrader || 'Unknown',
                type: h.type,
                title: h.title || h.asset,
                outcome: h.outcome || '-',
                price: h.price,
                value: h.amountValue,
                pnl: h.pnl,
                roi: h.roi,
                reason: h.reason,
                status: h.status,
                error: h.error
            }));
    }

    private getHtml() {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PolyAlpha-CopyBot Dashboard</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚡</text></svg>">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #0d1117; --card-bg: #161b22; --border: #30363d; --text: #c9d1d9; --text-muted: #8b949e; --green: #238636; --red: #da3633; --accent: #58a6ff; }
        body { font-family: 'Segoe UI', Inter, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; font-size: 14px; }
        .navbar { background: var(--card-bg); padding: 12px 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
        .brand { font-size: 1.2rem; font-weight: 700; color: var(--accent); display: flex; align-items: center; gap: 8px; }
        .container { max-width: 1600px; margin: 20px auto; padding: 0 20px; display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
        .full-width { grid-column: 1 / -1; }
        .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 20px; display: flex; flex-direction: column; }
        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        h2 { margin: 0; font-size: 1rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 10px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-weight: 600; font-size: 0.85rem; cursor: pointer; }
        td { padding: 10px; border-bottom: 1px solid #21262d; font-size: 0.9rem; }
        tr:last-child td { border-bottom: none; }
        tbody tr:hover { background: #21262d; cursor: pointer; }
        
        .text-green { color: #3fb950; font-weight: 600; }
        .text-red { color: #f85149; font-weight: 600; }
        .badge { padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; border: 1px solid transparent; }
        .badge-active { background: rgba(63, 185, 80, 0.1); color: #3fb950; border-color: rgba(63, 185, 80, 0.4); }
        .badge-idle { background: rgba(139, 148, 158, 0.1); color: #8b949e; border-color: rgba(139, 148, 158, 0.4); }
        .badge-buy { background: rgba(88, 166, 255, 0.15); color: #58a6ff; }
        .badge-sell { background: rgba(238, 75, 43, 0.15); color: #ff7b72; }
        .badge-redeem { background: rgba(163, 113, 247, 0.15); color: #d2a8ff; }

        .btn-donate {
            background: linear-gradient(45deg, #ff00cc, #3333ff);
            border: none;
            color: white;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: bold;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: transform 0.2s, box-shadow 0.2s;
            text-decoration: none;
            font-size: 0.9rem;
        }
        .btn-donate:hover {
            transform: scale(1.05);
            box-shadow: 0 0 15px rgba(255, 0, 204, 0.5);
        }

        /* Modal */
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 1000; backdrop-filter: blur(2px); }
        .modal-content { background: var(--card-bg); margin: 3% auto; width: 90%; max-width: 1200px; border-radius: 8px; border: 1px solid var(--border); max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
        .modal-header { padding: 15px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: #0d1117; border-radius: 8px 8px 0 0; }
        .modal-body { padding: 20px; overflow-y: auto; flex: 1; }
        .close-btn { font-size: 1.5rem; cursor: pointer; color: var(--text-muted); transition: color 0.2s; }
        .close-btn:hover { color: #fff; }

        .kpi-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 15px; margin-bottom: 25px; }
        .kpi-card { background: #0d1117; padding: 15px; border-radius: 6px; border: 1px solid var(--border); }
        .kpi-value { font-size: 1.5rem; font-weight: 700; margin-top: 5px; color: #fff; }
        .kpi-label { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; }

        .search-box { background: #0d1117; border: 1px solid var(--border); color: #fff; padding: 6px 12px; border-radius: 4px; outline: none; width: 200px; }
        .search-box:focus { border-color: var(--accent); }
        
        .filter-btn {
            background: #21262d; border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 4px; cursor: pointer; margin-left: 10px; font-size: 0.85rem;
        }
        .filter-btn:hover { background: #30363d; }
        .filter-btn.active { background: var(--accent); color: white; border-color: var(--accent); }

        .footer { margin-top: 40px; padding: 20px; text-align: center; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.9rem; }
        .footer a { color: var(--accent); text-decoration: none; }
        .footer a:hover { text-decoration: underline; }

        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #484f58; }
    </style>
</head>
<body>
    <div class="navbar">
        <div class="brand">⚡ PolyAlpha-CopyBot <span style="font-size: 0.8em; color: var(--text-muted); margin-left: 10px; font-weight: normal;">v2.0</span></div>
        <div style="display: flex; align-items: center; gap: 20px;">
             <button class="btn-donate" onclick="openDonateModal()">💖 Support Project</button>
            <div style="font-size: 0.8rem; color: #8b949e;">
                <span id="last-update">Updated: --:--:--</span>
            </div>
        </div>
    </div>

    <div class="container">
        <!-- Global Stats -->
        <div class="card full-width">
            <div class="kpi-grid">
                 <div class="kpi-card">
                    <div class="kpi-label">Total Invested</div>
                    <div class="kpi-value" id="total-invested">$0.00</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">Total Returned</div>
                    <div class="kpi-value" id="total-returned">$0.00</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">Net Profit (PnL)</div>
                    <div class="kpi-value" id="total-pnl">$0.00</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">Win Rate</div>
                    <div class="kpi-value" id="global-winrate">0%</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-label">Total Trades</div>
                    <div class="kpi-value" id="total-trades">0</div>
                </div>
            </div>
        </div>

        <!-- Main Traders Table -->
        <div class="card full-width">
            <div class="card-header">
                <h2>🏆 Copied Wallet Performance</h2>
                <input type="text" id="search" class="search-box" placeholder="Filter wallet..." onkeyup="filterTable()">
            </div>
            <div style="overflow-x: auto;">
                <table id="traders-table">
                    <thead>
                        <tr>
                            <th>Trader</th>
                            <th>Status</th>
                            <th>Invested</th>
                            <th>Returned</th>
                            <th>Net PnL</th>
                            <th>ROI</th>
                            <th>Win Rate</th>
                            <th>W/L</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody><!-- Populated via JS --></tbody>
                </table>
            </div>
        </div>

        <!-- Recent Activity Feed -->
        <div class="card full-width">
            <div class="card-header">
                <h2>📜 Trade History</h2>
                <div>
                    <button class="filter-btn active" onclick="filterActivity('all', this)">All</button>
                    <button class="filter-btn" onclick="filterActivity('win', this)">✅ Profits</button>
                    <button class="filter-btn" onclick="filterActivity('loss', this)">❌ Losses</button>
                </div>
            </div>
            <div style="overflow-x: auto; max-height: 500px;">
                <table id="activity-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Type</th>
                            <th>Copied Wallet</th>
                            <th>Market</th>
                            <th>Outcome</th>
                            <th>Price</th>
                            <th>Value</th>
                            <th>PnL</th>
                            <th>ROI</th>
                        </tr>
                    </thead>
                    <tbody><!-- Populated via JS --></tbody>
                </table>
            </div>
        </div>

        <!-- System Logs -->
        <div class="card full-width">
            <div class="card-header">
                <h2>💻 System Logs</h2>
            </div>
            <pre id="logs" style="height: 300px; overflow-y: auto; background: #0d1117; padding: 15px; border-radius: 4px; font-family: 'Consolas', monospace; font-size: 0.8rem; color: #8b949e; white-space: pre-wrap;"></pre>
        </div>
    </div>

    <div class="footer">
        Developed by <a href="https://www.linkedin.com/in/thalesphilipi/" target="_blank">Thales Philipi</a> | 
        <a href="https://NexApp.com.br" target="_blank">NexApp.com.br</a>
        <br>
        <div style="margin-top: 10px; font-size: 0.8em; color: var(--text-muted);">
            <strong>Support the project:</strong><br>
            PIX: +5535997541511<br>
            <details style="cursor: pointer; margin-top: 5px;">
                <summary>Cryptocurrencies (Click to view)</summary>
                <div style="text-align: left; display: inline-block; margin-top: 5px; font-family: monospace; background: #161b22; padding: 10px; border-radius: 4px; border: 1px solid #30363d;">
                    ETH/BSC/Polygon: 0x5da643C6d0E72C18fa5D63178Ea116e1309BD9d0<br>
                    Solana: YQLE7Heob5oXKy4nyjQCPP46xdFKzbTh7EGJ5jmTA1v<br>
                    Sui: 0x2d9e999dd90ff4fdf321c01e1d6c3a2785ff4fcae3c67853a694d61aae82a233
                </div>
            </details>
        </div>
    </div>

    <!-- Detailed History Modal -->
    <div id="modal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 id="modal-title">Trader Details</h2>
                <span class="close-btn" onclick="closeModal()">&times;</span>
            </div>
            <div class="modal-body">
                <table id="modal-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Type</th>
                            <th>Market</th>
                            <th>Outcome</th>
                            <th>Price</th>
                            <th>Value</th>
                            <th>PnL</th>
                            <th>ROI</th>
                            <th>Reason</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- Donate Modal -->
    <div id="donate-modal" class="modal">
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h2 style="color: #ff00cc;">💖 Support Development</h2>
                <span class="close-btn" onclick="closeDonateModal()">&times;</span>
            </div>
            <div class="modal-body" style="text-align: center;">
                <p style="font-size: 1.1rem; color: var(--text);">
                    This bot is maintained by <strong>Thales Philipi</strong>. <br>
                    If this software has brought you profits, consider donating to keep updates coming!
                </p>
                
                <div style="margin: 20px 0; text-align: left; background: #0d1117; padding: 20px; border-radius: 8px; border: 1px solid var(--border);">
                    <div style="margin-bottom: 15px;">
                        <strong style="color: var(--accent);">💠 PIX (Brasil)</strong><br>
                        <code style="display: block; background: #21262d; padding: 8px; margin-top: 5px; border-radius: 4px; user-select: all;">+5535997541511</code>
                    </div>
                    
                    <div style="margin-bottom: 15px;">
                        <strong style="color: var(--accent);">🦊 MetaMask (ETH/BSC/Polygon)</strong><br>
                        <code style="display: block; background: #21262d; padding: 8px; margin-top: 5px; border-radius: 4px; user-select: all;">0x5da643C6d0E72C18fa5D63178Ea116e1309BD9d0</code>
                    </div>

                    <div style="margin-bottom: 15px;">
                        <strong style="color: var(--accent);">🟣 Solana (SOL)</strong><br>
                        <code style="display: block; background: #21262d; padding: 8px; margin-top: 5px; border-radius: 4px; user-select: all;">YQLE7Heob5oXKy4nyjQCPP46xdFKzbTh7EGJ5jmTA1v</code>
                    </div>

                    <div>
                        <strong style="color: var(--accent);">💧 Sui Network</strong><br>
                        <code style="display: block; background: #21262d; padding: 8px; margin-top: 5px; border-radius: 4px; user-select: all; word-break: break-all;">0x2d9e999dd90ff4fdf321c01e1d6c3a2785ff4fcae3c67853a694d61aae82a233</code>
                    </div>
                </div>

                <div style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 20px;">
                    <p>Conecte-se com o desenvolvedor:</p>
                    <a href="https://discord.gg/y2pKtgTYEE" target="_blank" style="color: #5865F2; text-decoration: none; font-weight: bold; margin-right: 15px;">💬 Discord</a>
                    <a href="https://www.linkedin.com/in/thalesphilipi/" target="_blank" style="color: #0a66c2; text-decoration: none; font-weight: bold; margin-right: 15px;">👔 LinkedIn</a>
                    <a href="https://NexApp.com.br" target="_blank" style="color: var(--accent); text-decoration: none; font-weight: bold;">🌐 NexApp.com.br</a>
                </div>
            </div>
        </div>
    </div>

    <script>
        // Update data every 2 seconds
        setInterval(updateDashboard, 2000);
        updateDashboard();

        let currentActivityFilter = 'all';

        async function updateDashboard() {
            document.getElementById('last-update').innerText = 'Updated: ' + new Date().toLocaleTimeString();
            
            // Fetch Logs
            fetch('/api/logs').then(r => r.text()).then(logs => {
                const logEl = document.getElementById('logs');
                // Only scroll if near bottom
                const shouldScroll = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 50;
                logEl.innerText = logs;
                if(shouldScroll) logEl.scrollTop = logEl.scrollHeight;
            });

            // Fetch Stats
            fetch('/api/stats').then(r => r.json()).then(stats => {
                const tbody = document.querySelector('#traders-table tbody');
                tbody.innerHTML = stats.map(s => \`
                    <tr onclick="openTraderDetails('\${s.address}')">
                        <td style="font-family: monospace; color: var(--accent);">\${s.address.substring(0, 8)}...</td>
                        <td><span class="badge badge-\${s.status === 'Active' ? 'active' : 'idle'}">\${s.status}</span></td>
                        <td>$\${s.invested}</td>
                        <td>$\${s.returned}</td>
                        <td class="\${parseFloat(s.pnl) >= 0 ? 'text-green' : 'text-red'}">$\${s.pnl}</td>
                        <td class="\${parseFloat(s.roi) >= 0 ? 'text-green' : 'text-red'}">\${s.roi}</td>
                        <td>\${s.winRate}</td>
                        <td><span class="text-green">\${s.wins}W</span> / <span class="text-red">\${s.losses}L</span></td>
                        <td><button style="padding: 4px 8px; background: #238636; border: none; color: white; border-radius: 4px; cursor: pointer;">Details</button></td>
                    </tr>
                \`).join('');

                // Calculate Global Stats
                let totalInv = 0, totalRet = 0, totalPnl = 0, totalWins = 0, totalLosses = 0;
                stats.forEach(s => {
                    totalInv += parseFloat(s.invested);
                    totalRet += parseFloat(s.returned);
                    totalPnl += parseFloat(s.pnl);
                    totalWins += s.wins;
                    totalLosses += s.losses;
                });
                const totalTrades = totalWins + totalLosses;
                const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;

                document.getElementById('total-invested').innerText = '$' + totalInv.toFixed(2);
                document.getElementById('total-returned').innerText = '$' + totalRet.toFixed(2);
                const pnlEl = document.getElementById('total-pnl');
                pnlEl.innerText = (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2);
                pnlEl.className = 'kpi-value ' + (totalPnl >= 0 ? 'text-green' : 'text-red');
                
                document.getElementById('global-winrate').innerText = winRate + '%';
                document.getElementById('total-trades').innerText = totalTrades;
            });

            // Fetch Recent Activity
            fetch('/api/activity').then(r => r.json()).then(activity => {
                const tbody = document.querySelector('#activity-table tbody');
                const filtered = activity.filter(a => {
                    if (currentActivityFilter === 'win') return (a.pnl > 0);
                    if (currentActivityFilter === 'loss') return (a.pnl < 0);
                    return true;
                });

                tbody.innerHTML = filtered.map(a => {
                    let typeBadge = '';
                    if (a.status === 'FAILED') typeBadge = '<span class="badge" style="background: rgba(238, 75, 43, 0.15); color: #ff7b72;">FAILED</span>';
                    else if (a.type === 'BUY') typeBadge = '<span class="badge badge-buy">BUY</span>';
                    else if (a.type === 'SELL') typeBadge = '<span class="badge badge-sell">SELL</span>';
                    else typeBadge = '<span class="badge badge-redeem">REDEEM</span>';

                    let pnlDisplay = '-';
                    if (a.status === 'FAILED') {
                         pnlDisplay = '<span class="text-red">Error</span>';
                    } else if (a.pnl !== undefined) {
                         pnlDisplay = '<span class="' + (a.pnl >= 0 ? 'text-green' : 'text-red') + '">$' + a.pnl.toFixed(2) + '</span>';
                    }
                    
                    let roiDisplay = '-';
                    if (a.roi !== undefined) {
                         roiDisplay = '<span class="' + (a.roi >= 0 ? 'text-green' : 'text-red') + '">' + a.roi.toFixed(1) + '%</span>';
                    }
                    
                    const displayTitle = a.status === 'FAILED' && a.error ? '<span class="text-red" title="' + a.error + '">' + a.error.substring(0, 30) + '...</span>' : (a.title || a.asset);

                    return '<tr>' +
                        '<td style="color: var(--text-muted); font-size: 0.85rem;">' + a.date + '</td>' +
                        '<td>' + typeBadge + '</td>' +
                        '<td style="font-family: monospace; color: var(--accent);">' + a.trader.substring(0, 8) + '...</td>' +
                        '<td title="' + (a.title || '') + '">' + displayTitle + '</td>' +
                        '<td>' + (a.outcome || '-') + '</td>' +
                        '<td>$' + a.price.toFixed(2) + '</td>' +
                        '<td>$' + a.value.toFixed(2) + '</td>' +
                        '<td>' + pnlDisplay + '</td>' +
                        '<td>' + roiDisplay + '</td>' +
                    '</tr>';
                }).join('');
            });
        }

        function filterActivity(type, btn) {
            currentActivityFilter = type;
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updateDashboard();
        }

        function filterTable() {
            const input = document.getElementById('search');
            const filter = input.value.toUpperCase();
            const table = document.getElementById('traders-table');
            const tr = table.getElementsByTagName('tr');

            for (let i = 1; i < tr.length; i++) {
                const td = tr[i].getElementsByTagName('td')[0];
                if (td) {
                    const txtValue = td.textContent || td.innerText;
                    if (txtValue.toUpperCase().indexOf(filter) > -1) {
                        tr[i].style.display = "";
                    } else {
                        tr[i].style.display = "none";
                    }
                }
            }
        }

        async function openTraderDetails(address) {
            const modal = document.getElementById('modal');
            const title = document.getElementById('modal-title');
            const tbody = document.querySelector('#modal-table tbody');
            
            title.innerText = 'History: ' + address;
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Loading...</td></tr>';
            modal.style.display = 'block';

            const res = await fetch('/api/trader/' + address);
            const data = await res.json();
            
            if (data.history && data.history.length > 0) {
                tbody.innerHTML = data.history.map(h => 
                    '<tr>' +
                        '<td>' + h.date + '</td>' +
                        '<td>' + h.type + '</td>' +
                        '<td>' + h.asset + '</td>' +
                        '<td>' + (h.outcome || '-') + '</td>' +
                        '<td>$' + h.price + '</td>' +
                        '<td>$' + h.value + '</td>' +
                        '<td class="' + (parseFloat(h.pnl) >= 0 ? 'text-green' : 'text-red') + '">' + h.pnl + '</td>' +
                        '<td class="' + (parseFloat(h.roi) >= 0 ? 'text-green' : 'text-red') + '">' + h.roi + '</td>' +
                        '<td>' + (h.reason || '-') + (h.hash ? ' <span title="' + h.hash + '">#' + h.hash.substring(0, 6) + '</span>' : '') + '</td>' +
                    '</tr>'
                ).join('');
            } else {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">No history found.</td></tr>';
            }
        }

        function closeModal() {
            document.getElementById('modal').style.display = 'none';
        }

        function openDonateModal() {
            document.getElementById('donate-modal').style.display = 'block';
        }

        function closeDonateModal() {
            document.getElementById('donate-modal').style.display = 'none';
        }

        // Close modals when clicking outside
        window.onclick = function(event) {
            const modal = document.getElementById('modal');
            const donateModal = document.getElementById('donate-modal');
            if (event.target == modal) {
                modal.style.display = "none";
            }
            if (event.target == donateModal) {
                donateModal.style.display = "none";
            }
        }
    </script>
</body>
</html>
        `;
    }
}
