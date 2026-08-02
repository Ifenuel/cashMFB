const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function generateReference() {
  return 'SAV-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

router.get('/balance', async (req, res) => {
  const result = await pool.query("SELECT balance FROM wallets WHERE user_id = $1 AND type = 'savings'", [req.userId]);
  res.json({ balanceNaira: Number(result.rows[0].balance) / 100 });
});

router.get('/goals', async (req, res) => {
  const result = await pool.query('SELECT * FROM savings_goals WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
  const goals = result.rows.map(g => ({
    id: g.id,
    name: g.name,
    targetNaira: Number(g.target_kobo) / 100,
    savedNaira: Number(g.saved_kobo) / 100,
    progressPercent: Math.min(100, Math.round((Number(g.saved_kobo) / Number(g.target_kobo)) * 100)),
    status: g.status,
  }));
  res.json({ goals });
});

router.post('/goals', async (req, res) => {
  const { name } = req.body;
  const targetKobo = Math.round(Number(req.body.targetNaira) * 100);
  if (!name || !targetKobo || targetKobo <= 0) return res.status(400).json({ error: 'name and a valid targetNaira are required' });
  const result = await pool.query('INSERT INTO savings_goals (user_id, name, target_kobo) VALUES ($1, $2, $3) RETURNING id', [req.userId, name, targetKobo]);
  res.status(201).json({ message: 'Savings goal created', goalId: result.rows[0].id });
});

router.post('/goals/:goalId/fund', async (req, res) => {
  const { goalId } = req.params;
  const amountKobo = Math.round(Number(req.body.amountNaira) * 100);
  if (!amountKobo || amountKobo <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const goalResult = await client.query('SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2 FOR UPDATE', [goalId, req.userId]);
    const goal = goalResult.rows[0];
    if (!goal) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Goal not found' }); }

    const mainResult = await client.query("SELECT * FROM wallets WHERE user_id = $1 AND type = 'main' FOR UPDATE", [req.userId]);
    const main = mainResult.rows[0];
    if (Number(main.balance) < amountKobo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance in main wallet' }); }

    const savingsResult = await client.query("SELECT * FROM wallets WHERE user_id = $1 AND type = 'savings' FOR UPDATE", [req.userId]);
    const savings = savingsResult.rows[0];

    const mainNewBalance = Number(main.balance) - amountKobo;
    const savingsNewBalance = Number(savings.balance) + amountKobo;
    const goalNewSaved = Number(goal.saved_kobo) + amountKobo;
    const goalNewStatus = goalNewSaved >= Number(goal.target_kobo) ? 'completed' : 'active';

    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [mainNewBalance, main.id]);
    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [savingsNewBalance, savings.id]);
    await client.query('UPDATE savings_goals SET saved_kobo = $1, status = $2 WHERE id = $3', [goalNewSaved, goalNewStatus, goal.id]);

    const txResult = await client.query(`INSERT INTO transactions (reference, type, narration) VALUES ($1, 'savings_fund', $2) RETURNING id`, [generateReference(), `Saved toward "${goal.name}"`]);
    const txId = txResult.rows[0].id;
    await client.query(`INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after) VALUES ($1, $2, 'debit', $3, $4)`, [txId, main.id, amountKobo, mainNewBalance]);
    await client.query(`INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after) VALUES ($1, $2, 'credit', $3, $4)`, [txId, savings.id, amountKobo, savingsNewBalance]);

    await client.query('COMMIT');
    res.json({
      message: goalNewStatus === 'completed' ? `Goal "${goal.name}" completed! 🎉` : 'Funded successfully',
      mainBalanceNaira: mainNewBalance / 100,
      goal: { savedNaira: goalNewSaved / 100, targetNaira: Number(goal.target_kobo) / 100, status: goalNewStatus },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Funding failed' });
  } finally {
    client.release();
  }
});

router.post('/goals/:goalId/withdraw', async (req, res) => {
  const { goalId } = req.params;
  const amountKobo = Math.round(Number(req.body.amountNaira) * 100);
  if (!amountKobo || amountKobo <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const goalResult = await client.query('SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2 FOR UPDATE', [goalId, req.userId]);
    const goal = goalResult.rows[0];
    if (!goal) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Goal not found' }); }
    if (Number(goal.saved_kobo) < amountKobo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient saved amount in this goal' }); }

    const savingsResult = await client.query("SELECT * FROM wallets WHERE user_id = $1 AND type = 'savings' FOR UPDATE", [req.userId]);
    const savings = savingsResult.rows[0];
    const mainResult = await client.query("SELECT * FROM wallets WHERE user_id = $1 AND type = 'main' FOR UPDATE", [req.userId]);
    const main = mainResult.rows[0];

    const savingsNewBalance = Number(savings.balance) - amountKobo;
    const mainNewBalance = Number(main.balance) + amountKobo;
    const goalNewSaved = Number(goal.saved_kobo) - amountKobo;

    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [savingsNewBalance, savings.id]);
    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [mainNewBalance, main.id]);
    await client.query("UPDATE savings_goals SET saved_kobo = $1, status = 'active' WHERE id = $2", [goalNewSaved, goal.id]);

    const txResult = await client.query(`INSERT INTO transactions (reference, type, narration) VALUES ($1, 'savings_withdraw', $2) RETURNING id`, [generateReference(), `Withdrawn from "${goal.name}"`]);
    const txId = txResult.rows[0].id;
    await client.query(`INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after) VALUES ($1, $2, 'debit', $3, $4)`, [txId, savings.id, amountKobo, savingsNewBalance]);
    await client.query(`INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after) VALUES ($1, $2, 'credit', $3, $4)`, [txId, main.id, amountKobo, mainNewBalance]);

    await client.query('COMMIT');
    res.json({ message: 'Withdrawn successfully', mainBalanceNaira: mainNewBalance / 100, goalSavedNaira: goalNewSaved / 100 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Withdrawal failed' });
  } finally {
    client.release();
  }
});

module.exports = router;