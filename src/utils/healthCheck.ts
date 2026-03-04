import mongoose from 'mongoose';
import { ENV } from '../config/env';
import getMyBalance from './getMyBalance';
import fetchData from './fetchData';
import Logger from '../core/Logger';
import rpcManager from './rpcManager';

export interface HealthCheckResult {
    healthy: boolean;
    checks: {
        database: { status: 'ok' | 'error'; message: string };
        rpc: { status: 'ok' | 'error'; message: string };
        balance: { status: 'ok' | 'error' | 'warning'; message: string; balance?: number };
        polymarketApi: { status: 'ok' | 'error'; message: string };
    };
    timestamp: number;
}

/**
 * Perform health check on all critical components
 */
export const performHealthCheck = async (): Promise<HealthCheckResult> => {
    const checks: HealthCheckResult['checks'] = {
        database: { status: 'error', message: 'Not checked' },
        rpc: { status: 'error', message: 'Not checked' },
        balance: { status: 'error', message: 'Not checked' },
        polymarketApi: { status: 'error', message: 'Not checked' },
    };

    // Check MongoDB connection
    Logger.info('   • Checking Database...');
    try {
        if (mongoose.connection.readyState === 1) {
            // Ping the database with 5s timeout
            if (mongoose.connection.db) {
                await Promise.race([
                    mongoose.connection.db.admin().ping(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('DB Ping Timeout')), 5000))
                ]);
                checks.database = { status: 'ok', message: 'Connected' };
            } else {
                checks.database = { status: 'error', message: 'Database object not available' };
            }
        } else {
            checks.database = {
                status: 'error',
                message: `Connection state: ${mongoose.connection.readyState}`,
            };
        }
    } catch (error) {
        checks.database = {
            status: 'error',
            message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Check RPC endpoint
    Logger.info('   • Checking RPC Connection...');
    try {
        const provider = await rpcManager.getProvider();
        const network = await provider.getNetwork();
        
        checks.rpc = { 
            status: 'ok', 
            message: `Connected to chain ${network.chainId} (${rpcManager.getCurrentRpcUrl()})` 
        };
    } catch (error) {
        checks.rpc = {
            status: 'error',
            message: `RPC check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Check USDC balance
    Logger.info('   • Checking Wallet Balance...');
    try {
        // Wrap getMyBalance in a timeout race to prevent hanging
        const balance = await Promise.race([
            getMyBalance(ENV.PROXY_WALLET),
            new Promise<number>((_, reject) => setTimeout(() => reject(new Error('Balance Check Timeout')), 10000))
        ]);

        if (balance > 0) {
            if (balance < 10) {
                checks.balance = {
                    status: 'warning',
                    message: `Low balance: $${balance.toFixed(2)}`,
                    balance,
                };
            } else {
                checks.balance = {
                    status: 'ok',
                    message: `Balance: $${balance.toFixed(2)}`,
                    balance,
                };
            }
        } else {
            checks.balance = { status: 'error', message: 'Zero balance' };
        }
    } catch (error) {
        checks.balance = {
            status: 'error',
            message: `Balance check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Check Polymarket API
    Logger.info('   • Checking Polymarket API...');
    try {
        const testUrl =
            'https://data-api.polymarket.com/positions?user=0x0000000000000000000000000000000000000000';
        
        // Wrap fetchData in a timeout race
        await Promise.race([
            fetchData(testUrl),
            new Promise((_, reject) => setTimeout(() => reject(new Error('API Check Timeout')), 10000))
        ]);
        
        checks.polymarketApi = { status: 'ok', message: 'API responding' };
    } catch (error) {
        checks.polymarketApi = {
            status: 'error',
            message: `API check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Determine overall health
    const healthy =
        checks.database.status === 'ok' &&
        checks.rpc.status === 'ok' &&
        checks.balance.status !== 'error' &&
        checks.polymarketApi.status === 'ok';

    return {
        healthy,
        checks,
        timestamp: Date.now(),
    };
};

/**
 * Log health check results
 */
export const logHealthCheck = (result: HealthCheckResult): void => {
    Logger.separator();
    Logger.header('🏥 HEALTH CHECK');
    Logger.info(`Overall Status: ${result.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
    Logger.info(
        `Database: ${result.checks.database.status === 'ok' ? '✅' : '❌'} ${result.checks.database.message}`
    );
    Logger.info(
        `RPC: ${result.checks.rpc.status === 'ok' ? '✅' : '❌'} ${result.checks.rpc.message}`
    );
    Logger.info(
        `Balance: ${result.checks.balance.status === 'ok' ? '✅' : result.checks.balance.status === 'warning' ? '⚠️' : '❌'} ${result.checks.balance.message}`
    );
    Logger.info(
        `Polymarket API: ${result.checks.polymarketApi.status === 'ok' ? '✅' : '❌'} ${result.checks.polymarketApi.message}`
    );
    Logger.separator();
};
