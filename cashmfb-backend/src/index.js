require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const savingsRoutes = require('./routes/savings');
const loansRoutes = require('./routes/loans');
const billsRoutes = require('./routes/bills');
const vtpassRoutes = require('./routes/vtpass');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'CashMFB API is running' }));
app.use('/auth', authRoutes);
app.use('/wallet', walletRoutes);
app.use('/savings', savingsRoutes);
app.use('/loans', loansRoutes);
app.use('/bills', billsRoutes);
app.use('/vtpass', vtpassRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`CashMFB backend running on http://localhost:${PORT}`));