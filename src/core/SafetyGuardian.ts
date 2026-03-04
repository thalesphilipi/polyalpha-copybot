import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import Logger from './Logger';
import fetchData from '../utils/fetchData';
import BotHistory from '../models/botHistory';
import { getUserPositionModel } from '../models/userHistory';

export class SafetyGuardian {
    private clobClient: ClobClient;
    private ignoredPositions = new Set<string>();
    private panicRetries = new Map<string, number>();
    private eventStartCache = new Map<string, number>();

    // Constants
    private readonly PANIC_THRESHOLD = -0.15; // -15% loss (Stop Loss)
    private readonly IGNORE_LOSS_THRESHOLD = -0.80; // Ignore if loss > 80% (likely unsellable)
    private readonly TAKE_PROFIT_THRESHOLD = 0.98; // 98 cents (near $1)
    private readonly PRE_GAME_PROFIT_THRESHOLD = 0.3; // 30% profit secure (pre-game)
    private readonly MIN_ORDER_SIZE = 1; // Minimum size to sell on CLOB
    private readonly MAX_PANIC_RETRIES = 3; // Maximum retries for panic sell

    constructor(clobClient: ClobClient) {
        this.clobClient = clobClient;
    }

    public start() {
        Logger.header('🛡️ STARTING SAFETY GUARDIAN');
        
        setInterval(async () => {
            try {
                await this.checkRisk();
            } catch (error) {
                Logger.error(`Safety Guardian Error: ${error}`);
            }
        }, 20 * 1000); // Run every 20 seconds
    }

    private async getEventStartDate(conditionId: string): Promise<number | null> {
        // 1. Check Cache
        if (this.eventStartCache.has(conditionId)) {
            return this.eventStartCache.get(conditionId) || null;
        }

        try {
            // 2. Fetch from Gamma API
            const url = `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`;
            const data = await fetchData(url);

            if (Array.isArray(data) && data.length > 0) {
                const market = data[0];
                let startDateStr = market.endDate; // Default fallback

                if (market.events && market.events.length > 0 && market.events[0].startDate) {
                    startDateStr = market.events[0].startDate;
                }

                if (startDateStr) {
                    const startTime = new Date(startDateStr).getTime();
                    this.eventStartCache.set(conditionId, startTime);
                    return startTime;
                }
            }
        } catch (error) {
            // Silent fail
        }
        return null;
    }

    private async checkRisk() {
        const proxyWallet = ENV.PROXY_WALLET;
        if (!proxyWallet) return;

        // Fetch positions
        const url = `https://data-api.polymarket.com/positions?user=${proxyWallet}`;
        const data = await fetchData(url);
        const positions = Array.isArray(data) ? (data as any[]) : [];
        const activePositions = positions.filter((p) => p.size >= this.MIN_ORDER_SIZE);

        for (const pos of activePositions) {
            if (this.ignoredPositions.has(pos.asset)) continue;
            if (!pos.avgPrice || pos.avgPrice === 0) continue;

            const pnlPercent = (pos.curPrice - pos.avgPrice) / pos.avgPrice;

            // 1. STOP LOSS
            if (pnlPercent <= this.PANIC_THRESHOLD) {
                if (pnlPercent <= this.IGNORE_LOSS_THRESHOLD) {
                    if (!this.ignoredPositions.has(pos.asset)) {
                        Logger.warning(
                            `💀 Deep Loss Detected: ${pos.title} [${pos.outcome}] (PnL: ${(pnlPercent * 100).toFixed(1)}%). Ignoring permanently.`
                        );
                        this.ignoredPositions.add(pos.asset);
                    }
                    continue;
                }

                if (pnlPercent <= -0.99) {
                    const retries = this.panicRetries.get(pos.asset) || 0;
                    if (retries >= this.MAX_PANIC_RETRIES) {
                        Logger.warning(
                            `⏭️ Ignoring ${pos.title} after ${retries} failed stop loss attempts.`
                        );
                        this.ignoredPositions.add(pos.asset);
                        continue;
                    }
                }

                Logger.warning(`🚨 STOP LOSS TRIGGERED for ${pos.title} [${pos.outcome}]`);
                Logger.warning(
                    `   Current: $${pos.curPrice.toFixed(3)} | Entry: $${pos.avgPrice.toFixed(3)} | PnL: ${(pnlPercent * 100).toFixed(1)}%`
                );

                const success = await this.executeEmergencySell(pos);

                if (!success && pnlPercent <= -0.99) {
                    const currentRetries = (this.panicRetries.get(pos.asset) || 0) + 1;
                    this.panicRetries.set(pos.asset, currentRetries);
                }
            }

            // 2. TAKE PROFIT
            else if (pos.curPrice >= this.TAKE_PROFIT_THRESHOLD && !pos.redeemable) {
                Logger.info(`💰 TAKE PROFIT TRIGGERED for ${pos.title} [${pos.outcome}]`);
                Logger.info(`   Price $${pos.curPrice.toFixed(3)} is near $1.00. Selling to free capital.`);
                await this.executeEmergencySell(pos);
            }

            // 3. PRE-GAME SNIPER
            else if (pnlPercent >= this.PRE_GAME_PROFIT_THRESHOLD) {
                const startTime = await this.getEventStartDate(pos.conditionId);
                if (!startTime) continue;

                const now = Date.now();
                if (now < startTime) {
                    Logger.success(`🎯 PRE-GAME SNIPER TRIGGERED for ${pos.title} [${pos.outcome}]`);
                    Logger.info(`   Game hasn't started yet (Starts: ${new Date(startTime).toLocaleString()})`);
                    Logger.info(`   Current PnL: ${(pnlPercent * 100).toFixed(1)}%`);
                    await this.executeEmergencySell(pos);
                }
            }
        }
    }

