# Investpas - Quick Reference Guide

## Current State Summary

### ✅ FULLY IMPLEMENTED

#### Real Trading (Dhan Broker)
- [x] User authentication via Dhan OAuth
- [x] Market/Limit buy orders
- [x] Market/Limit sell orders
- [x] Super orders with target & stop loss
- [x] Order modification (change price/quantity)
- [x] Order cancellation
- [x] Portfolio viewing (real positions)
- [x] Trade history
- [x] Margin calculator
- [x] Fund limit checks
- [x] Real-time pricing via WebSocket
- [x] Market data token generation

#### Demo Trading
- [x] Coin-based simulated trading
- [x] Free coin grant on first activation (100k coins)
- [x] Coin purchase via in-app transaction
- [x] Demo buy orders (BUY)
- [x] Demo sell orders (SELL)
- [x] Demo market orders
- [x] Demo limit orders
- [x] Demo super orders (with target/SL)
- [x] Demo portfolio calculation
- [x] Demo order history
- [x] Demo account reset
- [x] Admin-configurable coin pack pricing
- [x] Demo/Real mode toggle with UI adaptation

#### Challenge/Contest System
- [x] Create challenge with capital & rules
- [x] Daily P&L limits (min/max profit/loss)
- [x] Max trades per day limit
- [x] Quantity limits per index (NIFTY, BANKNIFTY, etc.)
- [x] Challenge enforcement before order placement
- [x] Trade logging for P&L tracking
- [x] Quick unlock mechanism
- [x] Cooldown periods after limit hits

#### Backend Infrastructure
- [x] JWT authentication middleware
- [x] Error handling & validation
- [x] Database schema for users, orders, challenges, demo data
- [x] Firebase push notifications
- [x] Dhan API integration layer
- [x] Query helpers for MySQL
- [x] Challenge engine helpers

#### Frontend (Flutter)
- [x] Buy order entry screen
- [x] Sell order entry screen
- [x] Orders listing (open/executed tabs)
- [x] Portfolio/Position view
- [x] Demo trading dashboard
- [x] Demo wallet display
- [x] Challenge overlay when blocked
- [x] Quick unlock UI
- [x] Real-time price updates
- [x] Order status tracking
- [x] Demo/Real mode toggle

---

## Architecture Quick Map

### Three Modes of Operation

```
┌──────────────────┐
│ REAL TRADING     │ ← Dhan broker API
│ (BUY/SELL/SUPER)│   Direct execution
│ Orders go live  │
└──────────────────┘

┌──────────────────┐
│ DEMO TRADING     │ ← Virtual coins
│ (BUY/SELL/SUPER)│   Simulated trades
│ Orders in DB     │
└──────────────────┘

┌──────────────────┐
│ CHALLENGE MODE   │ ← Overlay on real
│ (Rules engine)   │   Capital limits
│ Contest rules    │
└──────────────────┘
```

### API Layer Organization

**Real Trading Routes** (`/dhan/...`)
- Authentication: `/generate-consent`, `/consume-consent`
- Trading: `/buy-order`, `/buy-super-order`, `/orders`, `/order/:id`
- Data: `/portfolio`, `/search-stocks`, `/instruments`, `/trades`

**Demo Trading Routes** (`/demo/...`)
- Activation: `/activate`, `/wallet`
- Trading: `/order`, `/orders`, `/portfolio`
- Coins: `/purchase-coins`, `/coin-pack-price`

**Challenge Routes** (`/challenge/...`)
- Rules: `/create`, `/current`
- Validation: `/check-order`
- Actions: `/quick-unlock`, `/log-trade`

---

## Key Database Tables

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `users` | User auth & Dhan details | dhan_client_id, dhan_access_token, firebase_token |
| `pending_orders` | Track super orders | dhan_client_id, order_id, order_type, target_price, stop_loss_price |
| `demo_orders` | Demo trading history | dhan_client_id, security_id, transaction_type, quantity, price, target_price, order_type |
| `demo_wallets` | Demo coin balance | dhan_client_id, total_granted_coins, is_first_activation |
| `demo_settings` | Admin config | setting_key, setting_value |
| `user_challenges` | Challenge rules | dhan_client_id, nifty_lots, banknifty_lots, max_loss, max_profit, max_trades_per_day |
| `challenge_trade_logs` | P&L tracking | dhan_client_id, index_name, quantity, pnl, trade_date |
| `instruments` | Security master | security_id, symbol_name, lot_size, exchange_segment, option_type, strike_price, expiry_date |

---

## Order Flow Comparison

