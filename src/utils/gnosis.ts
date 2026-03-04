import { ethers } from 'ethers';
import Logger from '../core/Logger';
import RpcManager from './rpcManager';
import { SignatureType } from '@polymarket/order-utils';

export const GNOSIS_SAFE_ABI = [
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
    'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) public view returns (bytes32)',
    'function nonce() public view returns (uint256)',
    'function getOwners() view returns (address[])',
];

/**
 * Determines if a wallet is a Gnosis Safe by checking if it has contract code and getOwners()
 */
export const isGnosisSafe = async (address: string): Promise<number> => {
    try {
        const provider = await RpcManager.getProvider();
        const code = await provider.getCode(address);
        // If no code, it's an EOA
        if (code === '0x') {
            return SignatureType.EOA;
        }

        // It's a contract. Test if it's a Gnosis Safe by calling `getOwners()`
        try {
            const contract = new ethers.Contract(address, GNOSIS_SAFE_ABI, provider);
            const owners = await contract.getOwners();
            if (owners && owners.length > 0) {
                return SignatureType.POLY_GNOSIS_SAFE;
            }
        } catch (ignored) {
            // Revert or error means it's likely not a Gnosis Safe
        }

        // Fallback to PolyProxy for all other contracts on Polymarket
        return SignatureType.POLY_PROXY;
    } catch (error) {
        Logger.error(`Error checking wallet type: ${error}`);
        return SignatureType.EOA;
    }
};

/**
 * Executes a transaction via Gnosis Safe
 */
export const executeGnosisTransaction = async (
    safeAddress: string,
    to: string,
    data: string,
    wallet: ethers.Wallet,
    provider: ethers.providers.Provider
) => {
    const safeContract = new ethers.Contract(safeAddress, GNOSIS_SAFE_ABI, wallet);
    
    const value = 0;
    const operation = 0; // Call
    const safeTxGas = 0;
    const baseGas = 0;
    const gasPrice = 0;
    const gasToken = ethers.constants.AddressZero;
    const refundReceiver = ethers.constants.AddressZero;
    const nonce = await safeContract.nonce();

    Logger.info(`   📝 Preparing Gnosis Safe Tx (Nonce: ${nonce})...`);

    // Get Hash
    const txHash = await safeContract.getTransactionHash(
        to,
        value,
        data,
        operation,
        safeTxGas,
        baseGas,
        gasPrice,
        gasToken,
        refundReceiver,
        nonce
    );

    // Sign Hash
    const signingKey = new ethers.utils.SigningKey(wallet.privateKey);
    const sig = signingKey.signDigest(txHash);
    
    // Concatenate signature bytes: r + s + v
    const signatureBytes = ethers.utils.joinSignature(sig);

    Logger.info(`   ✍️  Signed. Executing on-chain...`);

    // Get Fee Data with Aggressive Buffer
    const feeData = await provider.getFeeData();
    // 50 Gwei min for priority to satisfy "minimum needed 25000000000" (25 Gwei)
    const minPriority = ethers.utils.parseUnits('50', 'gwei'); 
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas?.gt(minPriority) 
        ? feeData.maxPriorityFeePerGas.mul(2) 
        : minPriority;
    
    const maxFeePerGas = feeData.maxFeePerGas?.mul(2).add(maxPriorityFeePerGas);

    Logger.info(`   ⛽ Gas Config: MaxPriority=${ethers.utils.formatUnits(maxPriorityFeePerGas, 'gwei')} Gwei, MaxFee=${ethers.utils.formatUnits(maxFeePerGas || 0, 'gwei')} Gwei`);

    // Execute
    const tx = await safeContract.execTransaction(
        to,
        value,
        data,
        operation,
        safeTxGas,
        baseGas,
        gasPrice,
        gasToken,
        refundReceiver,
        signatureBytes,
        {
            gasLimit: 500000, // Safety margin
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas
        }
    );

    Logger.info(`   🚀 Tx Sent! Hash: ${tx.hash}`);
    await tx.wait();
    Logger.success(`   ✅ Transaction Confirmed!`);
    return tx;
};
