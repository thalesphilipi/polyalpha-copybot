import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';
import RpcManager from '../utils/rpcManager';

export class PolymarketClient {
    private static async getSignatureType(proxyWallet: string): Promise<number> {
        try {
            const provider = await RpcManager.getProvider();
            const code = await provider.getCode(proxyWallet);
            
            if (code === '0x') return SignatureType.EOA;
            
            try {
                // Check for Gnosis Safe via VERSION (0xa081d6aa)
                const raw = await provider.call({ to: proxyWallet, data: '0xa081d6aa' });
                if (raw && raw !== '0x') return SignatureType.POLY_GNOSIS_SAFE;

                // Check for Gnosis Safe via getOwners (0xa0e67e2b) - Fallback for some proxies
                const ownersData = await provider.call({ to: proxyWallet, data: '0xa0e67e2b' });
                if (ownersData && ownersData !== '0x') return SignatureType.POLY_GNOSIS_SAFE;
            } catch (ignored) {}
            
            return SignatureType.POLY_PROXY;
        } catch (error) {
            console.error(`Error detecting signature type: ${error}`);
            return SignatureType.POLY_PROXY; // Default to PolyProxy
        }
    }

    public static async create(): Promise<ClobClient> {
        const chainId = 137;
        const host = ENV.CLOB_HTTP_URL as string;
        const provider = await RpcManager.getProvider();
        const wallet = new ethers.Wallet(ENV.PRIVATE_KEY as string, provider);
        const proxyWallet = ENV.PROXY_WALLET as string;

        const signatureType = await PolymarketClient.getSignatureType(proxyWallet);

        let clobClient = new ClobClient(
            host,
            chainId,
            wallet,
            undefined,
            signatureType,
            proxyWallet
        );

        // Suppress console.error during key creation/derivation
        const originalConsoleError = console.error;
        console.error = function () {};
        
        let creds = await clobClient.createApiKey();
        
        if (!creds.key) {
            creds = await clobClient.deriveApiKey();
        }
        
        console.error = originalConsoleError;

        clobClient = new ClobClient(
            host,
            chainId,
            wallet,
            creds,
            signatureType,
            proxyWallet
        );

        return clobClient;
    }
}
