import { PolymarketClient } from '../adapters/PolymarketClient';
import Logger from '../core/Logger';
import { ENV } from '../config/env';

const diagnose = async () => {
    try {
        Logger.info('🕵️ Starting CLOB Client Diagnosis...');
        const clobClient = await PolymarketClient.create();

        // Inspect internal properties (using any to bypass private/protected check if needed, though public is better)
        const clientAny = clobClient as any;

        Logger.info('--------------------------------------------------');
        Logger.info(
            `🔑 Signer Address (EOA): ${clobClient.signer ? await clobClient.signer.getAddress() : 'UNDEFINED'}`
        );
        Logger.info(
            `🏦 Funder Address (Configured): ${clientAny.funderAddress || 'UNDEFINED (Defaults to Signer)'}`
        );
        Logger.info(
            `📝 Signature Type: ${clientAny.signatureType} (0=EOA, 1=PolyProxy, 2=GnosisSafe)`
        );
        Logger.info(`🎯 Target Proxy Wallet (Env): ${ENV.PROXY_WALLET}`);
        Logger.info('--------------------------------------------------');

        if (
            clientAny.funderAddress &&
            clientAny.funderAddress.toLowerCase() === ENV.PROXY_WALLET.toLowerCase()
        ) {
            Logger.success('✅ Client is correctly configured to use Proxy Wallet as funder.');
        } else {
            Logger.error('❌ Client is NOT pointing to Proxy Wallet as funder!');
            Logger.error(`   Expected: ${ENV.PROXY_WALLET}`);
            Logger.error(`   Actual:   ${clientAny.funderAddress}`);
            process.exit(1);
        }

        process.exit(0);
    } catch (error) {
        Logger.error(`❌ Diagnosis Failed: ${error}`);
        process.exit(1);
    }
};

diagnose();
