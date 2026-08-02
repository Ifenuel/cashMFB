const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function generateReference() {
  return 'BILL-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

router.post('/pay', async (req, res) => {
  const { billType, provider } = req.body;
  const amountKobo = Math.round(Number(req.body.amountNaira) * 100);
  if (!billType || !provider || !amountKobo || amountKobo <= 0) {
    return res.status(400).json({ error: 'billType, provider, and a valid amountNaira are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const walletResult = await client.query("SELECT * FROM wallets WHERE user_id = $1 AND type = 'main' FOR UPDATE", [req.userId]);
    const wallet = walletResult.rows[0];
    if (Number(wallet.balance) < amountKobo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance' }); }

    const newBalance = Number(wallet.balance) - amountKobo;
    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [newBalance, wallet.id]);

    const txResult = await client.query(
      `INSERT INTO transactions (reference, type, narration, bill_provider) VALUES ($1, 'bill_payment', $2, $3) RETURNING id`,
      [generateReference(), `${billType} - ${provider}`, provider]
    );
    await client.query(`INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after) VALUES ($1, $2, 'debit', $3, $4)`, [txResult.rows[0].id, wallet.id, amountKobo, newBalance]);

    await client.query('COMMIT');
    res.json({ message: `${billType} payment successful`, newBalanceNaira: newBalance / 100 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Bill payment failed' });
  } finally {
    client.release();
  }
});

module.exports = router;