### Real Order
```
User Input
  ↓ [Validation]
Check Challenge Rules (POST /challenge/check-order)
  ↓ [Allowed/Blocked]
  ├─ Blocked → Show Overlay, offer Quick Unlock
  └─ Allowed → Continue
       ↓
    POST /dhan/buy-order OR /dhan/buy-super-order
       ↓
    Dhan API processes (real market)
       ↓
    Response: orderId
       ↓
    Firebase notification
       ↓
    Frontend shows success
```

### Demo Order
```
User Input
  ↓ [Validation]
Check Coin Balance (BUY) / Check Holdings (SELL)
  ↓ [Sufficient/Insufficient]
  ├─ Insufficient → Show Error
  └─ Sufficient → Continue
       ↓
    POST /demo/order (insert in demo_orders table)
       ↓
    Recalculate available coins
       ↓
    Response: availableCoins
       ↓
    Frontend shows success
```

---

## Toggle Between Real & Demo

**Frontend Implementation:**
```dart
ListenableBuilder(
  listenable: DemoModeService.instance,
  builder: (context, _) {
    if (DemoModeService.instance.isActive) {
      return _DemoView();
    }
    return _RealView();
  },
)
```

**Service Code:**
```dart
class DemoModeService extends ChangeNotifier {
  static final instance = DemoModeService._();
  
  bool _isActive = false;
  bool get isActive => _isActive;
  
  Future<void> setActive(bool value) async {
    _isActive = value;
    await GetStorage().write('demo_mode_active', value);
    notifyListeners();  // Rebuilds UI
  }
}
```

**Persistence:** GetStorage (local device)

---

## Challenge Rules Enforcement

### Before Every Trade:
```
POST /challenge/check-order
{
  "index": "NIFTY",
  "quantity": 50,
  "lots": 1
}

Response: { "allowed": true/false, "rule": "RULE_NAME", "message": "..." }

Rules that can block:
  ├─ DAILY_LOSS_LIMIT (todayPnL <= -max_loss)
  ├─ DAILY_PROFIT_TARGET (todayPnL >= max_profit)
  ├─ MAX_TRADES_LIMIT (trade count >= max_trades_per_day)
  └─ QUANTITY_RULE (qty > index_lots)
```

### If Blocked:
```
UI shows overlay:
  "🎯 Profit target reached! Use Quick Unlock to continue."
  
User clicks Quick Unlock:
  POST /challenge/quick-unlock
  ↓
  Session resets, can trade again
```

---

## Demo Coin Economy

### Lifecycle:
```
1. Activation
   └─ Grant: 100,000 coins (free)

2. Trading
   ├─ BUY order (qty=50, price=100)
   │  └─ Deduct: 5,000 coins
   │
   └─ SELL order (qty=50, price=100)
      └─ Add: 5,000 coins

3. Running Balance:
   availableCoins = totalGranted + ∑(SELL receipts) - ∑(BUY costs)

4. Purchase More:
   └─ In-app transaction → POST /demo/purchase-coins
      └─ Add: 100,000 coins (1 pack)
```

### Admin Control:
```
demo_settings table:
  ├─ coin_pack_price: 100 (rupees)
  ├─ coin_pack_coins: 100000 (coins per pack)
  └─ free_coins_on_signup: 100000 (initial grant)
```

---

## Super Orders (Limit Order + Target + SL)

### Backend Flow:
```
POST /dhan/buy-super-order
{
  "transactionType": "BUY" | "SELL",
  "securityId": "12345",
  "quantity": 50,
  "price": 100.50,
  "targetPrice": 105,
  "stopLossPrice": 95
}

API Call → Dhan:
  POST https://api.dhan.co/v2/super/orders

Response → Store in pending_orders table:
  {
    dhan_client_id,
    order_id,
    order_type: 'SUPER',
    target_price: 105,
    stop_loss_price: 95
  }
```

### Frontend:
```dart
// In BuyState
bool stoplossEnabled = true;
double targetPrice = 105;
double stopLossPrice = 95;

// If placing super order
if (orderType == OrderType.limit && stoplossEnabled) {
  endpoint = ApiEndpoints.buySuperOrderApi;
  payload = {
    "price": 100.50,
    "targetPrice": 105,
    "stopLossPrice": 95,
    ...
  };
}
```

### Demo:
```
Supports same params but:
  - NOT automatically executed
  - Just tracked in DB for reference
  - Manual status management
```

---

## Current Limitations

### Real Trading
- ❌ No paper trading (orders are live)
- ❌ No order modifications after execution
- ❌ No bracket order legs (entry + exit automated)
- ❌ No intraday P&L streaming

### Demo Trading
- ❌ No automatic order execution on target/SL
- ❌ All orders marked "TRADED" immediately
- ❌ No realistic fills throughout day
- ❌ No partial fills
- ❌ No market slippage simulation

