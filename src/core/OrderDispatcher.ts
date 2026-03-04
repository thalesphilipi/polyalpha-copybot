import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import BalanceManager from '../utils/balanceManager';
import postOrder from '../utils/postOrder';
import Logger from './Logger';

interface TradeWithUser extends UserActivityInterface {
    userAddress: string;
}

interface AggregatedTrade {
    userAddress: string;
    conditionId: string;
    asset: string;
    side: string;
    slug?: string;
    eventSlug?: string;
    trades: TradeWithUser[];
    totalUsdcSize: number;
    averagePrice: number;
    firstTradeTime: number;
    lastTradeTime: number;
}

export class OrderDispatcher {
    private isRunning: boolean = true;
    private userActivityModels: any[];
    private tradeAggregationBuffer: Map<string, AggregatedTrade> = new Map();
    private clobClient: ClobClient;
    private TRADE_AGGREGATION_MIN_TOTAL_USD = 1.0;

    constructor(clobClient: ClobClient) {
        this.clobClient = clobClient;
        this.userActivityModels = ENV.USER_ADDRESSES.map((address) => ({
            address,
            model: getUserActivityModel(address),
        }));
    }

    public async start() {
        Logger.success(`OrderDispatcher ready for ${ENV.USER_ADDRESSES.length} trader(s)`);
        if (ENV.TRADE_AGGREGATION_ENABLED) {
            Logger.info(
                `Trade aggregation enabled: ${ENV.TRADE_AGGREGATION_WINDOW_SECONDS}s window, $${this.TRADE_AGGREGATION_MIN_TOTAL_USD} minimum`
            );
        }

        let lastCheck = Date.now();
        while (this.isRunning) {
            const trades = await this.readTempTrades();

            if (ENV.TRADE_AGGREGATION_ENABLED) {
                // Process with aggregation logic
                if (trades.length > 0) {
                    Logger.clearLine();
                    Logger.info(
                        `📥 ${trades.length} new trade${trades.length > 1 ? 's' : ''} detected`
                    );

                    // Add trades to aggregation buffer
                    for (const trade of trades) {
                        // Only aggregate BUY trades below minimum threshold
                        if (trade.side === 'BUY' && trade.usdcSize < this.TRADE_AGGREGATION_MIN_TOTAL_USD) {
                            Logger.info(
                                `Adding $${trade.usdcSize.toFixed(2)} ${trade.side} trade to aggregation buffer for ${trade.slug || trade.asset}`
                            );
                            this.addToAggregationBuffer(trade);
                        } else {
                            // Execute large trades immediately (not aggregated)
                            Logger.clearLine();
                            Logger.header(`⚡ IMMEDIATE TRADE (above threshold)`);
                            await this.doTrading([trade]);
                        }
                    }
                    lastCheck = Date.now();
                }

                // Check for ready aggregated trades
                const readyAggregations = this.getReadyAggregatedTrades();
                if (readyAggregations.length > 0) {
                    Logger.clearLine();
                    Logger.header(
                        `⚡ ${readyAggregations.length} AGGREGATED TRADE${readyAggregations.length > 1 ? 'S' : ''} READY`
                    );
                    await this.doAggregatedTrading(readyAggregations);
                    lastCheck = Date.now();
                }

                // Update waiting message
                if (trades.length === 0 && readyAggregations.length === 0) {
                    if (Date.now() - lastCheck > 300) {
                        const bufferedCount = this.tradeAggregationBuffer.size;
                        if (bufferedCount > 0) {
                            Logger.waiting(
                                ENV.USER_ADDRESSES.length,
                                `${bufferedCount} trade group(s) pending`
                            );
                        } else {
                            Logger.waiting(ENV.USER_ADDRESSES.length);
                        }
                        lastCheck = Date.now();
                    }
                }
            } else {
                // Original non-aggregation logic
                if (trades.length > 0) {
                    Logger.clearLine();
                    Logger.header(
                        `⚡ ${trades.length} NEW TRADE${trades.length > 1 ? 'S' : ''} TO COPY`
                    );
                    await this.doTrading(trades);
                    lastCheck = Date.now();
                } else {
                    // Update waiting message every 300ms for smooth animation
                    if (Date.now() - lastCheck > 300) {
                        Logger.waiting(ENV.USER_ADDRESSES.length);
                        lastCheck = Date.now();
                    }
                }
            }

            if (!this.isRunning) break;
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        Logger.info('OrderDispatcher stopped');
    }

    public stop() {
        this.isRunning = false;
        Logger.info('OrderDispatcher shutdown requested...');
    }

    private async readTempTrades(): Promise<TradeWithUser[]> {
        const allTrades: TradeWithUser[] = [];

        for (const { address, model } of this.userActivityModels) {
            // Only get trades that haven't been processed yet (bot: false AND botExcutedTime: 0)
            const trades = await model
                .find({
                    $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: 0 }],
                })
                .exec();

            const tradesWithUser = trades.map((trade: any) => ({
                ...(trade.toObject() as UserActivityInterface),
                userAddress: address,
            }));

            allTrades.push(...tradesWithUser);
        }

