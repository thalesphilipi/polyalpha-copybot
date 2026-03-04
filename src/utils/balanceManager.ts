import { ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import getMyBalance from './getMyBalance';
import Logger from '../core/Logger';

class BalanceManager {
    private static instance: BalanceManager;
    private balance: number = 0;
    private lastUpdate: number = 0;
    private intervalId: NodeJS.Timeout | null = null;
    private isUpdating: boolean = false;
    private clobClient: ClobClient | null = null;

    private constructor() {}

    public static getInstance(): BalanceManager {
        if (!BalanceManager.instance) {
            BalanceManager.instance = new BalanceManager();
        }
        return BalanceManager.instance;
    }

    public setClient(client: ClobClient) {
        this.clobClient = client;
        // Trigger immediate update with new client
        this.updateBalance();
    }

    /**
     * Start periodic balance updates
     * @param intervalMs Interval in milliseconds (default: 30000ms = 30s)
     */
    public start(intervalMs: number = 30000): void {
        if (this.intervalId) return;

        Logger.info('💰 Balance Manager started');
        // Initial fetch
        this.updateBalance();

        this.intervalId = setInterval(() => {
            this.updateBalance();
        }, intervalMs);
    }

    public stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Force an immediate balance update (e.g., after a trade)
     */
    public async updateBalance(): Promise<void> {
        if (this.isUpdating) return;
        this.isUpdating = true;

        try {
            const rawBalance = await getMyBalance(ENV.PROXY_WALLET);
            let lockedBalance = 0;

            if (this.clobClient) {
                try {
                    // Fetch open orders to calculate locked funds
                    // @ts-ignore
                    const openOrders = await this.clobClient.getOpenOrders();
                    
                    if (Array.isArray(openOrders)) {
                        openOrders.forEach((order: any) => {
                            if (order.side === 'BUY') {
                                // Calculate locked amount: Price * Size
                                const price = parseFloat(order.price);
                                const size = parseFloat(order.size); // Remaining size
                                if (!isNaN(price) && !isNaN(size)) {
                                    lockedBalance += price * size;
                                }
                            }
                        });
                    }
                } catch (clobError) {
                    // Silent warning to avoid spam, or debug level
                    // Logger.debug(`⚠️ Failed to fetch open orders: ${clobError}`);
                }
            }

            const availableBalance = Math.max(0, rawBalance - lockedBalance);

            // Only log if changed significantly or if locked funds detected
            if (Math.abs(availableBalance - this.balance) > 0.01 || lockedBalance > 0) {
                if (lockedBalance > 0) {
                     Logger.info(`💰 Balance: Total $${rawBalance.toFixed(2)} - Locked $${lockedBalance.toFixed(2)} = Available $${availableBalance.toFixed(2)}`);
                } else if (Math.abs(availableBalance - this.balance) > 0.01) {
                     // Logger.info(`💰 Balance updated: $${availableBalance.toFixed(2)}`);
                }
            }
            this.balance = availableBalance;
            this.lastUpdate = Date.now();
        } catch (error) {
            Logger.error(`❌ Failed to update balance: ${error}`);
        } finally {
            this.isUpdating = false;
        }
    }

    /**
     * Get the current cached balance
     * @returns Cached balance in USDC
     */
    public getBalance(): number {
        return this.balance;
    }

    /**
     * Check if we have enough funds for a minimum order
     * @returns true if balance >= minOrderSize
     */
    public hasFunds(): boolean {
        const minOrder = ENV.COPY_STRATEGY_CONFIG.minOrderSizeUSD || 1.0;
        return this.balance >= minOrder;
    }
}

export default BalanceManager.getInstance();
