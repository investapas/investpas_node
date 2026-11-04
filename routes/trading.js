/**
 * UNIFIED TRADING ROUTES
 * 
 * Routes all trading operations (buy, sell, modify, cancel, portfolio, orders) 
 * to either Dhan API endpoints or Demo API endpoints based on the 'mode' parameter.
 * 
 * This file consolidates the trading flow - no UI duplication, same code path.
 * 
 * If mode === 'DEMO' → calls DemoController methods
 * If mode === 'REAL' → calls DhanController methods
 */

const express = require('express');
const router = express.Router();
const apiMiddleware = require('../middlewares/api');
const { authentication } = require('../middlewares/authentication');

const DhanController = require('../controllers/DhanController');
const DemoController = require('../controllers/DemoController');

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED BUY/SELL ORDER ENDPOINT
// POST /api/trading/order
// ═══════════════════════════════════════════════════════════════════════════
router.post('/order', apiMiddleware, authentication, async (req, res) => {
  try {
    const { mode, transactionType } = req.body;

    console.log(`[UNIFIED ORDER] mode=${mode}, type=${transactionType}`);

    // Route based on mode
    if (mode === 'DEMO') {
      // Call Demo Controller
      return DemoController.placeOrder(req, res);
    } else if (mode === 'REAL') {
      // Route real super orders separately
      if (req.body.orderType == 'SUPER') {
        return DhanController.buySuperOrder(req, res);
      }
      return DhanController.buyOrder(req, res);
    } else {
      return res.json({
        status: false,
        message: 'Invalid mode. Use DEMO or REAL',
      });
    }
  } catch (error) {
    console.error('[UNIFIED ORDER ERROR]', error);
    return res.json({
      status: false,
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED MODIFY ORDER ENDPOINT
// POST /api/trading/modify-order
// ═══════════════════════════════════════════════════════════════════════════
router.post('/modify-order', apiMiddleware, authentication, async (req, res) => {
  try {
    const { mode } = req.body;

    console.log(`[UNIFIED MODIFY] mode=${mode}`);

    if (mode === 'DEMO') {
      return DemoController.modifyOrder(req, res);
    } else if (mode === 'REAL') {
      return DhanController.modifyOrder(req, res);
    } else {
      return res.json({
        status: false,
        message: 'Invalid mode. Use DEMO or REAL',
      });
    }
  } catch (error) {
    console.error('[UNIFIED MODIFY ERROR]', error);
    return res.json({
      status: false,
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED CANCEL ORDER ENDPOINT
// POST /api/trading/cancel-order
// ═══════════════════════════════════════════════════════════════════════════
router.post('/cancel-order', apiMiddleware, authentication, async (req, res) => {
  try {
    const { mode } = req.body;

    console.log(`[UNIFIED CANCEL] mode=${mode}`);

    if (mode === 'DEMO') {
      return DemoController.cancelOrder(req, res);
    } else if (mode === 'REAL') {
      return DhanController.cancelOrder(req, res);
    } else {
      return res.json({
        status: false,
        message: 'Invalid mode. Use DEMO or REAL',
      });
    }
  } catch (error) {
    console.error('[UNIFIED CANCEL ERROR]', error);
    return res.json({
      status: false,
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED GET PORTFOLIO ENDPOINT
// GET /api/trading/portfolio
// ═══════════════════════════════════════════════════════════════════════════
router.get('/portfolio', apiMiddleware, authentication, async (req, res) => {
  try {
    const mode = req.query.mode || req.body.mode;

    console.log(`[UNIFIED PORTFOLIO] mode=${mode}`);

    if (mode === 'DEMO') {
      return DemoController.getPortfolio(req, res);
    } else if (mode === 'REAL') {
      return DhanController.getPortfolio(req, res);
    } else {
      return res.json({
        status: false,
        message: 'Invalid mode. Use DEMO or REAL',
      });
    }
  } catch (error) {
    console.error('[UNIFIED PORTFOLIO ERROR]', error);
    return res.json({
      status: false,
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED GET ORDERS ENDPOINT
// GET /api/trading/orders
// ═══════════════════════════════════════════════════════════════════════════
router.get('/orders', apiMiddleware, authentication, async (req, res) => {
  try {
    const mode = req.query.mode || req.body.mode;
    const status = req.query.status || req.body.status;

    console.log(`[UNIFIED ORDERS] mode=${mode}, status=${status}`);

    if (mode === 'DEMO') {
      return DemoController.getOrders(req, res);
    } else if (mode === 'REAL') {
      return DhanController.getOrderList(req, res);
    } else {
      return res.json({
        status: false,
        message: 'Invalid mode. Use DEMO or REAL',
      });
    }
  } catch (error) {
    console.error('[UNIFIED ORDERS ERROR]', error);
    return res.json({
      status: false,
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED GET ORDER DETAILS ENDPOINT
// GET /api/trading/order/:orderId
// ═══════════════════════════════════════════════════════════════════════════
router.get('/order/:orderId', apiMiddleware, authentication, async (req, res) => {
  try {
    const mode = req.query.mode || req.body.mode;
    const { orderId } = req.params;

    console.log(`[UNIFIED ORDER DETAILS] mode=${mode}, orderId=${orderId}`);

    // Inject orderId into body for consistency with controller expectations
    req.body = req.body || {};
    req.body.orderId = orderId;

    if (mode === 'DEMO') {
      return DemoController.getOrderDetails(req, res);
    } else if (mode === 'REAL') {
      return DhanController.getOrderById(req, res);
    } else {
      return res.json({
        status: false,
        message: 'Invalid mode. Use DEMO or REAL',
      });
    }
  } catch (error) {
    console.error('[UNIFIED ORDER DETAILS ERROR]', error);
    return res.json({
      status: false,
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED MODIFY ORDER BY ID
// PUT /api/trading/order/:orderId
// ═══════════════════════════════════════════════════════════════════════════
router.put('/order/:orderId', apiMiddleware, authentication, async (req, res) => {
  try {
    const { mode } = req.body;
    const { orderId } = req.params;

    console.log(`[UNIFIED MODIFY BY ID] mode=${mode}, orderId=${orderId}`);

    req.body = req.body || {};
    req.body.orderId = orderId;

    if (mode === 'DEMO') {
      return DemoController.modifyOrder(req, res);
    } else if (mode === 'REAL') {
      return DhanController.modifyOrder(req, res);
    } else {
      return res.json({
        status: false,
        message: 'Invalid mode. Use DEMO or REAL',
      });
    }
  } catch (error) {
    console.error('[UNIFIED MODIFY BY ID ERROR]', error);
    return res.json({
      status: false,
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED CANCEL ORDER BY ID
// DELETE /api/trading/order/:orderId
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/order/:orderId', apiMiddleware, authentication, async (req, res) => {
  try {
    const { mode } = req.body;
    const { orderId } = req.params;

    console.log(`[UNIFIED CANCEL BY ID] mode=${mode}, orderId=${orderId}`);

    req.body = req.body || {};
    req.body.orderId = orderId;

    if (mode === 'DEMO') {
      return DemoController.cancelOrder(req, res);
    } else if (mode === 'REAL') {
      return DhanController.cancelOrder(req, res);
    } else {
      return res.json({
        status: false,
        message: 'Invalid mode. Use DEMO or REAL',
      });
    }
  } catch (error) {
    console.error('[UNIFIED CANCEL BY ID ERROR]', error);
    return res.json({
      status: false,
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED TRADE HISTORY ENDPOINT
// POST /api/trading/trade-history
// ═══════════════════════════════════════════════════════════════════════════
router.post('/trade-history', apiMiddleware, authentication, async (req, res) => {
  try {
    const mode = req.body.mode || req.query.mode;

    console.log(`[UNIFIED TRADE HISTORY] mode=${mode}`);

    if (mode === 'DEMO') {
      return DemoController.getTradeHistory(req, res);
    } else if (mode === 'REAL') {
      return DhanController.getTradeHistory(req, res);
    } else {
      return res.json({
        status: false,
        message: 'Invalid mode. Use DEMO or REAL',
      });
    }
  } catch (error) {
    console.error('[UNIFIED TRADE HISTORY ERROR]', error);
    return res.json({
      status: false,
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BACKWARD COMPATIBILITY ROUTES
// These redirect to the unified endpoints for backward compatibility
// ═══════════════════════════════════════════════════════════════════════════

// /demo/order → /api/trading/order with mode=DEMO
router.post('/demo/order', apiMiddleware, authentication, async (req, res) => {
  req.body.mode = 'DEMO';
  return DemoController.placeOrder(req, res);
});

router.get('/demo/portfolio', apiMiddleware, authentication, async (req, res) => {
  return DemoController.getPortfolio(req, res);
});

router.get('/demo/orders', apiMiddleware, authentication, async (req, res) => {
  return DemoController.getOrders(req, res);
});

router.post('/demo/modify-order', apiMiddleware, authentication, async (req, res) => {
  return DemoController.modifyOrder(req, res);
});

router.post('/demo/cancel-order', apiMiddleware, authentication, async (req, res) => {
  return DemoController.cancelOrder(req, res);
});

router.get('/demo/order/:orderId', apiMiddleware, authentication, async (req, res) => {
  req.body = req.body || {};
  req.body.orderId = req.params.orderId;
  return DemoController.getOrderDetails(req, res);
});

module.exports = router;