        return allTrades;
    }

    private getAggregationKey(trade: TradeWithUser): string {
        return `${trade.userAddress}:${trade.conditionId}:${trade.asset}:${trade.side}`;
    }

    private addToAggregationBuffer(trade: TradeWithUser): void {
        const key = this.getAggregationKey(trade);
        const existing = this.tradeAggregationBuffer.get(key);
        const now = Date.now();

        if (existing) {
            existing.trades.push(trade);
            existing.totalUsdcSize += trade.usdcSize;
            const totalValue = existing.trades.reduce((sum, t) => sum + t.usdcSize * t.price, 0);
            existing.averagePrice = totalValue / existing.totalUsdcSize;
            existing.lastTradeTime = now;
        } else {
            this.tradeAggregationBuffer.set(key, {
                userAddress: trade.userAddress,
                conditionId: trade.conditionId,
                asset: trade.asset,
                side: trade.side || 'BUY',
                slug: trade.slug,
                eventSlug: trade.eventSlug,
                trades: [trade],
                totalUsdcSize: trade.usdcSize,
                averagePrice: trade.price,
                firstTradeTime: now,
                lastTradeTime: now,
            });
        }
    }

    private getReadyAggregatedTrades(): AggregatedTrade[] {
        const ready: AggregatedTrade[] = [];
        const now = Date.now();
        const windowMs = ENV.TRADE_AGGREGATION_WINDOW_SECONDS * 1000;

        for (const [key, agg] of this.tradeAggregationBuffer.entries()) {
            const timeElapsed = now - agg.firstTradeTime;

            if (timeElapsed >= windowMs) {
                if (agg.totalUsdcSize >= this.TRADE_AGGREGATION_MIN_TOTAL_USD) {
                    ready.push(agg);
                } else {
                    Logger.info(
                        `Trade aggregation for ${agg.userAddress} on ${agg.slug || agg.asset}: $${agg.totalUsdcSize.toFixed(2)} total from ${agg.trades.length} trades below minimum ($${this.TRADE_AGGREGATION_MIN_TOTAL_USD}) - skipping`
                    );

                    for (const trade of agg.trades) {
                        const UserActivity = getUserActivityModel(trade.userAddress);
                        UserActivity.updateOne({ _id: trade._id }, { bot: true }).exec();
                    }
                }
                this.tradeAggregationBuffer.delete(key);
            }
        }

        return ready;
    }

    private async doTrading(trades: TradeWithUser[]) {
        for (const trade of trades) {
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });

            Logger.trade(trade.userAddress, trade.side || 'UNKNOWN', {
                asset: trade.asset,
                side: trade.side,
                amount: trade.usdcSize,
                price: trade.price,
                slug: trade.slug,
                eventSlug: trade.eventSlug,
                transactionHash: trade.transactionHash,
            });

            const my_positions: UserPositionInterface[] = await fetchData(
                `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`
            );
            const user_positions: UserPositionInterface[] = await fetchData(
                `https://data-api.polymarket.com/positions?user=${trade.userAddress}`
            );
            const my_position = my_positions.find(
                (position: UserPositionInterface) => position.conditionId === trade.conditionId
            );
            const user_position = user_positions.find(
                (position: UserPositionInterface) => position.conditionId === trade.conditionId
            );

            const my_balance = BalanceManager.getBalance();

            if (trade.side === 'BUY' && !BalanceManager.hasFunds()) {
                await UserActivity.updateOne({ _id: trade._id }, { $set: { bot: true, botExcutedTime: 999 } });
                continue;
            }

            const user_balance = user_positions.reduce((total, pos) => {
                return total + (pos.currentValue || 0);
            }, 0);

            Logger.balance(my_balance, user_balance, trade.userAddress);

            await postOrder(
                this.clobClient,
                trade.side === 'BUY' ? 'buy' : 'sell',
                my_position,
                user_position,
                trade,
                my_balance,
                user_balance,
                trade.userAddress
            );

            Logger.separator();
        }
    }

    private async doAggregatedTrading(aggregatedTrades: AggregatedTrade[]) {
        for (const agg of aggregatedTrades) {
            Logger.header(`📊 AGGREGATED TRADE (${agg.trades.length} trades combined)`);
            Logger.info(`Market: ${agg.slug || agg.asset}`);
            Logger.info(`Side: ${agg.side}`);
            Logger.info(`Total volume: $${agg.totalUsdcSize.toFixed(2)}`);
            Logger.info(`Average price: $${agg.averagePrice.toFixed(4)}`);

            for (const trade of agg.trades) {
                const UserActivity = getUserActivityModel(trade.userAddress);
                await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });
            }

            const my_positions: UserPositionInterface[] = await fetchData(
                `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`
            );
            const user_positions: UserPositionInterface[] = await fetchData(
                `https://data-api.polymarket.com/positions?user=${agg.userAddress}`
            );
            const my_position = my_positions.find(
                (position: UserPositionInterface) => position.conditionId === agg.conditionId
            );
            const user_position = user_positions.find(
                (position: UserPositionInterface) => position.conditionId === agg.conditionId
            );

            const my_balance = BalanceManager.getBalance();

            if (agg.side === 'BUY' && !BalanceManager.hasFunds()) {
                Logger.warning(`⚠️ Skipping aggregated execution for ${agg.slug}: Insufficient funds ($${my_balance.toFixed(2)})`);
                for (const trade of agg.trades) {
                    const UserActivity = getUserActivityModel(trade.userAddress);
                    await UserActivity.updateOne({ _id: trade._id }, { $set: { bot: true, botExcutedTime: 999 } });
                }
                Logger.separator();
                continue;
            }

            const user_balance = user_positions.reduce((total, pos) => {
                return total + (pos.currentValue || 0);
            }, 0);

            Logger.balance(my_balance, user_balance, agg.userAddress);

            const syntheticTrade: UserActivityInterface = {
                ...agg.trades[0],
                usdcSize: agg.totalUsdcSize,
                price: agg.averagePrice,
                side: agg.side as 'BUY' | 'SELL',
            };

            await postOrder(
                this.clobClient,
                agg.side === 'BUY' ? 'buy' : 'sell',
                my_position,
                user_position,
                syntheticTrade,
                my_balance,
                user_balance,
                agg.userAddress
            );

            Logger.separator();
        }
    }
}
