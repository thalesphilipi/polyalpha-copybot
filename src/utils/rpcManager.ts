import { ethers } from 'ethers';
import { ENV } from '../config/env';
import Logger from '../core/Logger';

// User provided RPCs + Public Fallbacks
const DEFAULT_RPCS = [
    // Premium User RPCs
    'https://polygon-mainnet.g.alchemy.com/v2/-c9IQblX8KBHaD1B96G51',
    'https://blue-cool-sea.matic.quiknode.pro/b111abf28e45495183f5f0ff449cc7a8a7e2e8f6/',
    // Public Fallbacks
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon-rpc.com',
    'https://rpc.ankr.com/polygon',
    'https://1rpc.io/matic',
];

class RpcManager {
    private rpcs: string[];
    private currentRpcIndex: number = 0;
    private provider: ethers.providers.JsonRpcProvider | null = null;

    constructor() {
        // Start with ENV.RPC_URL if defined, then add defaults unique list
        const envRpc = ENV.RPC_URL;
        const allRpcs = envRpc ? [envRpc, ...DEFAULT_RPCS] : DEFAULT_RPCS;
        // Deduplicate
        this.rpcs = [...new Set(allRpcs)];
    }

    public async getProvider(): Promise<ethers.providers.JsonRpcProvider> {
        if (this.provider) {
            try {
                // Lightweight check
                await this.provider.getNetwork();
                return this.provider;
            } catch (error) {
                Logger.warning(
                    `Current RPC ${this.rpcs[this.currentRpcIndex]} failed, rotating...`
                );
                this.provider = null;
            }
        }

        // Try to find a working RPC
        for (let i = 0; i < this.rpcs.length; i++) {
            // Start from current index to avoid resetting every time, but loop around
            const index = (this.currentRpcIndex + i) % this.rpcs.length;
            const url = this.rpcs[index];

            try {
                Logger.info(`Testing RPC connection: ${url}`);
                const connection = {
                    url: url,
                    timeout: 10000 // 10 seconds global timeout for all requests
                };
                const tempProvider = new ethers.providers.JsonRpcProvider(connection);
                
                // Race the network check against a 4-second timeout for the initial validation
                await Promise.race([
                    tempProvider.getNetwork(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('RPC Connection Timeout')), 4000))
                ]);

                this.currentRpcIndex = index;
                this.provider = tempProvider;
                Logger.info(`✅ Connected to RPC: ${url}`);
                return this.provider;
            } catch (error) {
                Logger.warning(`❌ Failed to connect to ${url}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        throw new Error('All RPCs failed. Please check your internet connection or RPC list.');
    }

    public getCurrentRpcUrl(): string {
        return this.rpcs[this.currentRpcIndex];
    }
}

export default new RpcManager();
