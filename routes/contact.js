const express = require('express');
const app     = express();

const apiMiddleware = require('../middlewares/api');
const {
    submitContact,
    getContacts,
    getContactById,
} = require('../controllers/ContactController');

// All contact APIs — no token required
app.post('/submit',  apiMiddleware, submitContact);
app.get('/list',     apiMiddleware, getContacts);
app.get('/:id',      apiMiddleware, getContactById);

module.exports = app;
