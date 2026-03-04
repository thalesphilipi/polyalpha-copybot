import connectDB, { closeDB } from '../config/db';
import mongoose from 'mongoose';

async function clearDatabase() {
    console.log('🧹 Starting Database Cleanup...');
    try {
        await connectDB();

        const db = mongoose.connection.db;
        if (db) {
            await db.dropDatabase();
            console.log('✅ Database successfully dropped and cleared!');
        } else {
            console.log('❌ Database connection not established properly.');
        }

        await closeDB();
        console.log('✅ Cleanup finished.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Failed to clear database:', error);
        process.exit(1);
    }
}

clearDatabase();
