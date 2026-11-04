const express = require("express");

const router = express.Router();

const adminController =
    require("../controllers/admin.controller");

const dashboardController =
    require("../controllers/dashboardController");

const quizAdminController =
    require("../controllers/QuizAdminController");

const authMiddleware =
    require("../middlewares/authentication");


// ============================
// ADMIN LOGIN
// ============================

router.post(
    "/login",
    adminController.adminLogin
);


// ============================
// DASHBOARD STATS
// ============================

router.get(
    "/dashboard-stats",
    authMiddleware.authentication,
    dashboardController.getDashboardStats
);


// ============================
// GET USERS
// ============================

router.get(
    "/users",
    authMiddleware.authentication,
    adminController.getUsers
);


// ============================
// USER DETAILS
// ============================

router.get(
    "/users/:id",
    authMiddleware.authentication,
    adminController.userDetails
);


// ============================
// USER CHALLENGES
// ============================

router.get(
    "/users/:id/challenges",
    authMiddleware.authentication,
    adminController.userChallenges
);
router.get(
    "/users/:id/demo-orders",
    authMiddleware.authentication,
    adminController.userDemoOrders
);

router.get(
    "/users/:id/demo-wallet",
    authMiddleware.authentication,
    adminController.userDemoWallet
);

router.get(
    "/users/:id/coin-transactions",
    authMiddleware.authentication,
    adminController.userCoinTransactions
);

router.get(
    "/users/:id/coins",
    authMiddleware.authentication,
    adminController.userCoins
);

router.get(
    "/users/:id/wishlist",
    authMiddleware.authentication,
    adminController.userWishlist
);

router.get(
    "/website-contacts",
    authMiddleware.authentication,
    adminController.websiteContacts
);


// ============================
// LOGOUT
// ============================

router.post(
    "/logout",
    authMiddleware.authentication,
    adminController.adminLogout
);


// ============================
// QUIZ & PLACES
// ============================

router.get(
    "/quiz/dashboard",
    authMiddleware.authentication,
    quizAdminController.dashboard
);

router.get(
    "/quiz/players",
    authMiddleware.authentication,
    quizAdminController.players
);

router.get(
    "/quiz/players/export",
    authMiddleware.authentication,
    quizAdminController.exportPlayersCsv
);

router.get(
    "/quiz/players/:sessionId",
    authMiddleware.authentication,
    quizAdminController.playerDetail
);

router.post(
    "/quiz/players/:sessionId/reveal",
    authMiddleware.authentication,
    quizAdminController.revealNumber
);

router.get(
    "/quiz/places",
    authMiddleware.authentication,
    quizAdminController.places
);

router.post(
    "/quiz/places",
    authMiddleware.authentication,
    quizAdminController.addPlace
);

router.put(
    "/quiz/places/:src",
    authMiddleware.authentication,
    quizAdminController.updatePlace
);

router.post(
    "/quiz/places/:src/deactivate",
    authMiddleware.authentication,
    quizAdminController.deactivatePlace
);

router.get(
    "/quiz/places/:src/qr.:format",
    authMiddleware.authentication,
    quizAdminController.placeQr
);

module.exports = router;