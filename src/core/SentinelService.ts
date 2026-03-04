import { ethers } from 'ethers';
import mongoose from 'mongoose';
import { ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import Logger from './Logger';
import postOrder from '../utils/postOrder';
import fetchData from '../utils/fetchData';
import { getUserActivityModel } from '../models/userHistory';
import { UserActivityInterface } from '../interfaces/User';
import rpcManager from '../utils/rpcManager';
import BalanceManager from '../utils/balanceManager';

export class SentinelService {
    private isRunning: boolean = true;
    private provider: ethers.providers.WebSocketProvider | ethers.providers.JsonRpcProvider | null = null;
    private contract: ethers.Contract | null = null;
    private retryCount: number = 0;
    private clobClient: ClobClient;
    private readonly CONDITIONAL_TOKENS_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

    constructor(clobClient: ClobClient) {
        this.clobClient = clobClient;
    }

    public async start() {
        Logger.info('🛡️  Sentinel Service starting...');
        const useWs = !!ENV.WS_RPC_URL && this.retryCount < 3;
        
        if (!!ENV.WS_RPC_URL && this.retryCount >= 3) {
            Logger.warning('⚠️  Too many WS failures (429/Error). Switching to Polling Mode (HTTP) for stability.');
        }

        Logger.info(
            `   • Mode: ${useWs ? 'WebSocket (Real-time)' : 'Polling (Block-time)'}`
        );
        Logger.info(`   • Monitoring: ${ENV.USER_ADDRESSES.length} traders`);
        Logger.info(`   • Contract: Conditional Tokens (ERC1155)`);

        try {
            if (useWs) {
                const wsUrl = ENV.WS_RPC_URL!;
                const wsProvider = new ethers.providers.WebSocketProvider(wsUrl);
                this.provider = wsProvider;
                
                wsProvider._websocket.on('open', () => {
                    Logger.success('Sentinel WS Connected');
                    setTimeout(() => {
                        if (this.isRunning && this.retryCount > 0) {
                            this.retryCount = 0;
                            Logger.info('Sentinel WS Connection Stable. Resetting retry count.');
                        }
                    }, 60000);
                });

                wsProvider._websocket.on('error', (e: Error) => {
                    const delay = this.getRetryDelay();
                    Logger.error(`Sentinel WS Error: ${e}`);
                    Logger.info(`Reconnecting in ${delay / 1000}s...`);
                    this.stop();
                    
                    if (String(e).includes('429') || String(e).includes('Too Many Requests')) {
                        this.retryCount += 2; 
                    }
                    
                    setTimeout(() => this.start(), delay);
                });

                wsProvider._websocket.on('close', () => {
                    const delay = this.getRetryDelay();
                    Logger.warning(`Sentinel WS Closed. Reconnecting in ${delay / 1000}s...`);
                    this.stop();
                    setTimeout(() => this.start(), delay);
                });

            } else {
                this.provider = await rpcManager.getProvider();
            }

            const abi = [
                'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
                'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
            ];

            this.contract = new ethers.Contract(this.CONDITIONAL_TOKENS_ADDRESS, abi, this.provider);

            this.contract.on(
                'TransferSingle',
                async (operator, from, to, id, value, event) => {
                    if (!this.isRunning) return;

                    const fromLower = from.toLowerCase();
                    const toLower = to.toLowerCase();
                    const assetId = id.toString();
                    const amount = parseFloat(ethers.utils.formatUnits(value, 0));

                    let side: 'BUY' | 'SELL' | null = null;
                    let trader: string | null = null;
                    const USER_ADDRESSES = ENV.USER_ADDRESSES.map(a => a.toLowerCase());

                    if (USER_ADDRESSES.includes(toLower)) {
                        side = 'BUY';
                        trader = toLower;
                    } else if (USER_ADDRESSES.includes(fromLower)) {
                        side = 'SELL';
                        trader = fromLower;
                    }

                    if (side && trader) {
                        Logger.header('🛡️  SENTINEL DETECTED ACTIVITY');
                        Logger.info(`Trader: ${trader}`);
                        Logger.info(`Action: ${side} ${amount} raw units`);
                        Logger.info(`Asset: ${assetId}`);
                        Logger.info(`Tx: ${event.transactionHash}`);

                        await this.executeSentinelTrade(
                            assetId,
                            amount,
                            side,
                            trader,
                            event.transactionHash
                        );
                    }
                }
            );

        } catch (error) {
            const delay = this.getRetryDelay();
            Logger.error(`Sentinel Service Error: ${error}`);
            Logger.info(`Reconnecting in ${delay / 1000}s...`);
            setTimeout(() => this.start(), delay);
        }
    }

    public stop() {
        this.isRunning = false;
        Logger.info('Sentinel Service stopping...');
        
        if (this.contract) {
            this.contract.removeAllListeners();
            this.contract = null;
        }

        if (this.provider) {
            if (this.provider instanceof ethers.providers.WebSocketProvider) {
                 try {
                    this.provider._websocket.removeAllListeners();
                    this.provider.destroy();
                 } catch (e) {
                    // Ignore cleanup errors
                 }
            }
            this.provider = null;
        }
    }

    private getRetryDelay() {
        const delay = Math.min(5000 * Math.pow(2, this.retryCount), 60000);
        this.retryCount++;
        return delay;
    }

    private async executeSentinelTrade(
        assetId: string,
        amount: number, // raw units
        side: 'BUY' | 'SELL',
        traderAddress: string,
        txHash: string
    ) {
        try {
            // 🛑 FAST FAIL: Check Balance Before Processing BUYs
            if (side === 'BUY' && !BalanceManager.hasFunds()) {
                // Silently skip BUYs when balance is low
                return;
            }
    
            // 1. Get current market data to estimate price
            let orderBook;
            let retry = 0;
            const maxRetries = 3;
    
            while (retry < maxRetries) {
                try {
                    orderBook = await this.clobClient.getOrderBook(assetId);
                    break; // Success
                } catch (error) {
                    const errStr = String(error);
                    if (errStr.includes('404') || errStr.includes('No orderbook')) {
                         // Real 404, stop retrying
                         Logger.warning(`Sentinel: Could not get orderbook for ${assetId} (likely 404/AMM-only)`);
                         return;
                    }
                    
                    // Network error, retry
                    retry++;
                    Logger.warning(`Sentinel: Orderbook fetch failed (Attempt ${retry}/${maxRetries}): ${errStr.slice(0, 50)}...`);
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
    
            if (!orderBook) {
                 Logger.warning(`Sentinel: Empty orderbook response for ${assetId} after retries`);
                 return;
            }
    
            let currentPrice = 0.5;
    
            if (side === 'BUY' && orderBook.asks && orderBook.asks.length > 0) {
                currentPrice = parseFloat(orderBook.asks[0].price);
            } else if (side === 'SELL' && orderBook.bids && orderBook.bids.length > 0) {
                currentPrice = parseFloat(orderBook.bids[0].price);
            } else {
                 Logger.warning(`Sentinel: No liquidity (asks/bids) for ${assetId}, assuming $0.50 for stats`);
            }
    
            // 2. Construct synthetic trade
            // amount is raw units. Polymarket CTF tokens are 6 decimals (USDC collateral).
            // So size = amount / 1e6.
            const size = amount / 1000000;
            const estimatedUsdcSize = size * currentPrice;
    
            const trade: UserActivityInterface = {
                _id: new mongoose.Types.ObjectId(),
                type: 'TRADE',
                asset: assetId,
                side: side,
                size: size,
                price: currentPrice,
                usdcSize: estimatedUsdcSize,
                timestamp: Date.now(),
                user: traderAddress,
                transactionHash: txHash,
                conditionId: '', // Unknown without API
                slug: 'sentinel-detected',
                originalSize: amount,
                newSize: 0,
                ready: true,
                bot: true, // Mark as handled
                botExcutedTime: 0,
            } as any; // Cast because UserActivityInterface might be strict
    
            // Save to DB
            try {
                const UserActivity = getUserActivityModel(traderAddress);
                const exists = await UserActivity.findOne({ transactionHash: txHash });
                if (!exists) {
                    await UserActivity.create(trade);
                } else {
                    Logger.warning(
                        `Sentinel: Trade already exists in DB for tx ${txHash}`
                    );
                    if (exists.bot) return;
                }
            } catch (dbError) {
                Logger.warning(`Sentinel: DB save warning: ${dbError}`);
            }
    
            // 3. Get my status
            const my_balance = BalanceManager.getBalance();
            
            let my_position;
            try {
                const my_positions = await fetchData(
                    `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`
                );
                if (Array.isArray(my_positions)) {
                    my_position = my_positions.find((p: any) => p.asset === assetId);
                }
            } catch (posError) {
                Logger.warning(`Sentinel: Failed to fetch positions, assuming 0 exposure: ${posError}`);
            }
    
            // 4. Execute
            await postOrder(
                this.clobClient,
                side === 'BUY' ? 'buy' : 'sell',
                my_position,
                undefined, // user_position unknown
                trade,
                my_balance,
                0,
                traderAddress
            );
        } catch (error) {
            Logger.error(`Sentinel Execution Failed: ${error}`);
        }
    }
}
