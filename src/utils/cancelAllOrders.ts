import { ClobClient } from '@polymarket/clob-client';
import { PolymarketClient } from '../adapters/PolymarketClient';
import Logger from '../core/Logger';
import { getUserActivityModel } from '../models/userHistory';
import mongoose from 'mongoose';
import { ENV } from '../config/env';
import dotenv from 'dotenv';

dotenv.config();

const cancelAllAndReset = async () => {
    try {
        Logger.info('🛑 STARTING FULL RESET...');

        // 1. Connect to Database
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(ENV.MONGO_URI as string);
            Logger.success('📦 Connected to MongoDB');
        }

        // 2. Initialize CLOB Client
        const clobClient = await PolymarketClient.create();
        Logger.info('🔌 CLOB Client Initialized');

        // 3. Cancel ALL Open Orders
        Logger.info('🗑️ Canceling ALL Open Orders...');
        try {
            const resp = await clobClient.cancelAll();
            Logger.success(`✅ Cancel All Response: ${JSON.stringify(resp)}`);
        } catch (e) {
            Logger.error(`❌ Failed to cancel orders (might be none open): ${e}`);
        }

        // 4. Clear Database (User said "limpar tudo do 0")
        Logger.info('🧹 Clearing Database Records...');

        // We need to clear collections for ALL tracked users.
        const userAddresses = ENV.USER_ADDRESSES || [];
        if (userAddresses.length === 0) {
            Logger.warning('⚠️ No USER_ADDRESSES found in env to clear.');
        }

        for (const address of userAddresses) {
            const trimmedAddress = address.trim();
            if (!trimmedAddress) continue;

            const UserActivity = getUserActivityModel(trimmedAddress);
            const deleteResult = await UserActivity.deleteMany({});
            Logger.success(
                `✅ Deleted ${deleteResult.deletedCount} records for trader ${trimmedAddress}`
            );
        }

        Logger.success('🚀 FULL RESET COMPLETE. Bot is ready to start fresh.');
        process.exit(0);
    } catch (error) {
        Logger.error(`❌ FATAL ERROR DURING RESET: ${error}`);
        process.exit(1);
    }
};

cancelAllAndReset();
