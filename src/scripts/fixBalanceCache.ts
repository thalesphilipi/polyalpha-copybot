import { ethers } from 'ethers';
import { AssetType, ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { PolymarketClient } from '../adapters/PolymarketClient';
import Logger from '../core/Logger';

const main = async () => {
    Logger.info('🔧 Starting CLOB Balance/Allowance Cache Fix...');

    try {
        const clobClient = await PolymarketClient.create();

        // 1. Force update balance/allowance on CLOB
        Logger.info('🔄 Force updating CLOB Balance/Allowance cache...');

        // Use AssetType.COLLATERAL enum (which maps to correct value)
        // checkAllowance.ts used: const updateParams = { asset_type: AssetType.COLLATERAL } as const;
        const updateParams = {
            asset_type: AssetType.COLLATERAL,
        } as const;

        try {
            // @ts-ignore
            const updateRes = await clobClient.updateBalanceAllowance(updateParams);
            Logger.success(`✅ Update response: ${JSON.stringify(updateRes)}`);
        } catch (e: any) {
            Logger.error(`❌ Update failed: ${e.message}`);
        }

        // 2. Cancel all open orders to unlock funds
        Logger.info('🛑 Cancelling all open orders...');
        try {
            const cancelRes = await clobClient.cancelAll();
            Logger.success(`✅ Cancel result: ${JSON.stringify(cancelRes)}`);
        } catch (e: any) {
            Logger.error(`❌ Cancel failed: ${e.message}`);
        }

        // 3. Fetch updated balance from CLOB to verify
        Logger.info('📉 Fetching updated balance from CLOB...');
        try {
            // @ts-ignore
            const balanceRes = await clobClient.getBalanceAllowance(updateParams);
            Logger.info(`📊 CLOB Balance Status: ${JSON.stringify(balanceRes, null, 2)}`);

            // Check if balance matches 3.71
            // @ts-ignore
            if (balanceRes && typeof balanceRes === 'object') {
                Logger.info(
                    `👉 Please check if the balance matches your expectation on Polymarket.com`
                );
            }
        } catch (e: any) {
            Logger.error(`❌ Fetch balance failed: ${e.message}`);
        }
    } catch (error) {
        Logger.error(`🔥 Fatal Error: ${error}`);
    }
};

main();
