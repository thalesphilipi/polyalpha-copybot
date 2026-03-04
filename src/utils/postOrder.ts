import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import BotHistory from '../models/botHistory';
import Logger from '../core/Logger';
import { calculateOrderSize, getTradeMultiplier } from '../strategy/CopyStrategy';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;
const COPY_STRATEGY_CONFIG = ENV.COPY_STRATEGY_CONFIG;

// Legacy parameters (for backward compatibility in SELL logic)
const TRADE_MULTIPLIER = ENV.TRADE_MULTIPLIER;
const COPY_PERCENTAGE = ENV.COPY_PERCENTAGE;

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_USD = 1.0; // Minimum order size in USD for BUY orders
const MIN_ORDER_SIZE_TOKENS = 1.0; // Minimum order size in tokens for SELL/MERGE orders

// Track last buy timestamp per asset to prevent duplicate/burst buys
const lastBuyTimestamps = new Map<string, number>();
const BUY_COOLDOWN_MS = 30 * 1000; // 30 seconds cooldown per asset

// Track recent buys locally to compensate for API lag (simulating real-time position updates)
const recentBuys = new Map<string, { timestamp: number; value: number }[]>();
const RECENT_BUY_WINDOW_MS = 60 * 1000; // Consider buys "pending" for 60s

const getRecentBuyValue = (asset: string): number => {
    const buys = recentBuys.get(asset) || [];
    const now = Date.now();
    const validBuys = buys.filter((b) => now - b.timestamp < RECENT_BUY_WINDOW_MS);

    // Update map with cleaned list
    if (validBuys.length !== buys.length) {
        if (validBuys.length === 0) recentBuys.delete(asset);
        else recentBuys.set(asset, validBuys);
    }

    return validBuys.reduce((sum, b) => sum + b.value, 0);
};

const addRecentBuy = (asset: string, value: number) => {
    const buys = recentBuys.get(asset) || [];
    buys.push({ timestamp: Date.now(), value });
    recentBuys.set(asset, buys);
};

