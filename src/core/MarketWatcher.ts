import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from './Logger';
import BalanceManager from '../utils/balanceManager';

export class MarketWatcher {
    private isRunning: boolean = true;
    private isFirstRun: boolean = true;
    private userModels: any[];
    private readonly FETCH_INTERVAL = ENV.FETCH_INTERVAL || 1;
    private readonly MAX_TRADE_AGE_SECONDS = ENV.MAX_TRADE_AGE_SECONDS || 60;

    constructor() {
        if (!ENV.USER_ADDRESSES || ENV.USER_ADDRESSES.length === 0) {
            throw new Error('USER_ADDRESSES is not defined or empty');
        }

        this.userModels = ENV.USER_ADDRESSES.map((address) => ({
            address,
            UserActivity: getUserActivityModel(address),
            UserPosition: getUserPositionModel(address),
        }));
    }

    public async start() {
        await this.init();
        Logger.success(`Monitoring ${ENV.USER_ADDRESSES.length} trader(s) every ${this.FETCH_INTERVAL}s`);
        Logger.separator();

        if (this.isFirstRun) {
            Logger.info('First run: marking all historical trades as processed...');
            for (const { address, UserActivity } of this.userModels) {
                const count = await UserActivity.updateMany(
                    { bot: false },
                    { $set: { bot: true, botExcutedTime: 999 } }
                );
                // Also initialize the position models if needed? No, just trades.
                if (count.modifiedCount > 0) {
                    // Logger.info(
                    //     `Marked ${count.modifiedCount} historical trades as processed for ${address.slice(0, 6)}...${address.slice(-4)}`
                    // );
                }
            }
            this.isFirstRun = false;
            Logger.success('\nHistorical trades processed. Now monitoring for new trades only.');
            Logger.separator();
        }

        while (this.isRunning) {
            await this.fetchTradeData();
            if (!this.isRunning) break;
            await new Promise((resolve) => setTimeout(resolve, this.FETCH_INTERVAL * 1000));
        }

        Logger.info('MarketWatcher stopped');
    }

    public stop() {
        this.isRunning = false;
        Logger.info('MarketWatcher shutdown requested...');
    }

    private async init() {
        const counts: number[] = [];
        for (const { address, UserActivity } of this.userModels) {
            const count = await UserActivity.countDocuments();
            counts.push(count);
        }
        Logger.clearLine();
        Logger.dbConnection(ENV.USER_ADDRESSES, counts);

        // Show your own positions first
        try {
            const myPositionsUrl = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
            const myPositions = await fetchData(myPositionsUrl);

            // Get current USDC balance
            await BalanceManager.updateBalance();
            const currentBalance = BalanceManager.getBalance();

            if (Array.isArray(myPositions) && myPositions.length > 0) {
                // Calculate your overall profitability and initial investment
                let totalValue = 0;
                let initialValue = 0;
                let weightedPnl = 0;
                myPositions.forEach((pos: any) => {
                    const value = pos.currentValue || 0;
                    const initial = pos.initialValue || 0;
                    const pnl = pos.percentPnl || 0;
                    totalValue += value;
                    initialValue += initial;
                    weightedPnl += value * pnl;
                });
                const myOverallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;

                // Get top 5 positions by profitability (PnL)
                const myTopPositions = myPositions
                    .sort((a: any, b: any) => (b.percentPnl || 0) - (a.percentPnl || 0))
                    .slice(0, 5);

                Logger.clearLine();
                Logger.myPositions(
                    ENV.PROXY_WALLET,
                    myPositions.length,
                    myTopPositions,
                    myOverallPnl,
                    totalValue,
                    initialValue,
                    currentBalance
                );
            } else {
                Logger.clearLine();
                Logger.myPositions(ENV.PROXY_WALLET, 0, [], 0, 0, 0, currentBalance);
            }
        } catch (error) {
            Logger.error(`Failed to fetch your positions: ${error}`);
        }

        // Show current positions count with details for traders you're copying
        const positionCounts: number[] = [];
        const positionDetails: any[][] = [];
        const profitabilities: number[] = [];
        for (const { address, UserPosition } of this.userModels) {
            const positions = await UserPosition.find().exec();
            positionCounts.push(positions.length);

            // Calculate overall profitability (weighted average by current value)
            let totalValue = 0;
            let weightedPnl = 0;
            positions.forEach((pos: any) => {
                const value = pos.currentValue || 0;
                const pnl = pos.percentPnl || 0;
                totalValue += value;
                weightedPnl += value * pnl;
            });
            const overallPnl = totalValue > 0 ? weightedPnl / totalValue : 0;
            profitabilities.push(overallPnl);

            // Get top 3 positions by profitability (PnL)
            const topPositions = positions
                .sort((a: any, b: any) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 3)
                .map((p: any) => p.toObject());
            positionDetails.push(topPositions);
        }
        Logger.clearLine();
        Logger.tradersPositions(ENV.USER_ADDRESSES, positionCounts, positionDetails, profitabilities);
    }

