import { ethers } from 'ethers';
import { PolymarketClient } from '../adapters/PolymarketClient';
import Logger from '../core/Logger';
import { ENV } from '../config/env';

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // Polygon USDC (Bridged)
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'; // Polymarket CTF Exchange

const ERC20_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
];

const checkAndApprove = async () => {
    try {
        Logger.info('🔄 Checking USDC Allowance...');

        const clobClient = await PolymarketClient.create();
        const signer = clobClient.signer;

        if (!signer) {
            throw new Error('Signer not found in ClobClient');
        }

        const walletAddress = await signer.getAddress();

        // IMPORTANT: In Polymarket, the Proxy Wallet (Gnosis Safe) holds the funds, but the EOA (Signer) signs the transactions.
        // We need to check the balance of the PROXY WALLET, not the EOA.
        // If ENV.PROXY_WALLET is set, use it. Otherwise use EOA.
        const proxyWallet = ENV.PROXY_WALLET;
        const fundsHolder = proxyWallet || walletAddress;

        Logger.info(`Signer Address (EOA): ${walletAddress}`);
        Logger.info(
            `Funds Holder Address: ${fundsHolder} ${proxyWallet ? '(Proxy Wallet)' : '(EOA)'}`
        );
        Logger.info(`Spender (CTF Exchange): ${CTF_EXCHANGE_ADDRESS}`);

        const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);

        // Check Balance of FUNDS HOLDER
        const balance = await usdcContract.balanceOf(fundsHolder);
        Logger.info(`💰 USDC Balance (Funds Holder): ${ethers.utils.formatUnits(balance, 6)} USDC`);

        // Check Native Token (POL/MATIC) Balance for Gas (Gas is always paid by EOA/Signer)
        const provider = signer.provider;
        if (provider) {
            const nativeBalance = await provider.getBalance(walletAddress);
            const nativeBalanceFormatted = ethers.utils.formatEther(nativeBalance);
            Logger.info(`⛽ Native Token (POL) Balance (Signer): ${nativeBalanceFormatted} POL`);

            if (nativeBalance.lt(ethers.utils.parseEther('0.1'))) {
                Logger.warning(
                    `⚠️ Low Gas Balance! You have ${nativeBalanceFormatted} POL. Transactions might fail.`
                );
            }
        }

        // Check Allowance of FUNDS HOLDER
        // Note: For Gnosis Safe, allowance works differently (modules), but if it's a standard ERC20 approve, we check it here.
        // However, Polymarket Gnosis Safes often use Relayers or Modules.
        // Let's check the standard allowance first.
        const allowance = await usdcContract.allowance(fundsHolder, CTF_EXCHANGE_ADDRESS);
        Logger.info(
            `🔓 Current Allowance (Funds Holder): ${ethers.utils.formatUnits(allowance, 6)} USDC`
        );

        const MAX_UINT = ethers.constants.MaxUint256;

        if (allowance.lt(ethers.utils.parseUnits('1000', 6))) {
            // If allowance < 1000 USDC
            Logger.warning('⚠️ Allowance is low. Attempting to approve...');

            if (proxyWallet) {
                Logger.warning('🚨 You are using a Proxy Wallet (Gnosis Safe).');
                Logger.warning(
                    '   Standard EOA approval will NOT work for the Proxy Wallet funds.'
                );
                Logger.warning('   You must approve USDC spending FROM the Proxy Wallet.');
                Logger.warning('   This script currently only supports EOA approval.');
                Logger.warning(
                    '   If your funds are in the Proxy Wallet, you need to use the Polymarket UI to "Enable Trading" or transfer funds to EOA.'
                );
            } else {
                const tx = await usdcContract.approve(CTF_EXCHANGE_ADDRESS, MAX_UINT);
                Logger.info(`⏳ Approval TX sent: ${tx.hash}`);
                await tx.wait();
                Logger.success('✅ USDC Approved for Trading!');
            }
        } else {
            Logger.success('✅ Allowance is sufficient.');
        }
    } catch (error) {
        Logger.error(`❌ Failed to check/approve allowance: ${error}`);
    }
};

checkAndApprove();