// Track assets that are uncopyable (e.g. AMM-only, no orderbook)
const uncopyableAssets = new Set<string>();

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) {
        return undefined;
    }

    if (typeof response === 'string') {
        return response;
    }

    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;

        const directError = data.error;
        if (typeof directError === 'string') {
            return directError;
        }

        if (typeof directError === 'object' && directError !== null) {
            const nested = directError as Record<string, unknown>;
            if (typeof nested.error === 'string') {
                return nested.error;
            }
            if (typeof nested.message === 'string') {
                return nested.message;
            }
        }

        if (typeof data.errorMsg === 'string') {
            return data.errorMsg;
        }

        if (typeof data.message === 'string') {
            return data.message;
        }
    }

    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message: string | undefined): boolean => {
    if (!message) {
        return false;
    }
    const lower = message.toLowerCase();
    return lower.includes('not enough balance') || lower.includes('allowance');
};

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number,
    userAddress: string
) => {
    const UserActivity = getUserActivityModel(userAddress);

    // Skip known uncopyable assets (AMM-only, Neg Risk, etc.)
    if (uncopyableAssets.has(trade.asset)) {
        Logger.warning(`⏭️  Skipping uncopyable asset ${trade.asset.slice(0, 8)}... (no CLOB orderbook)`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        return;
    }

    //Merge strategy
    if (condition === 'merge') {
        Logger.info('Executing MERGE strategy...');
        if (!my_position) {
            Logger.warning('No position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }
        let remaining = my_position.size;

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `Position size (${remaining.toFixed(2)} tokens) too small to merge - skipping`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let retry = 0;
        let abortDueToFunds = false;
        let totalSoldTokens = 0;
        let totalSoldValue = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                Logger.warning('No bids available in order book');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            Logger.info(`Best bid: ${maxPriceBid.size} @ $${maxPriceBid.price}`);
            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            // Order args logged internally
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                totalSoldTokens += order_arges.amount;
                totalSoldValue += order_arges.amount * order_arges.price;
                Logger.orderResult(
                    true,
                    `Sold ${order_arges.amount} tokens at $${order_arges.price}`
                );

                // --- RECORD BOT HISTORY (SELL/MERGE) ---
                try {
                    const costBasis = my_position.avgPrice * order_arges.amount;
                    const proceeds = order_arges.amount * order_arges.price;
                    const pnl = proceeds - costBasis;
                    
                    await BotHistory.create({
                        timestamp: Math.floor(Date.now() / 1000),
                        transactionHash: resp.orderID,
                        type: 'SELL',
                        asset: my_position.asset,
                        title: trade.title || my_position.title,
                        outcome: trade.outcome || my_position.outcome,
                        price: order_arges.price,
                        amountSize: order_arges.amount,
                        amountValue: proceeds,
                        sourceTrader: userAddress,
                        reason: 'COPY',
                        pnl: pnl,
                        roi: costBasis > 0 ? (pnl / costBasis) * 100 : 0
                    });

                    // --- DONATION REMINDER (NAGWARE) ---
                    if (pnl > 0) {
                         Logger.info(chalk.green('💰 Profit Realized! ' + pnl.toFixed(2) + ' USDC'));
                         if (pnl > 5) { // Only ask if profit > $5
                             Logger.info(chalk.yellow('🌟 Hey! You just made money using this free bot.'));
                              Logger.info(chalk.yellow('☕ Consider buying me a coffee to keep updates coming:'));
                              Logger.info(chalk.cyan('   EVM Wallet: 0x5da643C6d0E72C18fa5D63178Ea116e1309BD9d0'));
                              Logger.info(chalk.blue('   Join our Community: https://discord.gg/y2pKtgTYEE'));
                          }
                    }
                    // -----------------------------------
                } catch (e) {
                    Logger.error(`Failed to record BotHistory for MERGE: ${e}`);
                }
                // ---------------------------------------

                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.error(
                        `❌ Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                    );
                    Logger.error('❌ THIS IS A CRITICAL ERROR. The bot cannot trade.');
                    Logger.error(
                        '💡 Please run: `npm run check-allowance` to approve USDC spending.'
                    );

                    // Mark as processed but fail
                    await UserActivity.updateOne(
                        { _id: trade._id },
                        { bot: true, botExcutedTime: RETRY_LIMIT }
                    );

                    // Throw error to stop the bot or handle upstream?
                    // No, we just break and let the next trade fail too? No, that's spam.
                    // We should probably just log heavily.
                    break;
                }
                retry += 1;
                Logger.warning(
                    `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                {
                    bot: true,
                    botExcutedTime: RETRY_LIMIT,
                    mySoldSize: totalSoldTokens,
                    mySoldValue: totalSoldValue,
                }
            );
            return;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne(
                { _id: trade._id },
                {
                    bot: true,
                    botExcutedTime: retry,
                    mySoldSize: totalSoldTokens,
                    mySoldValue: totalSoldValue,
                }
            );
        } else {
            await UserActivity.updateOne(
                { _id: trade._id },
                {
                    bot: true,
                    mySoldSize: totalSoldTokens,
                    mySoldValue: totalSoldValue,
                }
            );
        }
    } else if (condition === 'buy') {
        //Buy strategy
        Logger.info('Executing BUY strategy...');

        Logger.info(`Your balance: $${my_balance.toFixed(2)}`);
        Logger.info(`Trader bought: $${trade.usdcSize.toFixed(2)}`);

        // COOLDOWN CHECK: Prevent buying the same asset multiple times in quick succession
        const lastBuy = lastBuyTimestamps.get(trade.asset);
        const now = Date.now();
        if (lastBuy && now - lastBuy < BUY_COOLDOWN_MS) {
            Logger.warning(
                `⏳ BUY blocked by cooldown for ${trade.asset} (Last buy: ${((now - lastBuy) / 1000).toFixed(1)}s ago)`
            );
            Logger.warning(`   Skipping to prevent over-exposure from burst trades.`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Get current position size for position limit checks
        let currentPositionValue = my_position ? my_position.size * my_position.avgPrice : 0;

        // Add recent pending buys to current position value (compensate for API lag)
        const pendingBuysValue = getRecentBuyValue(trade.asset);
        if (pendingBuysValue > 0) {
            Logger.info(
                `➕ Adding $${pendingBuysValue.toFixed(2)} pending buys to current position ($${currentPositionValue.toFixed(2)})`
            );
            currentPositionValue += pendingBuysValue;
        }

        // Use new copy strategy system
        const orderCalc = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            my_balance,
            currentPositionValue
        );

        // Log the calculation reasoning
        Logger.info(`📊 ${orderCalc.reasoning}`);

        // Check if order should be executed
        if (orderCalc.finalAmount === 0) {
            Logger.warning(`❌ Cannot execute: ${orderCalc.reasoning}`);
            if (orderCalc.belowMinimum) {
                Logger.warning(`💡 Increase COPY_SIZE or wait for larger trades`);
            }
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let remaining = orderCalc.finalAmount;

        let retry = 0;
        let abortDueToFunds = false;
        let totalBoughtTokens = 0; // Track total tokens bought for this trade

        while (remaining > 0 && retry < RETRY_LIMIT) {
            let orderBook;
            try {
                orderBook = await clobClient.getOrderBook(trade.asset);
            } catch (error) {
                const errStr = String(error);
                if (errStr.includes('404') || errStr.includes('No orderbook')) {
                    Logger.warning(
                        `⏭️  AMM-only market (no CLOB orderbook) for ${trade.slug || trade.asset.slice(0, 12)}... — skipping permanently.`
                    );
                    uncopyableAssets.add(trade.asset);
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    return;
                }
                
                // For other network errors, log but respect retry limit
                Logger.warning(`⚠️  Failed to fetch orderbook: ${error} (Attempt ${retry + 1}/${RETRY_LIMIT})`);
                
                // Small delay before retry to avoid hammering API
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                retry += 1;
                continue;
            }

            if (!orderBook || !orderBook.asks || orderBook.asks.length === 0) {
                // Empty orderbook - likely AMM or resolved market. Mark uncopyable.
                Logger.warning(`⏭️  Empty orderbook for ${trade.slug || trade.asset.slice(0, 12)}... — marking uncopyable.`);
                uncopyableAssets.add(trade.asset);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return;
            }

            // Sort asks by price (ascending) to find best prices
            const sortedAsks = orderBook.asks.sort(
                (a, b) => parseFloat(a.price) - parseFloat(b.price)
            );
            const bestAsk = sortedAsks[0];

            Logger.info(`Best ask: ${bestAsk.size} @ $${bestAsk.price}`);

            // Check if remaining amount is below minimum (1.0)
            if (remaining < MIN_ORDER_SIZE_USD) {
                Logger.info(
                    `Remaining amount ($${remaining.toFixed(2)}) below minimum - completing trade`
                );
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { bot: true, myBoughtSize: totalBoughtTokens }
                );
                break;
            }

            // Find enough liquidity to fill at least MIN_ORDER_SIZE_USD
            let accumulatedLiquidity = 0;
            let targetPrice = parseFloat(bestAsk.price);

            for (const ask of sortedAsks) {
                accumulatedLiquidity += parseFloat(ask.size) * parseFloat(ask.price);
                targetPrice = parseFloat(ask.price);

                // Stop if we have enough to fill either the remaining amount OR the minimum required amount
                // We prioritize filling 'remaining', but if 'remaining' > MIN, we just need to find enough to make a valid order
                if (
                    accumulatedLiquidity >=
                    Math.max(MIN_ORDER_SIZE_USD, Math.min(remaining, accumulatedLiquidity))
                ) {
                    if (accumulatedLiquidity >= remaining) break;
                }
            }

            // Check slippage — skip if market moved too far from when trader bought
            if (targetPrice - 0.05 > trade.price) {
                Logger.warning(
                    `Price slippage too high (Target: $${targetPrice.toFixed(4)}, Trader paid: $${trade.price}) — skipping`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return;
            }


            if (accumulatedLiquidity < MIN_ORDER_SIZE_USD) {
                Logger.warning(
                    `Not enough liquidity ($${accumulatedLiquidity.toFixed(2)}) to fill minimum order ($${MIN_ORDER_SIZE_USD}) — skipping`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return;
            }

            const orderSize = Math.min(remaining, accumulatedLiquidity);

            const order_arges = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: orderSize,
                price: targetPrice,
            };

            Logger.info(
                `Creating order: $${orderSize.toFixed(2)} @ $${targetPrice} (Balance: $${my_balance.toFixed(2)})`
            );

            // Order args logged internally
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                const tokensBought = order_arges.amount / order_arges.price;
                totalBoughtTokens += tokensBought;
                Logger.orderResult(
                    true,
                    `Bought $${order_arges.amount.toFixed(2)} at $${order_arges.price} (${tokensBought.toFixed(2)} tokens)`
                );

                // --- RECORD BOT HISTORY (BUY) ---
                try {
                    await BotHistory.create({
                        timestamp: Math.floor(Date.now() / 1000),
                        transactionHash: resp.orderID,
                        type: 'BUY',
                        asset: trade.asset,
                        title: trade.title,
                        outcome: trade.outcome,
                        price: order_arges.price,
                        amountSize: tokensBought,
                        amountValue: order_arges.amount, // USDC Value
                        sourceTrader: userAddress,
                        reason: 'COPY',
                        fee: 0 // TBD if we can get fee
                    });
                } catch (e) {
                    Logger.error(`Failed to record BotHistory for BUY: ${e}`);
                }
                // ---------------------------------------

                // Set cooldown timestamp
                lastBuyTimestamps.set(trade.asset, Date.now());

                // Track recent buy for position limits (diversification)
                addRecentBuy(trade.asset, order_arges.amount);

                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.error(
                        `❌ Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                    );
                    Logger.error('❌ THIS IS A CRITICAL ERROR. The bot cannot trade.');
                    Logger.error(
                        '💡 Please run: `npm run check-allowance` to approve USDC spending.'
                    );
                    
                    // Force balance refresh
                    await import('./balanceManager').then(m => m.default.updateBalance());

                    // Log failure to DB for dashboard visibility
                    try {
                        await BotHistory.create({
                            timestamp: Math.floor(Date.now() / 1000),
                            transactionHash: '',
                            type: 'BUY',
                            asset: trade.asset,
                            title: trade.title,
                            outcome: trade.outcome,
                            price: order_arges.price,
                            amountSize: 0,
                            amountValue: order_arges.amount,
                            sourceTrader: userAddress,
                            reason: 'ERROR',
                            status: 'FAILED',
                            error: errorMessage || 'Insufficient balance/allowance'
                        });
                    } catch (dbErr) {
                        Logger.error(`Failed to log error to DB: ${dbErr}`);
                    }

                    // Force mark as bot=true so we don't retry THIS trade
                    await UserActivity.updateOne(
                        { _id: trade._id },
                        { bot: true, botExcutedTime: RETRY_LIMIT }
                    );

                    // STOP EXECUTION?
                    // We can return early.
                    return;
                }
                retry += 1;
                Logger.warning(
                    `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT, myBoughtSize: totalBoughtTokens }
            );
            return;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: retry, myBoughtSize: totalBoughtTokens }
            );
        } else {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, myBoughtSize: totalBoughtTokens }
            );
        }

        // Log the tracked purchase for later sell reference
        if (totalBoughtTokens > 0) {
            Logger.info(
                `📝 Tracked purchase: ${totalBoughtTokens.toFixed(2)} tokens for future sell calculations`
            );
        }
    } else if (condition === 'sell') {
        //Sell strategy
        Logger.info('Executing SELL strategy...');
        let remaining = 0;
        if (!my_position) {
            Logger.warning('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Get all previous BUY trades for this asset to calculate total bought
        const previousBuys = await UserActivity.find({
            asset: trade.asset,
            conditionId: trade.conditionId,
            side: 'BUY',
            bot: true,
            myBoughtSize: { $exists: true, $gt: 0 },
        }).exec();

        const totalBoughtTokens = previousBuys.reduce(
            (sum, buy) => sum + (buy.myBoughtSize || 0),
            0
        );

        if (totalBoughtTokens > 0) {
            Logger.info(
                `📊 Found ${previousBuys.length} previous purchases: ${totalBoughtTokens.toFixed(2)} tokens bought`
            );
        }

        if (!user_position) {
            // Trader sold entire position - we sell entire position too
            remaining = my_position.size;
            Logger.info(
                `Trader closed entire position → Selling all your ${remaining.toFixed(2)} tokens`
            );
        } else {
            // Calculate the % of position the trader is selling
            const trader_sell_percent = trade.size / (user_position.size + trade.size);
            const trader_position_before = user_position.size + trade.size;

            Logger.info(
                `Position comparison: Trader has ${trader_position_before.toFixed(2)} tokens, You have ${my_position.size.toFixed(2)} tokens`
            );
            Logger.info(
                `Trader selling: ${trade.size.toFixed(2)} tokens (${(trader_sell_percent * 100).toFixed(2)}% of their position)`
            );

            // Use tracked bought tokens if available, otherwise fallback to current position
            let baseSellSize;
            if (totalBoughtTokens > 0) {
                baseSellSize = totalBoughtTokens * trader_sell_percent;
                Logger.info(
                    `Calculating from tracked purchases: ${totalBoughtTokens.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
                );
            } else {
                baseSellSize = my_position.size * trader_sell_percent;
                Logger.warning(
                    `No tracked purchases found, using current position: ${my_position.size.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
                );
            }

            // Apply tiered or single multiplier based on trader's order size (symmetrical with BUY logic)
            const multiplier = getTradeMultiplier(COPY_STRATEGY_CONFIG, trade.usdcSize);
            remaining = baseSellSize * multiplier;

            if (multiplier !== 1.0) {
                Logger.info(
                    `Applying ${multiplier}x multiplier (based on trader's $${trade.usdcSize.toFixed(2)} order): ${baseSellSize.toFixed(2)} → ${remaining.toFixed(2)} tokens`
                );
            }
        }

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `❌ Cannot execute: Sell amount ${remaining.toFixed(2)} tokens below minimum (${MIN_ORDER_SIZE_TOKENS} token)`
            );
            Logger.warning(`💡 This happens when position sizes are too small or mismatched`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Cap sell amount to available position size
        if (remaining > my_position.size) {
            Logger.warning(
                `⚠️  Calculated sell ${remaining.toFixed(2)} tokens > Your position ${my_position.size.toFixed(2)} tokens`
            );
            Logger.warning(`Capping to maximum available: ${my_position.size.toFixed(2)} tokens`);
            remaining = my_position.size;
        }

        let retry = 0;
        let abortDueToFunds = false;
        let totalSoldTokens = 0; // Track total tokens sold
        let totalSoldValue = 0; // Track total USD value sold

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                Logger.warning('No bids available in order book');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            const bestBidPrice = parseFloat(maxPriceBid.price);

            Logger.info(`Best bid: ${maxPriceBid.size} @ $${bestBidPrice}`);

            // 🛑 SAFETY CHECK: Ignore sales at near-zero prices (unless it's a manual panic sell, but this is copy trade)
            // If the best bid is below $0.02, we assume the position is dead or it's a bad trade to copy.
            if (bestBidPrice < 0.02) {
                Logger.warning(`🛑 BLOCKED: Best bid price $${bestBidPrice} is too low (< $0.02).`);
                Logger.warning(`   Skipping copy sell to prevent selling for free.`);
                Logger.warning(`   Better to hold in case of a miracle recovery.`);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return;
            }

            // Check if remaining amount is below minimum before creating order
            if (remaining < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `Remaining amount (${remaining.toFixed(2)} tokens) below minimum - completing trade`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const sellAmount = Math.min(remaining, parseFloat(maxPriceBid.size));

            // Final check: don't create orders below minimum
            if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `Order amount (${sellAmount.toFixed(2)} tokens) below minimum - completing trade`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const order_arges = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sellAmount,
                price: parseFloat(maxPriceBid.price),
            };
            // Order args logged internally
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                totalSoldTokens += order_arges.amount;
                totalSoldValue += order_arges.amount * order_arges.price;
                Logger.orderResult(
                    true,
                    `Sold ${order_arges.amount} tokens at $${order_arges.price}`
                );
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.error(
                        `❌ Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                    );
                    Logger.error('❌ CRITICAL: USDC Allowance missing or Balance too low.');

                    // Mark trade as processed so we don't retry IT
                    await UserActivity.updateOne(
                        { _id: trade._id },
                        { bot: true, botExcutedTime: RETRY_LIMIT }
                    );
                    return; // Stop processing this trade
                }
                retry += 1;
                Logger.warning(
                    `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }

        // Update tracked purchases after successful sell
        if (totalSoldTokens > 0 && totalBoughtTokens > 0) {
            const sellPercentage = totalSoldTokens / totalBoughtTokens;

            if (sellPercentage >= 0.99) {
                // Sold essentially all tracked tokens - clear tracking
                await UserActivity.updateMany(
                    {
                        asset: trade.asset,
                        conditionId: trade.conditionId,
                        side: 'BUY',
                        bot: true,
                        myBoughtSize: { $exists: true, $gt: 0 },
                    },
                    { $set: { myBoughtSize: 0 } }
                );
                Logger.info(
                    `🧹 Cleared purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of position)`
                );
            } else {
                // Partial sell - reduce tracked purchases proportionally
                for (const buy of previousBuys) {
                    const newSize = (buy.myBoughtSize || 0) * (1 - sellPercentage);
                    await UserActivity.updateOne(
                        { _id: buy._id },
                        { $set: { myBoughtSize: newSize } }
                    );
                }
                Logger.info(
                    `📝 Updated purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of tracked position)`
                );
            }
        }

        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                {
                    bot: true,
                    botExcutedTime: RETRY_LIMIT,
                    mySoldSize: totalSoldTokens,
                    mySoldValue: totalSoldValue,
                }
            );
            return;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne(
                { _id: trade._id },
                {
                    bot: true,
                    botExcutedTime: retry,
                    mySoldSize: totalSoldTokens,
                    mySoldValue: totalSoldValue,
                }
            );
        } else {
            await UserActivity.updateOne(
                { _id: trade._id },
                {
                    bot: true,
                    mySoldSize: totalSoldTokens,
                    mySoldValue: totalSoldValue,
                }
            );
        }
    } else {
        Logger.error(`Unknown condition: ${condition}`);
    }
};

export default postOrder;
