const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function generateReference() {
  return 'LN-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

const INTEREST_RATE = 10;
const BASE_KOBO = 500000;
const DEPOSIT_FACTOR = 0.2;
const SAVINGS_FACTOR = 0.3;
const REPAID_BONUS_KOBO = 200000;
const CAP_KOBO = 50000000;

async function computeEligibility(userId) {
  const activeLoan = await pool.query("SELECT id FROM loans WHERE user_id = $1 AND status = 'active'", [userId]);
  if (activeLoan.rows[0]) return { eligibleKobo: 0, reason: 'You have an active loan — repay it before applying again.' };

  const mainWallet = await pool.query("SELECT id FROM wallets WHERE user_id = $1 AND type = 'main'", [userId]);
  const mainWalletId = mainWallet.rows[0].id;

  const depositsResult = await pool.query(
    `SELECT COALESCE(SUM(le.amount), 0) AS total FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
     WHERE le.wallet_id = $1 AND t.type = 'deposit' AND le.direction = 'credit'`,
    [mainWalletId]
  );
  const totalDepositsKobo = Number(depositsResult.rows[0].total);

  const savingsResult = await pool.query("SELECT balance FROM wallets WHERE user_id = $1 AND type = 'savings'", [userId]);
  const savingsBalanceKobo = Number(savingsResult.rows[0].balance);

  const repaidResult = await pool.query("SELECT COUNT(*)::int AS count FROM loans WHERE user_id = $1 AND status = 'repaid'", [userId]);
  const repaidLoansCount = repaidResult.rows[0].count;

  const fromDeposits = Math.round(totalDepositsKobo * DEPOSIT_FACTOR);
  const fromSavings = Math.round(savingsBalanceKobo * SAVINGS_FACTOR);
  const fromRepaidBonus = repaidLoansCount * REPAID_BONUS_KOBO;
  const eligibleKobo = Math.min(BASE_KOBO + fromDeposits + fromSavings + fromRepaidBonus, CAP_KOBO);

  return { eligibleKobo, breakdown: { BASE_KOBO, fromDeposits, fromSavings, fromRepaidBonus, repaidLoansCount } };
}

router.get('/eligibility', async (req, res) => {
  const result = await computeEligibility(req.userId);
  res.json({
    eligibleAmountNaira: result.eligibleKobo / 100,
    reason: result.reason || null,
    breakdown: result.breakdown ? {
      baseNaira: result.breakdown.BASE_KOBO / 100,
      fromDepositsNaira: result.breakdown.fromDeposits / 100,
      fromSavingsNaira: result.breakdown.fromSavings / 100,
      repaidLoansBonusNaira: result.breakdown.fromRepaidBonus / 100,
      repaidLoansCount: result.breakdown.repaidLoansCount,
    } : null,
  });
});

router.post('/apply', async (req, res) => {
  const principalKobo = Math.round(Number(req.body.amountNaira) * 100);
  if (!principalKobo || principalKobo <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const eligibility = await computeEligibility(req.userId);
  if (principalKobo > eligibility.eligibleKobo) {
    return res.status(400).json({ error: `You're only eligible for up to ₦${(eligibility.eligibleKobo / 100).toLocaleString()}`, eligibleAmountNaira: eligibility.eligibleKobo / 100 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query("SELECT id FROM loans WHERE user_id = $1 AND status = 'active'", [req.userId]);
    if (existing.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'You already have an active loan' }); }

    const totalRepayableKobo = Math.round(principalKobo * (1 + INTEREST_RATE / 100));
    const loanResult = await client.query(
      `INSERT INTO loans (user_id, principal_kobo, interest_rate, total_repayable_kobo) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.userId, principalKobo, INTEREST_RATE, totalRepayableKobo]
    );

    const walletResult = await client.query("SELECT * FROM wallets WHERE user_id = $1 AND type = 'main' FOR UPDATE", [req.userId]);
    const wallet = walletResult.rows[0];
    const newBalance = Number(wallet.balance) + principalKobo;
    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [newBalance, wallet.id]);

    const txResult = await client.query(`INSERT INTO transactions (reference, type, narration) VALUES ($1, 'loan_disbursement', 'Loan disbursed') RETURNING id`, [generateReference()]);
    await client.query(`INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after) VALUES ($1, $2, 'credit', $3, $4)`, [txResult.rows[0].id, wallet.id, principalKobo, newBalance]);

    await client.query('COMMIT');
    res.status(201).json({ message: 'Loan approved and disbursed', loanId: loanResult.rows[0].id, principalNaira: principalKobo / 100, totalRepayableNaira: totalRepayableKobo / 100, newWalletBalanceNaira: newBalance / 100 });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Loan application failed' });
  } finally {
    client.release();
  }
});

router.get('/status', async (req, res) => {
  const result = await pool.query("SELECT * FROM loans WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1", [req.userId]);
  const loan = result.rows[0];
  if (!loan) return res.json({ hasActiveLoan: false });
  res.json({
    hasActiveLoan: true, loanId: loan.id,
    principalNaira: Number(loan.principal_kobo) / 100,
    totalRepayableNaira: Number(loan.total_repayable_kobo) / 100,
    amountRepaidNaira: Number(loan.amount_repaid_kobo) / 100,
    remainingNaira: (Number(loan.total_repayable_kobo) - Number(loan.amount_repaid_kobo)) / 100,
  });
});

router.post('/repay', async (req, res) => {
  const repayKobo = Math.round(Number(req.body.amountNaira) * 100);
  if (!repayKobo || repayKobo <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loanResult = await client.query("SELECT * FROM loans WHERE user_id = $1 AND status = 'active' FOR UPDATE", [req.userId]);
    const loan = loanResult.rows[0];
    if (!loan) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No active loan found' }); }

    const walletResult = await client.query("SELECT * FROM wallets WHERE user_id = $1 AND type = 'main' FOR UPDATE", [req.userId]);
    const wallet = walletResult.rows[0];
    if (Number(wallet.balance) < repayKobo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient wallet balance' }); }

    const remaining = Number(loan.total_repayable_kobo) - Number(loan.amount_repaid_kobo);
    const actualRepayKobo = Math.min(repayKobo, remaining);
    const newWalletBalance = Number(wallet.balance) - actualRepayKobo;
    const newAmountRepaid = Number(loan.amount_repaid_kobo) + actualRepayKobo;
    const newStatus = newAmountRepaid >= Number(loan.total_repayable_kobo) ? 'repaid' : 'active';

    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [newWalletBalance, wallet.id]);
    await client.query('UPDATE loans SET amount_repaid_kobo = $1, status = $2 WHERE id = $3', [newAmountRepaid, newStatus, loan.id]);

    const txResult = await client.query(`INSERT INTO transactions (reference, type, narration) VALUES ($1, 'loan_repayment', 'Loan repayment') RETURNING id`, [generateReference()]);
    await client.query(`INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after) VALUES ($1, $2, 'debit', $3, $4)`, [txResult.rows[0].id, wallet.id, actualRepayKobo, newWalletBalance]);

    await client.query('COMMIT');
    res.json({ message: newStatus === 'repaid' ? 'Loan fully repaid!' : 'Repayment successful', amountRepaidNaira: actualRepayKobo / 100, remainingNaira: (Number(loan.total_repayable_kobo) - newAmountRepaid) / 100, status: newStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Repayment failed' });
  } finally {
    client.release();
  }
});

module.exports = router;