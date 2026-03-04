import mongoose, { Schema } from 'mongoose';

const botHistorySchema = new Schema({
    timestamp: { type: Number, required: true },
    transactionHash: { type: String, required: false },
    type: { type: String, enum: ['BUY', 'SELL', 'REDEEM'], required: true },
    asset: { type: String, required: true },
    title: { type: String, required: false }, // Market Title
    outcome: { type: String, required: false }, // Yes/No
    price: { type: Number, required: true },
    amountSize: { type: Number, required: true }, // Shares
    amountValue: { type: Number, required: true }, // USDC
    sourceTrader: { type: String, required: false }, // Address of the trader copied (if any)
    reason: { type: String, required: false }, // 'COPY', 'PANIC_SELL', 'TAKE_PROFIT', 'STOP_LOSS', 'MANUAL', 'REDEMPTION'
    pnl: { type: Number, required: false }, // Only for SELL/REDEEM
    roi: { type: Number, required: false }, // Only for SELL/REDEEM
    fee: { type: Number, required: false },
    status: { type: String, enum: ['SUCCESS', 'FAILED'], default: 'SUCCESS', required: false },
    error: { type: String, required: false }, // Error message if failed
});

// Create index for fast querying by sourceTrader and timestamp
botHistorySchema.index({ sourceTrader: 1 });
botHistorySchema.index({ timestamp: -1 });

const BotHistory = mongoose.model('BotHistory', botHistorySchema);

export default BotHistory;