    private async executeEmergencySell(pos: any): Promise<boolean> {
        try {
            let orderBook;
            try {
                orderBook = await this.clobClient.getOrderBook(pos.asset);
            } catch (e: unknown) {
                const errStr = e instanceof Error ? e.message : String(e);
                if (errStr.includes('404')) {
                    Logger.warning(`   ⚠️ Market ${pos.asset} not found on CLOB. Ignoring.`);
                    this.ignoredPositions.add(pos.asset);
                    return false;
                }
                Logger.error(`   ❌ Failed to get OrderBook: ${errStr}`);
                return false;
            }

            if (!orderBook || !orderBook.bids || orderBook.bids.length === 0) {
                Logger.warning(`   ❌ No liquidity (bids) to sell ${pos.title}.`);
                if (pos.avgPrice > 0) {
                    const pnl = (pos.curPrice - pos.avgPrice) / pos.avgPrice;
                    if (pnl <= -0.50) {
                        Logger.warning(`   💀 Dead Asset. Ignoring permanently.`);
                        this.ignoredPositions.add(pos.asset);
                        return false;
                    }
                }
                const currentRetries = (this.panicRetries.get(pos.asset) || 0) + 1;
                this.panicRetries.set(pos.asset, currentRetries);
                return false;
            }

            const bestBidPrice = parseFloat(orderBook.bids[0].price);
            if (bestBidPrice <= 0.0001) {
                Logger.warning(`   ❌ Best bid too low ($${bestBidPrice}). Holding.`);
                return false;
            }

            const adjustedPrice = Math.max(0.0001, bestBidPrice * 0.98);

            Logger.info(
                `   📉 Placing Sell Order: ${pos.size.toFixed(2)} shares @ $${adjustedPrice.toFixed(4)}`
            );

            const attemptSell = async (feeRate?: number): Promise<boolean> => {
                try {
                    const order = await this.clobClient.createOrder({
                        tokenID: pos.asset,
                        price: adjustedPrice,
                        side: Side.SELL,
                        size: pos.size,
                        feeRateBps: feeRate,
                        nonce: Date.now(),
                    });

                    const resp = await this.clobClient.postOrder(order, OrderType.GTC);

                    if (resp && resp.success) {
                        Logger.success(`   ✅ Sell Order Placed! ID: ${resp.orderID}`);
                        await this.recordHistory(pos, adjustedPrice, resp.orderID);
                        return true;
                    } else {
                        const errorMsg = resp.errorMsg || JSON.stringify(resp);
                        if (errorMsg.includes('fee rate') && errorMsg.includes('1000') && feeRate !== 1000) {
                            Logger.warning(`   ⚠️ Fee rate mismatch. Retrying with 10% fee...`);
                            return await attemptSell(1000);
                        }
                        Logger.error(`   ❌ Failed to place sell order: ${errorMsg}`);
                        return false;
                    }
                } catch (err) {
                    const errorStr = String(err);
                    if (errorStr.includes('fee rate') && errorStr.includes('1000') && feeRate !== 1000) {
                        return await attemptSell(1000);
                    }
                    if (errorStr.includes('invalid price') || errorStr.includes('min: 0.001')) {
                         Logger.warning(`   ⚠️ Unsellable junk asset. Ignoring.`);
                         this.ignoredPositions.add(pos.asset);
                         return false;
                    }
                    Logger.error(`   ❌ Exception placing sell order: ${errorStr}`);
                    return false;
                }
            };

            return await attemptSell(undefined);

        } catch (error) {
            Logger.error(`   ❌ Failed to execute emergency sell: ${error}`);
            return false;
        }
    }

    private async recordHistory(pos: any, price: number, txHash: string) {
        try {
            let sourceTrader = 'Unknown';
            const USER_ADDRESSES = ENV.USER_ADDRESSES;
            for (const addr of USER_ADDRESSES) {
                const UserPosition = getUserPositionModel(addr);
                const dbPos = await UserPosition.findOne({ asset: pos.asset });
                if (dbPos && (dbPos.size || 0) > 0) {
                    sourceTrader = addr;
                    break;
                }
            }

            const proceeds = pos.size * price;
            const costBasis = pos.size * pos.avgPrice;
            const pnl = proceeds - costBasis;

            await BotHistory.create({
                timestamp: Math.floor(Date.now() / 1000),
                transactionHash: txHash,
                type: 'SELL',
                asset: pos.asset,
                title: pos.title || 'Unknown',
                outcome: pos.outcome || '-',
                price: price,
                amountSize: pos.size,
                amountValue: proceeds,
                sourceTrader: sourceTrader,
                reason: 'SAFETY_GUARDIAN',
                pnl: pnl,
                roi: costBasis > 0 ? (pnl / costBasis) * 100 : 0
            });
        } catch (e) {
            Logger.error(`Failed to record BotHistory: ${e}`);
        }
    }
}
