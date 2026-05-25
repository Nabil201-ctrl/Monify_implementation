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

const fs = require('fs');
const path = require('path');
const USERS_FILE = path.join(__dirname, 'users.json');

// In-memory database for users and wallets loaded from file
let users = {};
try {
    if (fs.existsSync(USERS_FILE)) {
        users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        console.log(`[Database Loaded] ${Object.keys(users).length} wallets restored from users.json.`);
    }
} catch (e) {
    console.error('Failed to load users.json database:', e.message);
}

// Helper to save users
function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save users.json:', e.message);
    }
}

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

        try {
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
                balance: 10000, // Preload with 10k test funds
                accountReference,
                accountNumber: accountData.accountNumber,
                bankName: accountData.bankName
            };

            saveUsers();
            console.log(`[Wallet Created] User: ${userId}, Account: ${accountData.accountNumber}, Ref: ${accountReference}`);
            return res.json({ message: 'Wallet created successfully', wallet: users[userId] });
        } catch (monnifyError) {
            console.warn('[Monnify API Fallback] Failed to reserve virtual account on Wema. Creating simulated account instead:', monnifyError.message);
            
            const simulatedAccNum = Math.floor(1000000000 + Math.random() * 9000000000).toString();
            users[userId] = {
                userId,
                name,
                email,
                balance: 15000, // Gift ₦15,000 free simulated Naira so they can test immediately!
                accountReference: `REF-SIM-${userId}-${Date.now()}`,
                accountNumber: simulatedAccNum,
                bankName: "Wema Bank (Simulated Sandbox)"
            };

            saveUsers();
            console.log(`[Simulated Wallet Created] User: ${userId}, Account: ${simulatedAccNum}`);
            return res.json({ message: 'Wallet created successfully (Simulated Fallback Mode)', wallet: users[userId] });
        }
    } catch (error) {
        console.error('Critical Error creating wallet:', error.message);
        res.status(500).json({ error: 'Failed to create wallet', details: error.message });
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
                saveUsers();
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
            saveUsers();
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
    saveUsers();
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
    saveUsers();

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

        try {
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
                saveUsers();
                return res.json({ message: 'Withdrawal initiated successfully', remainingBalance: user.balance, details: response.data.responseBody });
            } else {
                return res.status(400).json({ error: 'Withdrawal failed', details: response.data.responseMessage });
            }
        } catch (monnifyError) {
            console.warn('[Withdrawal Fallback] Monnify API failed. Processing simulated sandbox withdrawal instead:', monnifyError.message);
            
            // Debit local balance
            user.balance -= amount;
            saveUsers();
            return res.json({ 
                message: 'Withdrawal simulated successfully (Local Sandbox Mode)', 
                remainingBalance: user.balance, 
                details: { status: "SUCCESSFUL", reference: `MOCK-WD-${Date.now()}` } 
            });
        }
    } catch (error) {
        console.error('Critical error processing withdrawal:', error.message);
        res.status(500).json({ error: 'Failed to process withdrawal', details: error.message });
    }
});

// Get full wallet info for auto-login verification
app.get('/api/wallet/info/:userId', (req, res) => {
    const { userId } = req.params;
    const user = users[userId];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ wallet: user });
});

// --- CAMPUS TRANSIT & UNIFIED SEARCH STATE (SIMULATING SUPABASE) ---
const vehicles = {
    "1001": {
        code: "1001",
        type: "Shuttle",
        driverName: "Mustapha Yusuf",
        phone: "+234 803 111 2222",
        proxyPhone: "+234 700 748 8853", // Secure Proxy Masked Call
        vehicleDetails: "Toyota HiAce - White (ABJ-123-XY)",
        virtualAccount: "8823490123",
        bankName: "Wema Bank",
        price: 500,
        route: "Main Campus ⇄ Annex Campus",
        seats: [
            { id: 1, booked: true },
            { id: 2, booked: false },
            { id: 3, booked: true },
            { id: 4, booked: false },
            { id: 5, booked: false },
            { id: 6, booked: true },
            { id: 7, booked: false },
            { id: 8, booked: false },
            { id: 9, booked: true },
            { id: 10, booked: false },
            { id: 11, booked: false },
            { id: 12, booked: false },
            { id: 13, booked: false },
            { id: 14, booked: true } // 11 available, 3 booked initially
        ]
    },
    "2002": {
        code: "2002",
        type: "Keke",
        driverName: "Ibrahim Bello",
        phone: "+234 809 333 4444",
        proxyPhone: "+234 700 748 8854", // Secure Proxy Masked Call
        vehicleDetails: "TVS King Keke - Yellow (KDS-789-QA)",
        virtualAccount: "8823490124",
        bankName: "Wema Bank",
        priceOptions: [200, 300, 500],
        price: 300,
        route: "Gate 1 ⇄ Faculty of Engineering"
    }
};

const reverseTrips = [];
const lastRides = {}; // userId -> array of ride logs

