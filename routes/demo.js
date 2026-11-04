const express    = require('express');
const app        = express();
const apiMiddleware   = require('../middlewares/api');
const { authentication } = require('../middlewares/authentication');
const {
    activateDemo,
    getDemoWallet,
    getCoinPackPrice,
    purchaseCoins,
    placeOrder,
    getOrders,
    getPortfolio,
    cancelOrder,
    resetDemo,
    getChallengeInfo,
    getDemoBlockStatus,
    demoQuickUnlock,
} = require('../controllers/DemoController');

app.post('/activate',           apiMiddleware, authentication, activateDemo);
app.get('/wallet',              apiMiddleware, authentication, getDemoWallet);
app.get('/coin-pack-price',     apiMiddleware, authentication, getCoinPackPrice);
app.post('/purchase-coins',     apiMiddleware, authentication, purchaseCoins);
app.post('/order',              apiMiddleware, authentication, placeOrder);
app.get('/orders',              apiMiddleware, authentication, getOrders);
app.get('/portfolio',           apiMiddleware, authentication, getPortfolio);
app.delete('/order/:id',        apiMiddleware, authentication, cancelOrder);
app.post('/reset',              apiMiddleware, authentication, resetDemo);
app.get('/challenge-info',      apiMiddleware, authentication, getChallengeInfo);
app.get('/block-status',        apiMiddleware, authentication, getDemoBlockStatus);
app.post('/quick-unlock',       apiMiddleware, authentication, demoQuickUnlock);

module.exports = app;