    private async fetchTradeData() {
        for (const { address, UserActivity, UserPosition } of this.userModels) {
            try {
                // Fetch trade activities from Polymarket API
                const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`;
                const activities = await fetchData(apiUrl);

                if (!Array.isArray(activities) || activities.length === 0) {
                    continue;
                }

                // Process each activity
                const nowSeconds = Math.floor(Date.now() / 1000);
                const cutoffTimestamp = nowSeconds - this.MAX_TRADE_AGE_SECONDS;

                for (const activity of activities) {
                    // Skip if too old
                    if (activity.timestamp < cutoffTimestamp) {
                        const age = nowSeconds - activity.timestamp;
                        if (age < 600) {
                            // Only log if somewhat recent (< 10 min) to avoid spam
                        }
                        continue;
                    }

                    // Check if this trade already exists in database
                    const existingActivity = await UserActivity.findOne({
                        transactionHash: activity.transactionHash,
                    }).exec();

                    if (existingActivity) {
                        continue; // Already processed this trade
                    }

                    // 🛑 FAST FAIL: Check Balance Before Processing BUYs
                    // Only for BUY orders. SELL orders bring money back, so we always process them.
                    if (activity.side === 'BUY' && !BalanceManager.hasFunds()) {
                        // Silently skip BUYs when balance is low
                        const skippedActivity = new UserActivity({
                            proxyWallet: activity.proxyWallet,
                            timestamp: activity.timestamp,
                            conditionId: activity.conditionId,
                            type: activity.type,
                            size: activity.size,
                            usdcSize: activity.usdcSize,
                            transactionHash: activity.transactionHash,
                            price: activity.price,
                            asset: activity.asset,
                            side: activity.side,
                            outcomeIndex: activity.outcomeIndex,
                            title: activity.title,
                            slug: activity.slug,
                            icon: activity.icon,
                            eventSlug: activity.eventSlug,
                            outcome: activity.outcome,
                            name: activity.name,
                            pseudonym: activity.pseudonym,
                            bio: activity.bio,
                            profileImage: activity.profileImage,
                            profileImageOptimized: activity.profileImageOptimized,
                            bot: true, // Mark as processed so we don't see it again
                            botExcutedTime: 999, // Special code for "Skipped due to Low Balance"
                        });
                        
                        try {
                            await skippedActivity.save();
                        } catch (e) {
                            // Ignore save errors
                        }
                        continue; 
                    }

                    // Save new trade to database
                    const newActivity = new UserActivity({
                        proxyWallet: activity.proxyWallet,
                        timestamp: activity.timestamp,
                        conditionId: activity.conditionId,
                        type: activity.type,
                        size: activity.size,
                        usdcSize: activity.usdcSize,
                        transactionHash: activity.transactionHash,
                        price: activity.price,
                        asset: activity.asset,
                        side: activity.side,
                        outcomeIndex: activity.outcomeIndex,
                        title: activity.title,
                        slug: activity.slug,
                        icon: activity.icon,
                        eventSlug: activity.eventSlug,
                        outcome: activity.outcome,
                        name: activity.name,
                        pseudonym: activity.pseudonym,
                        bio: activity.bio,
                        profileImage: activity.profileImage,
                        profileImageOptimized: activity.profileImageOptimized,
                        bot: false,
                        botExcutedTime: 0,
                    });

                    await newActivity.save();
                    Logger.info(`New trade detected for ${address.slice(0, 6)}...${address.slice(-4)}`);
                }

                // Also fetch and update positions
                const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
                const positions = await fetchData(positionsUrl);

                if (Array.isArray(positions) && positions.length > 0) {
                    for (const position of positions) {
                        // Update or create position
                        await UserPosition.findOneAndUpdate(
                            { asset: position.asset, conditionId: position.conditionId },
                            {
                                proxyWallet: position.proxyWallet,
                                asset: position.asset,
                                conditionId: position.conditionId,
                                size: position.size,
                                avgPrice: position.avgPrice,
                                initialValue: position.initialValue,
                                currentValue: position.currentValue,
                                cashPnl: position.cashPnl,
                                percentPnl: position.percentPnl,
                                totalBought: position.totalBought,
                                realizedPnl: position.realizedPnl,
                                percentRealizedPnl: position.percentRealizedPnl,
                                curPrice: position.curPrice,
                                redeemable: position.redeemable,
                                mergeable: position.mergeable,
                                title: position.title,
                                slug: position.slug,
                                icon: position.icon,
                                eventSlug: position.eventSlug,
                                outcome: position.outcome,
                                outcomeIndex: position.outcomeIndex,
                                oppositeOutcome: position.oppositeOutcome,
                                oppositeAsset: position.oppositeAsset,
                                endDate: position.endDate,
                                negativeRisk: position.negativeRisk,
                            },
                            { upsert: true }
                        );
                    }
                }
            } catch (error) {
                Logger.error(
                    `Error fetching data for ${address.slice(0, 6)}...${address.slice(-4)}: ${error}`
                );
            }
        }
    }
}