### Challenge System
- ❌ No mid-session P&L streaming
- ❌ No equity curve tracking
- ❌ No drawdown limits
- ❌ No leverage controls

### Super Orders
- ❌ No real-time target/SL monitoring
- ❌ No trailing stop implementation
- ❌ No OCO (One Cancels Other) logic
- ❌ No bracket order (entry + exit legs)

---

## Testing Endpoints

### Real Mode (Live Dhan)
```bash
# Generate OAuth consent
GET /dhan/generate-consent

# Consume token
POST /dhan/consume-consent
{ "tokenId": "..." }

# Place buy order
POST /dhan/buy-order
{
  "dhanAccessToken": "...",
  "securityId": "12345",
  "exchangeSegment": "NSE_FNO",
  "quantity": 50,
  "orderType": "MARKET"
}

# Place super order
POST /dhan/buy-super-order
{
  "dhanAccessToken": "...",
  "securityId": "12345",
  "quantity": 50,
  "price": 100,
  "targetPrice": 105,
  "stopLossPrice": 95
}

# Get orders
GET /dhan/orders

# Get portfolio
GET /dhan/portfolio
```

### Demo Mode
```bash
# Activate demo
POST /demo/activate

# Get wallet
GET /demo/wallet

# Place order
POST /demo/order
{
  "securityId": "12345",
  "tradingSymbol": "NIFTY50",
  "exchangeSegment": "NSE_FNO",
  "transactionType": "BUY",
  "orderType": "MARKET",
  "quantity": 50,
  "price": 100
}

# Get orders
GET /demo/orders

# Get portfolio
GET /demo/portfolio

# Cancel order
DELETE /demo/order/:id
```

### Challenge Mode
```bash
# Check if can place order
POST /challenge/check-order
{
  "index": "NIFTY",
  "quantity": 50,
  "lots": 1
}

# Quick unlock
POST /challenge/quick-unlock
```

---

## File Structure Reference

### Backend
```
investpas_node/
├── routes/
│   ├── dhan.js           → Real trading routes
│   ├── demo.js           → Demo trading routes
│   └── challenge.js      → Challenge routes
├── controllers/
│   ├── DhanController.js → Dhan logic
│   ├── DemoController.js → Demo logic
│   └── ChallengeController.js
├── helpers/
│   ├── challengeEngine.js → Rules checking
│   ├── orderManager.js   → Order processing
│   └── dhanMarketFeed.js → WebSocket
└── vars/
    └── db.js, constants.js
```

### Frontend
```
investapas/lib/
├── presentation/
│   ├── pages/
│   │   ├── buy/
│   │   ├── sell/
│   │   ├── orders/
│   │   ├── position/
│   │   └── demo/
│   └── bloc/
│       ├── buy/        → BuyBloc
│       ├── sell/       → SellBloc
│       ├── demo/       → DemoBloc
│       ├── orders/     → OrderBloc
│       └── trading_terminal/  → TerminalBloc
├── core/
│   ├── services/
│   │   ├── demo_mode_service.dart
│   │   └── free_unlock_timer_service.dart
│   └── network/
│       └── api_endpoints.dart
└── data/
    ├── models/
    │   ├── demo_order_model.dart
    │   ├── order_model.dart
    │   └── portfolio_position.dart
    └── services/
        └── live_price_service.dart
```

---

## Integration Points

### With External Services
- **Dhan Broker API**: `https://api.dhan.co/v2/`
  - Orders endpoint: `/orders`, `/orders/:id`
  - Portfolio: `/positions`
  - Trades: `/trades`
  - Super orders: `/super/orders`

- **Dhan WebSocket**: Real-time market data
  - Subscribed via: LivePriceService
  - Consumed by: TerminalBloc

- **Firebase**: Push notifications
  - Triggered on: Order events
  - Sent via: _notifyUser() helper

- **MySQL Database**: All persistent data
  - Queries via: query.js helpers

---

## Next Steps for Development

1. **Super Orders Real Execution**: Implement automatic target/SL fills
2. **Paper Trading**: Allow backtesting with Dhan data
3. **Advanced Orders**: Bracket, OCO, trailing stop
4. **Risk Management**: Portfolio-level limits, margin tracking
5. **Analytics**: Equity curve, drawdown, Sharpe ratio
6. **Notifications**: SMS alerts, email reports
7. **Mobile UI**: Responsive layouts for all screens
8. **Performance**: Real-time P&L aggregation

---

Generated: June 2024  
Status: Complete architecture review  
Focus: Dual-mode trading with demo simulation
