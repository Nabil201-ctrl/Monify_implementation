require('dotenv').config();
const express = require('express');
const axios = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// In-memory database for users and wallets
const users = {};
// Example user: { userId: '1', balance: 0, accountReference: 'ref-123', accountNumber: '1234567890', bankName: 'Wema' }

const API_KEY = process.env.APIKEY?.trim();
const SECRET_KEY = process.env.Secret_Key?.trim();
const CONTRACT_CODE = process.env.Contract_Code?.trim();
const BASE_URL = 'https://sandbox.monnify.com';

// Helper to get Monnify access token
async function getMonnifyToken() {
    const auth = Buffer.from(`${API_KEY}:${SECRET_KEY}`).toString('base64');
    try {
        const _axios = require('axios'); // use axios instead of express
        const response = await _axios.post(`${BASE_URL}/api/v1/auth/login`, {}, {
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
        
        const _axios = require('axios');
        const response = await _axios.post(`${BASE_URL}/api/v2/bank-transfer/reserved-accounts`, {
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

        res.json({ message: 'Wallet created successfully', wallet: users[userId] });
    } catch (error) {
        console.error('Error creating wallet:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to create wallet' });
    }
});

// 2. Monnify Webhook for receiving deposits
app.post('/api/monnify/webhook', (req, res) => {
    const payload = req.body;
    const signature = req.headers['monnify-signature'];
    
    // Compute signature to verify it's from Monnify
    const computedHash = crypto
        .createHmac('sha512', SECRET_KEY)
        .update(JSON.stringify(payload))
        .digest('hex');

    if (signature !== computedHash) {
        return res.status(401).json({ error: 'Invalid signature' });
    }

    if (payload.eventType === 'SUCCESSFUL_TRANSACTION') {
        const { amountPaid, paymentReference, accountReference } = payload.eventData;
        
        // Find user by accountReference
        const user = Object.values(users).find(u => u.accountReference === accountReference);
        if (user) {
            user.balance += parseFloat(amountPaid);
            console.log(`Credited wallet for user ${user.userId} with NGN ${amountPaid}. New balance: ${user.balance}`);
        }
    }

    res.sendStatus(200);
});

// 3. Get wallet balance
app.get('/api/wallet/:userId', (req, res) => {
    const user = users[req.params.userId];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ balance: user.balance, accountNumber: user.accountNumber, bankName: user.bankName });
});

// 4. Buy a ticket (Deduct from wallet)
app.post('/api/tickets/buy', (req, res) => {
    const { userId, ticketPrice, ticketName } = req.body;
    const user = users[userId];
    
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (user.balance < ticketPrice) {
        return res.status(400).json({ error: 'Insufficient funds in wallet' });
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
        
        const _axios = require('axios');
        const response = await _axios.post(`${BASE_URL}/api/v2/disbursements/single`, {
            amount: amount,
            reference: reference,
            narration: narration || "Wallet Withdrawal",
            destinationBankCode: bankCode,
            destinationAccountNumber: accountNumber,
            currency: "NGN",
            sourceAccountNumber: process.env.Monnify_Source_Account || user.accountNumber // You typically need your main settlement account here or a dedicated wallet
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
        res.status(500).json({ error: 'Failed to process withdrawal' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Monnify Wallet API is running on port ${PORT}`);
});
