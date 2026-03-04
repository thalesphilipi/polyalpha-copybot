import { ethers } from 'ethers';
import { ENV } from '../config/env';
import Logger from '../core/Logger';
import rpcManager from './rpcManager';

const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const getMyBalance = async (address: string): Promise<number> => {
    let retry = 0;
    const maxRetries = 3;

    while (retry < maxRetries) {
        try {
            const rpcProvider = await rpcManager.getProvider();
            const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, rpcProvider);
            const balance_usdc = await usdcContract.balanceOf(address);
            const balance_usdc_real = ethers.utils.formatUnits(balance_usdc, 6);
            return parseFloat(balance_usdc_real);
        } catch (error) {
            retry++;
            const errorMessage = String(error);
            Logger.warning(`⚠️  Failed to fetch balance (Attempt ${retry}/${maxRetries}): ${errorMessage.slice(0, 100)}...`);
            
            // Force rotation if it was an RPC error
            if (errorMessage.includes('429') || errorMessage.includes('network') || errorMessage.includes('timeout')) {
                // RpcManager will handle rotation on next call if we implement a way to signal failure, 
                // but getProvider() verifies connection before returning. 
                // However, if getProvider returned a provider that fails on specific call, we might want to reset it.
                // But for now, let's just rely on retry loop which calls getProvider again.
                // Ideally RpcManager should expose a 'reportError' method, but checking getProvider's internal logic:
                // it checks this.provider.getNetwork() at start. So if provider is dead, it rotates.
            }

            if (retry >= maxRetries) {
                Logger.error(`❌ Failed to fetch balance after ${maxRetries} attempts.`);
                // Return 0 so we don't crash, but trading will likely be skipped due to insufficient funds check later
                return 0; 
            }
            
            // Wait before retry
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
    return 0;
};

export default getMyBalance;