// Get vehicle details by code (Simulates database check)
app.get('/api/transit/vehicle/:code', (req, res) => {
    const code = req.params.code.trim();
    const vehicle = vehicles[code];
    if (!vehicle) {
        return res.status(404).json({ error: 'Vehicle code not found. Try searching 1001 (Shuttle) or 2002 (Keke).' });
    }
    res.json(vehicle);
});

// Book a Shuttle Seat
app.post('/api/transit/book-seat', (req, res) => {
    const { userId, code, seatId } = req.body;
    const user = users[userId];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const vehicle = vehicles[code];
    if (!vehicle || vehicle.type !== 'Shuttle') {
        return res.status(400).json({ error: 'Invalid shuttle vehicle' });
    }

    const seat = vehicle.seats.find(s => s.id === seatId);
    if (!seat) return res.status(400).json({ error: 'Seat not found' });
    if (seat.booked) return res.status(400).json({ error: 'Seat already booked' });

    if (user.balance < vehicle.price) {
        return res.status(400).json({ error: 'Insufficient wallet balance', balance: user.balance });
    }

    // Process wallet deduction
    user.balance -= vehicle.price;
    saveUsers();
    seat.booked = true;

    // Log ride to history stack
    if (!lastRides[userId]) lastRides[userId] = [];
    lastRides[userId].unshift({
        id: `RIDE-${Date.now()}`,
        code: vehicle.code,
        type: vehicle.type,
        driverName: vehicle.driverName,
        vehicleDetails: vehicle.vehicleDetails,
        price: vehicle.price,
        route: vehicle.route,
        date: new Date(),
        phone: vehicle.phone,
        proxyPhone: vehicle.proxyPhone
    });

    // Check if all seats are now booked
    const remainingSeats = vehicle.seats.filter(s => !s.booked).length;
    let reverseTripGenerated = false;
    
    if (remainingSeats === 0) {
        const oppositeRoute = vehicle.route.includes("⇄") 
            ? vehicle.route.split("⇄").reverse().join("⇄").trim() 
            : "Main Campus ⇄ Annex Campus";
            
        const reverseTrip = {
            id: `RT-${Date.now()}`,
            vehicleCode: vehicle.code,
            driverName: vehicle.driverName,
            vehicleDetails: vehicle.vehicleDetails,
            route: oppositeRoute,
            status: 'INBOUND',
            message: `Shuttle ${vehicle.code} is fully booked and is now INBOUND. ETA: 8 mins.`,
            createdAt: new Date()
        };
        reverseTrips.unshift(reverseTrip);
        reverseTripGenerated = true;
        console.log(`[Reverse Trip] Generated inbound shuttle: ${vehicle.code}`);

        // Simulated auto-reset of seats after 45 seconds for endless demo capability
        setTimeout(() => {
            vehicle.seats.forEach(s => s.booked = Math.random() > 0.6);
            console.log(`[Shuttle Reset] Seat vacancies re-populated for ${vehicle.code}`);
        }, 45000);
    }

    res.json({
        message: 'Seat booked successfully!',
        remainingBalance: user.balance,
        reverseTripGenerated,
        vehicle
    });
});

// Direct Keke Payment
app.post('/api/transit/keke-pay', (req, res) => {
    const { userId, code, price } = req.body;
    const user = users[userId];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const vehicle = vehicles[code];
    if (!vehicle || vehicle.type !== 'Keke') {
        return res.status(400).json({ error: 'Invalid Keke vehicle' });
    }

    if (user.balance < price) {
        return res.status(400).json({ error: 'Insufficient wallet balance', balance: user.balance });
    }

    user.balance -= price;
    saveUsers();

    // Log ride to history stack
    if (!lastRides[userId]) lastRides[userId] = [];
    lastRides[userId].unshift({
        id: `RIDE-${Date.now()}`,
        code: vehicle.code,
        type: vehicle.type,
        driverName: vehicle.driverName,
        vehicleDetails: vehicle.vehicleDetails,
        price: price,
        route: vehicle.route,
        date: new Date(),
        phone: vehicle.phone,
        proxyPhone: vehicle.proxyPhone
    });

    res.json({
        message: 'Keke payment completed successfully!',
        remainingBalance: user.balance,
        vehicle
    });
});

// Fetch Ride History for User
app.get('/api/transit/last-rides/:userId', (req, res) => {
    res.json(lastRides[req.params.userId] || []);
});

// Fetch active Inbound Reverse Trips
app.get('/api/transit/reverse-trips', (req, res) => {
    res.json(reverseTrips.slice(0, 5)); // show latest 5
});

// Reset seats to test reverse trip trigger easily
app.post('/api/transit/reset-seats', (req, res) => {
    const { code } = req.body;
    const vehicle = vehicles[code];
    if (vehicle && vehicle.seats) {
        // Book 13 out of 14 seats so the next single booking triggers the reverse trip
        vehicle.seats.forEach((s, idx) => s.booked = idx !== 4); // index 4 is free
        return res.json({ message: 'Shuttle seats preset with exactly 1 vacant seat to trigger reverse trip easily.', vehicle });
    }
    res.status(400).json({ error: 'Vehicle not found or not a shuttle' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Monnify Wallet API is running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});

