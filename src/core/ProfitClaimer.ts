import { ethers } from 'ethers';
import { ENV } from '../config/env';
import Logger from './Logger';
import RpcManager from '../utils/rpcManager';
import fetchData from '../utils/fetchData';
import { isGnosisSafe, executeGnosisTransaction } from '../utils/gnosis';
import { SignatureType } from '@polymarket/order-utils';
import BotHistory from '../models/botHistory';
import { getUserPositionModel } from '../models/userHistory';

export class ProfitClaimer {
    private readonly CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
    private readonly USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    private readonly CTF_ABI = [
        'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
    ];

    public start() {
        Logger.header('🔄 STARTING PROFIT CLAIMER');
        
        // Run periodically
        setInterval(async () => {
            try {
                await this.checkAndRedeem();
            } catch (error) {
                Logger.error(`Profit Claimer Error: ${error}`);
            }
        }, 60 * 1000); // Every 1 minute

        // Run immediately
        this.checkAndRedeem();
    }

    private async checkAndRedeem() {
        const proxyWallet = ENV.PROXY_WALLET;
        if (!proxyWallet) return;

        Logger.info('🔍 Checking for redeemable positions...');

        // 1. Fetch positions
        const url = `https://data-api.polymarket.com/positions?user=${proxyWallet}`;
        const data = await fetchData(url);
        const positions = Array.isArray(data) ? (data as any[]) : [];

        // 2. Filter redeemable
        const redeemablePositions = positions.filter((p) => p.size > 0.0001 && p.redeemable === true);

        if (redeemablePositions.length === 0) {
            Logger.info('✅ No positions to redeem.');
            return;
        }

        Logger.info(`Found ${redeemablePositions.length} positions to redeem.`);

        // 3. Group by Condition ID
        const positionsByCondition = new Map<string, any[]>();
        redeemablePositions.forEach((p) => {
            const existing = positionsByCondition.get(p.conditionId) || [];
            existing.push(p);
            positionsByCondition.set(p.conditionId, existing);
        });

        // 4. Execute Redemption
        const provider = await RpcManager.getProvider();
        const wallet = new ethers.Wallet(ENV.PRIVATE_KEY as string, provider);
        const ctfInterface = new ethers.utils.Interface(this.CTF_ABI);
        const ctfContract = new ethers.Contract(this.CTF_CONTRACT_ADDRESS, this.CTF_ABI, wallet);

        const safeType = await isGnosisSafe(proxyWallet);
        const isSafe = safeType === SignatureType.POLY_GNOSIS_SAFE;

        if (isSafe) {
            Logger.info(`   🔒 Detected Gnosis Safe Proxy: ${proxyWallet}`);
        } else {
            Logger.info(`   👤 Using EOA/Standard Proxy: ${proxyWallet}`);
        }

        for (const [conditionId, conditionPositions] of positionsByCondition.entries()) {
            try {
                Logger.info(`Redeeming condition: ${conditionId}`);

                const conditionIdBytes32 = ethers.utils.hexZeroPad(
                    ethers.BigNumber.from(conditionId).toHexString(),
                    32
                );
                const parentCollectionId = ethers.constants.HashZero;
                const indexSets = [1, 2];

                let txHash = '';

                if (isSafe) {
                    const data = ctfInterface.encodeFunctionData('redeemPositions', [
                        this.USDC_ADDRESS,
                        parentCollectionId,
                        conditionIdBytes32,
                        indexSets
                    ]);
                    await executeGnosisTransaction(proxyWallet, this.CTF_CONTRACT_ADDRESS, data, wallet, provider);
                    txHash = 'GNOSIS_TX'; // We might get hash from executeGnosisTransaction if updated
                } else {
                    const feeData = await provider.getFeeData();
                    const gasPrice = feeData.gasPrice?.mul(200).div(100) || undefined;
                    const nonce = await wallet.getTransactionCount();

                    const tx = await ctfContract.redeemPositions(
                        this.USDC_ADDRESS,
                        parentCollectionId,
                        conditionIdBytes32,
                        indexSets,
                        { gasPrice, nonce }
                    );
                    Logger.success(`Redemption Tx Sent: ${tx.hash}`);
                    await tx.wait();
                    Logger.success(`✅ Successfully redeemed condition ${conditionId}`);
                    txHash = tx.hash;
                }

                // Record History
                await this.recordHistory(conditionId, txHash);

            } catch (error) {
                Logger.error(`❌ Failed to redeem condition ${conditionId}: ${error}`);
            }
        }
    }

    private async recordHistory(conditionId: string, txHash: string) {
        try {
            const USER_ADDRESSES = ENV.USER_ADDRESSES;
            for (const addr of USER_ADDRESSES) {
                const UserPosition = getUserPositionModel(addr);
                const dbPositions = await UserPosition.find({ conditionId: conditionId, size: { $gt: 0 } });
                
                for (const pos of dbPositions) {
                    const size = pos.size || 0;
                    const avgPrice = pos.avgPrice || 0;
                    
                    const proceeds = size * 1.0; 
                    const costBasis = size * avgPrice;
                    const pnl = proceeds - costBasis;

                    await BotHistory.create({
                        timestamp: Math.floor(Date.now() / 1000),
                        transactionHash: txHash,
                        type: 'REDEEM',
                        asset: pos.asset,
                        title: pos.title || 'Unknown',
                        outcome: pos.outcome || 'Winner',
                        price: 1.0,
                        amountSize: pos.size,
                        amountValue: proceeds,
                        sourceTrader: addr,
                        reason: 'PROFIT_CLAIMER',
                        pnl: pnl,
                        roi: costBasis > 0 ? (pnl / costBasis) * 100 : 0
                    });
                }
            }
        } catch (e) {
            Logger.error(`Failed to record BotHistory for REDEMPTION: ${e}`);
        }
    }
}
