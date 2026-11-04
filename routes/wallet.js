const express        = require('express');
const router         = express.Router();
const wallet         = require('../controllers/WalletController');
const apiMiddleware  = require('../middlewares/api');
const { authentication } = require('../middlewares/authentication');

const auth = [apiMiddleware, authentication];

router.get('/balance',        ...auth, wallet.getBalance);
router.post('/add-coins',     ...auth, wallet.addCoins);          // retired — no payment
router.post('/topup/order',   ...auth, wallet.createTopupOrder);  // Razorpay order for a top-up
router.post('/topup/verify',  ...auth, wallet.verifyTopup);       // credits only after verified payment
router.get('/transactions',   ...auth, wallet.getTransactions);
router.get('/unlock-options', ...auth, wallet.getUnlockOptions);
router.get('/unlocks',        ...auth, wallet.getUnlocks);        // unlock history + trades that followed

module.exports = router;
