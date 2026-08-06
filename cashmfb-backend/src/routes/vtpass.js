const express = require('express');
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const VTPASS_BASE = process.env.VTPASS_BASE_URL; // https://sandbox.vtpass.com/api

// Map our internal provider names to VTpass serviceIDs
const SERVICE_ID_MAP = {
  data: { MTN: 'mtn-data', Airtel: 'airtel-data', Glo: 'glo-data', '9mobile': 'etisalat-data' },
  tv: { DStv: 'dstv', GOtv: 'gotv', StarTimes: 'startimes' }
};

router.get('/plans', async (req, res) => {
  const { billType, provider } = req.query;
  const serviceID = SERVICE_ID_MAP[billType]?.[provider];
  if (!serviceID) return res.status(400).json({ error: 'No plans available for this provider' });

  try {
    const response = await axios.get(`${VTPASS_BASE}/service-variations`, {
      params: { serviceID },
      headers: { 'api-key': process.env.VTPASS_API_KEY, 'public-key': process.env.VTPASS_PUBLIC_KEY }
    });
    const variations = response.data.content.variations || response.data.content.varations || [];
    res.json({ plans: variations });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

module.exports = router;