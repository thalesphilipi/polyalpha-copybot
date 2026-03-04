import * as dotenv from 'dotenv';
dotenv.config();

import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import { PolymarketClient } from './adapters/PolymarketClient';
import { OrderDispatcher } from './core/OrderDispatcher';
import { MarketWatcher } from './core/MarketWatcher';
import { SentinelService } from './core/SentinelService';
import { DashboardService } from './core/DashboardService';
import { SafetyGuardian } from './core/SafetyGuardian';
import { ProfitClaimer } from './core/ProfitClaimer';
import Logger from './core/Logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';
import BalanceManager from './utils/balanceManager';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PROXY_WALLET = ENV.PROXY_WALLET;

// Graceful shutdown handler
let isShuttingDown = false;
let marketWatcher: MarketWatcher;
let sentinelService: SentinelService;
let orderDispatcher: OrderDispatcher;
let dashboardService: DashboardService;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        Logger.warning('Shutdown already in progress, forcing exit...');
        process.exit(1);
    }

    isShuttingDown = true;
    Logger.separator();
    Logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
        // Stop services
        if (marketWatcher) marketWatcher.stop();
        if (sentinelService) sentinelService.stop();
        // OrderDispatcher doesn't have a stop method in the interface we saw, 
        // but we can assume it stops when the process exits or add one later.
        
        // Give services time to finish current operations
        Logger.info('Waiting for services to finish current operations...');
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Close database connection
        await closeDB();

        Logger.success('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        Logger.error(`Error during shutdown: ${error}`);
        process.exit(1);
    }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
    Logger.error(`Uncaught Exception: ${error.message}`);
    gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
    });
});

// Handle termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export const main = async () => {
    try {
        // Welcome message
        Logger.startup(USER_ADDRESSES, PROXY_WALLET);

        console.log('Connecting to DB...');
        await connectDB();
        console.log('DB Connected.');

        // Perform initial health check
        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);

        if (!healthResult.healthy) {
            Logger.warning('Health check failed, but continuing startup...');
        }

        Logger.info('Initializing CLOB client...');
        const clobClient = await PolymarketClient.create();
        Logger.success('CLOB Client initialized');

        // Inject CLOB client into BalanceManager to track locked funds
        BalanceManager.setClient(clobClient);

        // Initialize Services
        marketWatcher = new MarketWatcher();
        sentinelService = new SentinelService(clobClient);
        orderDispatcher = new OrderDispatcher(clobClient);
        dashboardService = new DashboardService();

        // Start Services
        Logger.header('🚀 STARTING CORE SERVICES');
        
        // 1. Dashboard
        dashboardService.start();

        // 2. Order Dispatcher (Trade Execution)
        orderDispatcher.start();

        // 3. Market Watcher (Trade Monitor)
        marketWatcher.start();

        // 4. Sentinel Service (Real-time Blockchain Monitor)
        sentinelService.start();

        // 5. Background Services
        Logger.info('Starting Background Services...');
        new ProfitClaimer().start();
        new SafetyGuardian(clobClient).start();

        Logger.success('All services started successfully');

    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        process.exit(1);
    }
};

main();
