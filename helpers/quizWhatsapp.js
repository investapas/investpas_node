"use strict";
// Quiz WhatsApp messages (AiSensy) — NOT wired up yet. Savan chose to skip
// this for the first build since it needs a real AiSensy account + Meta-
// approved templates (quiz_result, drink_token, mentorship_confirmed —
// exact text in the Quiz Setup Guide PDF, Step 5).
//
// Every function below already has the right shape and is called from
// QuizController.js at the right moments — once AISENSY_API_KEY is set and
// the templates are approved, fill in the actual HTTP call (AiSensy's
// REST API, a POST per template) and these go live with no other code
// changes needed.
const configured = !!process.env.AISENSY_API_KEY;

async function sendQuizResult({ phone, correct, score, type }) {
    if (!configured) return; // no-op until AISENSY_API_KEY is set
    // TODO: POST the `quiz_result` template to AiSensy with
    // {{1}}=correct, {{2}}=score, {{3}}=type. The quick-reply button
    // "Show my answers" opens a 24h window; a separate AiSensy webhook
    // handler (not yet built) should reply with the full answers list
    // built from data/quiz_questions.json's t/ae/we fields.
}

async function sendDrinkToken({ phone, name, drink, placeName, token }) {
    if (!configured) return;
    // TODO: POST the `drink_token` template — {{1}}=name, {{2}}=drink,
    // {{3}}=placeName, {{4}}=token.
}

async function sendMentorshipConfirmed({ phone }) {
    if (!configured) return;
    // TODO: POST the `mentorship_confirmed` template, and separately
    // notify Prince and Sankalp (internal alert, not a WhatsApp template).
}

module.exports = { sendQuizResult, sendDrinkToken, sendMentorshipConfirmed };
