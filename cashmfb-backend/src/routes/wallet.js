const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const paystack = require('../paystack');

const router = express.Router();
router.use(requireAuth);

function generateReference() {
  return 'CMFB-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

// GET /wallet/balance
router.get('/balance', async (req, res) => {
  const result = await pool.query('SELECT balance, currency FROM wallets WHERE user_id = $1', [req.userId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });
  const { balance, currency } = result.rows[0];
  res.json({ balanceKobo: Number(balance), balanceNaira: Number(balance) / 100, currency });
});

// GET /wallet/banks - list of Nigerian banks from Paystack
router.get('/banks', async (req, res) => {
  try {
    const response = await paystack.get('/bank?country=nigeria');
    res.json({ banks: response.data.data });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch banks' });
  }
});

// POST /wallet/verify-account - confirm a real account number/bank matches a real name
router.post('/verify-account', async (req, res) => {
  const { accountNumber, bankCode } = req.body;
  try {
    const response = await paystack.get(
      `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`
    );
    res.json({
      accountName: response.data.data.account_name,
      accountNumber: response.data.data.account_number,
    });
  } catch (err) {
    res.status(400).json({ error: 'Could not verify account. Check the details and try again.' });
  }
});

// POST /wallet/send-to-bank  { accountNumber, bankCode, amountNaira, reason }
router.post('/send-to-bank', async (req, res) => {
  const { accountNumber, bankCode, amountNaira, reason } = req.body;
  const amountKobo = Math.round(Number(amountNaira) * 100);

  if (!accountNumber || !bankCode || !amountKobo || amountKobo <= 0) {
    return res.status(400).json({ error: 'accountNumber, bankCode, and a valid amountNaira are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletResult = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [req.userId]);
    const wallet = walletResult.rows[0];

    if (Number(wallet.balance) < amountKobo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const resolveResponse = await paystack.get(
      `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`
    );
    const accountName = resolveResponse.data.data.account_name;

    const recipientResponse = await paystack.post('/transferrecipient', {
      type: 'nuban',
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN',
    });
    const recipientCode = recipientResponse.data.data.recipient_code;

    const transferResponse = await paystack.post('/transfer', {
      source: 'balance',
      amount: amountKobo,
      recipient: recipientCode,
      reason: reason || 'CashMFB transfer',
    });

    const newBalance = Number(wallet.balance) - amountKobo;
    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [newBalance, wallet.id]);

    const txResult = await client.query(
      `INSERT INTO transactions (reference, type, narration) VALUES ($1, 'bank_transfer', $2) RETURNING id`,
      [generateReference(), `Sent to ${accountName}`]
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after)
       VALUES ($1, $2, 'debit', $3, $4)`,
      [txResult.rows[0].id, wallet.id, amountKobo, newBalance]
    );

    await client.query('COMMIT');
    res.json({
      message: 'Transfer sent successfully',
      recipientName: accountName,
      newBalanceNaira: newBalance / 100,
      paystackStatus: transferResponse.data.data.status,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Transfer failed. Please check the account details and try again.' });
  } finally {
    client.release();
  }
});

// POST /wallet/deposit/initialize  { amountNaira }
router.post('/deposit/initialize', async (req, res) => {
  const { amountNaira } = req.body;
  const amountKobo = Math.round(Number(amountNaira) * 100);
  if (!amountKobo || amountKobo <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId]);
    const email = userResult.rows[0].email;
    const reference = generateReference();

    const response = await paystack.post('/transaction/initialize', {
      email,
      amount: amountKobo,
      reference,
    });

    res.json({
      accessCode: response.data.data.access_code,
      reference,
      email,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Could not initialize payment' });
  }
});

// GET /wallet/deposit/verify/:reference
router.get('/deposit/verify/:reference', async (req, res) => {
  const { reference } = req.params;
  const client = await pool.connect();
  try {
    const verifyResponse = await paystack.get(`/transaction/verify/${reference}`);
    const data = verifyResponse.data.data;

    if (data.status !== 'success') {
      client.release();
      return res.status(400).json({ error: 'Payment not successful' });
    }

    const existing = await client.query('SELECT id FROM transactions WHERE reference = $1', [reference]);
    if (existing.rows[0]) {
      client.release();
      return res.json({ message: 'Already processed' });
    }

    await client.query('BEGIN');
    const walletResult = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [req.userId]);
    const wallet = walletResult.rows[0];
    const amountKobo = data.amount;
    const newBalance = Number(wallet.balance) + amountKobo;

    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [newBalance, wallet.id]);
    const txResult = await client.query(
      `INSERT INTO transactions (reference, type, narration) VALUES ($1, 'deposit', 'Wallet funding via Paystack') RETURNING id`,
      [reference]
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after) VALUES ($1, $2, 'credit', $3, $4)`,
      [txResult.rows[0].id, wallet.id, amountKobo, newBalance]
    );
    await client.query('COMMIT');
    res.json({ message: 'Deposit successful', newBalanceNaira: newBalance / 100 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Verification failed' });
  } finally {
    client.release();
  }
});

// POST /wallet/deposit  { amountNaira }  -- legacy demo route, kept for backward compatibility
router.post('/deposit', async (req, res) => {
  const { amountNaira } = req.body;
  const amountKobo = Math.round(Number(amountNaira) * 100);
  if (!amountKobo || amountKobo <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const walletResult = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [req.userId]);
    const wallet = walletResult.rows[0];
    const newBalance = Number(wallet.balance) + amountKobo;

    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [newBalance, wallet.id]);
    const txResult = await client.query(
      `INSERT INTO transactions (reference, type, narration) VALUES ($1, 'deposit', 'Wallet funding') RETURNING id`,
      [generateReference()]
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after)
       VALUES ($1, $2, 'credit', $3, $4)`,
      [txResult.rows[0].id, wallet.id, amountKobo, newBalance]
    );
    await client.query('COMMIT');
    res.json({ message: 'Deposit successful', newBalanceNaira: newBalance / 100 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Deposit failed' });
  } finally {
    client.release();
  }
});

// POST /wallet/transfer  { recipientEmail, amountNaira, narration }
router.post('/transfer', async (req, res) => {
  const { recipientEmail, amountNaira, narration } = req.body;
  const amountKobo = Math.round(Number(amountNaira) * 100);
  if (!recipientEmail || !amountKobo || amountKobo <= 0) {
    return res.status(400).json({ error: 'recipientEmail and a valid amountNaira are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const senderResult = await client.query('SELECT w.* FROM wallets w WHERE w.user_id = $1 FOR UPDATE', [req.userId]);
    const sender = senderResult.rows[0];

    const recipientUserResult = await client.query('SELECT id FROM users WHERE email = $1', [recipientEmail]);
    if (!recipientUserResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recipient not found' });
    }
    const recipientUserId = recipientUserResult.rows[0].id;
    if (recipientUserId === req.userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }

    const recipientResult = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [recipientUserId]);
    const recipient = recipientResult.rows[0];

    if (Number(sender.balance) < amountKobo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const senderNewBalance = Number(sender.balance) - amountKobo;
    const recipientNewBalance = Number(recipient.balance) + amountKobo;

    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [senderNewBalance, sender.id]);
    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [recipientNewBalance, recipient.id]);

    const txResult = await client.query(
      `INSERT INTO transactions (reference, type, narration) VALUES ($1, 'transfer', $2) RETURNING id`,
      [generateReference(), narration || 'Wallet transfer']
    );
    const txId = txResult.rows[0].id;

    await client.query(
      `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after) VALUES ($1, $2, 'debit', $3, $4)`,
      [txId, sender.id, amountKobo, senderNewBalance]
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after) VALUES ($1, $2, 'credit', $3, $4)`,
      [txId, recipient.id, amountKobo, recipientNewBalance]
    );

    await client.query('COMMIT');
    res.json({ message: 'Transfer successful', newBalanceNaira: senderNewBalance / 100 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Transfer failed' });
  } finally {
    client.release();
  }
});

// GET /wallet/history
router.get('/history', async (req, res) => {
  const walletResult = await pool.query('SELECT id FROM wallets WHERE user_id = $1', [req.userId]);
  const walletId = walletResult.rows[0].id;
  const result = await pool.query(
    `SELECT le.direction, le.amount, le.balance_after, le.created_at, t.reference, t.type, t.narration
     FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
     WHERE le.wallet_id = $1 ORDER BY le.created_at DESC LIMIT 50`,
    [walletId]
  );
  const history = result.rows.map(r => ({ ...r, amountNaira: Number(r.amount) / 100, balanceAfterNaira: Number(r.balance_after) / 100 }));
  res.json({ history });
});

module.exports = router;