require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// In-memory database for users and wallets
const users = {};
const processedPayments = new Set(); // Track already-processed payment references

const API_KEY = process.env.APIKEY?.trim();
const SECRET_KEY = process.env.Secret_Key?.trim();
const CONTRACT_CODE = process.env.Contract_Code?.trim();
const BASE_URL = 'https://sandbox.monnify.com';

// Helper to get Monnify access token
async function getMonnifyToken() {
    const auth = Buffer.from(`${API_KEY}:${SECRET_KEY}`).toString('base64');
    try {
        const response = await axios.post(`${BASE_URL}/api/v1/auth/login`, {}, {
            headers: {
                Authorization: `Basic ${auth}`
            }
        });
        return response.data.responseBody.accessToken;
    } catch (error) {
        console.error('Error getting Monnify token:', error.response?.data || error.message);
        throw error;
    }
}

// 1. Create a wallet (Reserved Virtual Account) for a user
app.post('/api/wallet/create', async (req, res) => {
    try {
        const { userId, name, email } = req.body;

        if (users[userId]) {
            return res.status(400).json({ error: 'User wallet already exists', data: users[userId] });
        }

        const token = await getMonnifyToken();
        const accountReference = `REF-${userId}-${Date.now()}`;

        const response = await axios.post(`${BASE_URL}/api/v2/bank-transfer/reserved-accounts`, {
            accountReference: accountReference,
            accountName: name,
            currencyCode: "NGN",
            contractCode: CONTRACT_CODE,
            customerEmail: email,
            customerName: name,
            getAllAvailableBanks: false,
            preferredBanks: ["035"] // Wema Bank
        }, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        const accountData = response.data.responseBody.accounts[0];

        users[userId] = {
            userId,
            name,
            email,
            balance: 0,
            accountReference,
            accountNumber: accountData.accountNumber,
            bankName: accountData.bankName
        };

        console.log(`[Wallet Created] User: ${userId}, Account: ${accountData.accountNumber}, Ref: ${accountReference}`);
        res.json({ message: 'Wallet created successfully', wallet: users[userId] });
    } catch (error) {
        console.error('Error creating wallet:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to create wallet', details: error.response?.data || error.message });
    }
});

// 2. Monnify Webhook for receiving deposits (kept as backup)
app.post('/api/monnify/webhook', (req, res) => {
    console.log('[Webhook] Received webhook:', JSON.stringify(req.body).substring(0, 200));
    const payload = req.body;

    // Process the transaction regardless of signature (for sandbox testing)
    if (payload.eventType === 'SUCCESSFUL_TRANSACTION') {
        const { amountPaid, paymentReference, accountReference } = payload.eventData;

        if (!processedPayments.has(paymentReference)) {
            const user = Object.values(users).find(u => u.accountReference === accountReference);
            if (user) {
                user.balance += parseFloat(amountPaid);
                processedPayments.add(paymentReference);
                console.log(`[Webhook] Credited ${user.userId} with NGN ${amountPaid}. Balance: ${user.balance}`);
            }
        }
    }
    res.sendStatus(200);
});

// 3. Get wallet balance — POLLS Monnify API for real transactions
app.get('/api/wallet/:userId', async (req, res) => {
    const user = users[req.params.userId];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Poll Monnify for transactions on this reserved account
    try {
        const token = await getMonnifyToken();
        const response = await axios.get(
            `${BASE_URL}/api/v1/bank-transfer/reserved-accounts/transactions`, {
                params: {
                    accountReference: user.accountReference,
                    page: 0,
                    size: 100
                },
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        const transactions = response.data.responseBody?.content || [];
        let totalDeposited = 0;

        for (const txn of transactions) {
            if (txn.paymentStatus === 'PAID' && !processedPayments.has(txn.paymentReference)) {
                totalDeposited += parseFloat(txn.amountPaid || txn.amount || 0);
                processedPayments.add(txn.paymentReference);
                console.log(`[Poll] Found new payment: ${txn.paymentReference} — NGN ${txn.amountPaid || txn.amount}`);
            }
        }

        if (totalDeposited > 0) {
            user.balance += totalDeposited;
            console.log(`[Poll] Credited ${user.userId} with NGN ${totalDeposited}. New balance: ${user.balance}`);
        }
    } catch (error) {
        console.error('[Poll] Error fetching transactions from Monnify:', error.response?.data || error.message);
        // Continue and return the cached balance even if the API call fails
    }

    res.json({ balance: user.balance, accountNumber: user.accountNumber, bankName: user.bankName, accountReference: user.accountReference });
});

// Mock deposit endpoint for local testing
app.post('/api/wallet/mock-deposit', (req, res) => {
    const { userId, amount } = req.body;
    const user = users[userId];
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.balance += parseFloat(amount);
    console.log(`[Mock] Credited ${user.userId} with NGN ${amount}. Balance: ${user.balance}`);

    res.json({ message: `Successfully deposited NGN ${amount}`, balance: user.balance });
});

// 4. Buy a ticket (Deduct from wallet)
app.post('/api/tickets/buy', (req, res) => {
    const { userId, ticketPrice, ticketName } = req.body;
    const user = users[userId];

    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < ticketPrice) {
        return res.status(400).json({ error: 'Insufficient funds in wallet', balance: user.balance });
    }

    // Deduct balance
    user.balance -= ticketPrice;

    res.json({
        message: `Successfully purchased ${ticketName}`,
        remainingBalance: user.balance
    });
});

// 5. Withdraw from wallet to main bank account (Monnify Disbursement)
app.post('/api/wallet/withdraw', async (req, res) => {
    try {
        const { userId, amount, bankCode, accountNumber, narration } = req.body;
        const user = users[userId];

        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.balance < amount) return res.status(400).json({ error: 'Insufficient funds' });

        const token = await getMonnifyToken();
        const reference = `WD-${userId}-${Date.now()}`;

        const response = await axios.post(`${BASE_URL}/api/v2/disbursements/single`, {
            amount: amount,
            reference: reference,
            narration: narration || "Wallet Withdrawal",
            destinationBankCode: bankCode,
            destinationAccountNumber: accountNumber,
            currency: "NGN",
            sourceAccountNumber: process.env.Monnify_Source_Account || user.accountNumber
        }, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        // Deduct from wallet if transfer is successful or pending
        if (response.data.requestSuccessful) {
            user.balance -= amount;
            res.json({ message: 'Withdrawal initiated successfully', remainingBalance: user.balance, details: response.data.responseBody });
        } else {
            res.status(400).json({ error: 'Withdrawal failed', details: response.data.responseMessage });
        }
    } catch (error) {
        console.error('Error processing withdrawal:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to process withdrawal', details: error.response?.data || error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Monnify Wallet API is running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});
