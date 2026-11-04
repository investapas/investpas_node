'use strict';

const apiResponse = require('../vars/apiResponse');
const dbcon       = require('../config/mysqlClient');
const constants   = require('../vars/constants');
const nodemailer  = require('nodemailer');

// ── Nodemailer transporter ────────────────────────────────────────────────────
function _createTransporter() {
    return nodemailer.createTransport({
        host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

// Fire-and-forget: send confirmation email to the user
async function _sendConfirmationEmail(contact) {
    try {
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;

        const transporter = _createTransporter();
        const fullName    = `${contact.first_name} ${contact.last_name}`;

        await transporter.sendMail({
            from:    `"Investapas Support" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
            to:      contact.email,
            subject: 'Thank you for contacting Investapas!',
            html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1565C0,#42A5F5);padding:36px 40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:24px;letter-spacing:1px;">INVESTAPAS</h1>
              <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;">Behavioural Trading Discipline Platform</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <h2 style="color:#1A237E;margin:0 0 16px;">Hi ${fullName},</h2>
              <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 20px;">
                Thank you for reaching out to us! We have successfully received your message and our team will get back to you as soon as possible.
              </p>

              <!-- Details card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9ff;border-radius:8px;border-left:4px solid #1565C0;margin:24px 0;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 10px;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px;">Your Contact Details</p>
                    <p style="margin:4px 0;color:#333;font-size:14px;"><strong>Name:</strong> ${fullName}</p>
                    <p style="margin:4px 0;color:#333;font-size:14px;"><strong>Email:</strong> ${contact.email}</p>
                    <p style="margin:4px 0;color:#333;font-size:14px;"><strong>Phone:</strong> ${contact.phone_number}</p>
                    ${contact.same_as_phone ? '' : `<p style="margin:4px 0;color:#333;font-size:14px;"><strong>WhatsApp:</strong> ${contact.whatsapp_number}</p>`}
                  </td>
                </tr>
              </table>

              <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 20px;">
                Our typical response time is <strong>within 24 hours</strong> for priority issues and <strong>1–3 business days</strong> for general queries.
              </p>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
                <tr>
                  <td style="background:linear-gradient(135deg,#1565C0,#42A5F5);border-radius:8px;padding:12px 28px;text-align:center;">
                    <a href="https://www.investapas.in" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;">Visit Investapas</a>
                  </td>
                </tr>
              </table>

              <p style="color:#888;font-size:13px;line-height:1.7;margin:24px 0 0;border-top:1px solid #eee;padding-top:20px;">
                If you did not submit this form, please ignore this email or contact us at
                <a href="mailto:support@investapas.in" style="color:#1565C0;">support@investapas.in</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#1A237E;padding:20px 40px;text-align:center;">
              <p style="color:rgba(255,255,255,0.7);margin:0;font-size:12px;">
                © ${new Date().getFullYear()} Investapas • Beta Version<br>
                <a href="mailto:support@investapas.in" style="color:rgba(255,255,255,0.6);">support@investapas.in</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
        });

        console.log(`[ContactController] Confirmation email sent to ${contact.email}`);
    } catch (err) {
        console.error('[ContactController] Email send error:', err.message);
    }
}

// ── POST /contact/submit  (no auth) ──────────────────────────────────────────
exports.submitContact = async (req, res) => {
    try {
        const {
            first_name,
            last_name,
            email,
            phone_number,
            whatsapp_number,
            same_as_phone,
        } = req.body;

        // Basic validation
        if (!first_name || !last_name || !email || !phone_number) {
            return apiResponse.validationErrorResponse(res,
                'first_name, last_name, email and phone_number are required.');
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return apiResponse.validationErrorResponse(res, 'Invalid email address.');
        }

        const sameAsPhone = same_as_phone === true || same_as_phone === 'true' || same_as_phone === 1;
        const whatsappNum = sameAsPhone ? phone_number : (whatsapp_number || phone_number);

        const db = constants.vals.defaultDB;
        const normalizedEmail = email.trim().toLowerCase();
        const normalizedPhone = phone_number.trim();

        // Duplicate check — increment counter if already registered
        const existing = await dbcon.query(db,
            `SELECT id, email, phone_number, contact_count FROM website_contacts
             WHERE email = ? OR phone_number = ? LIMIT 1`,
            [normalizedEmail, normalizedPhone]
        );

        if (existing && existing.length > 0) {
            const dup       = existing[0];
            const newCount  = (dup.contact_count || 1) + 1;

            await dbcon.query(db,
                `UPDATE website_contacts
                 SET contact_count = ?, last_contacted_at = NOW()
                 WHERE id = ?`,
                [newCount, dup.id]
            );

            let msg = 'We already have your details and will reach out soon.';
            if (dup.email === normalizedEmail && dup.phone_number === normalizedPhone) {
                msg = `We already have your email and phone number on file (${newCount} contact${newCount > 1 ? 's' : ''}). Our team will reach out to you soon.`;
            } else if (dup.email === normalizedEmail) {
                msg = `We already have your email address on file (${newCount} contact${newCount > 1 ? 's' : ''}). Our team will reach out to you soon.`;
            } else if (dup.phone_number === normalizedPhone) {
                msg = `We already have your phone number on file (${newCount} contact${newCount > 1 ? 's' : ''}). Our team will reach out to you soon.`;
            }

            return apiResponse.validationErrorResponse(res, msg);
        }

        const params = {
            first_name:      first_name.trim(),
            last_name:       last_name.trim(),
            email:           normalizedEmail,
            phone_number:    normalizedPhone,
            whatsapp_number: whatsappNum.trim(),
            same_as_phone:   sameAsPhone ? 1 : 0,
            created_at:      new Date(),
        };

        const result = await dbcon.query(db,
            'INSERT INTO website_contacts SET ?',
            [params]
        );

        const contact = { ...params, id: result.insertId };

        // Send email without blocking response
        _sendConfirmationEmail(contact);

        return apiResponse.successResponseWithData(res, 'Thank you! We will get back to you soon.', {
            id: result.insertId,
        });

    } catch (err) {
        console.error('[ContactController] submitContact error:', err);
        return apiResponse.ErrorResponse(res, 'Something went wrong. Please try again.');
    }
};

// ── GET /contact/list  (no auth) ─────────────────────────────────────────────
exports.getContacts = async (req, res) => {
    try {
        const db     = constants.vals.defaultDB;
        const page   = parseInt(req.query.page  || '1',  10);
        const limit  = parseInt(req.query.limit || '20', 10);
        const offset = (page - 1) * limit;
        const search = req.query.search ? req.query.search.trim() : '';

        let condition = `ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
        let countCondition = '';

        if (search) {
            const s = search.replace(/'/g, "''");
            const filter = `WHERE first_name LIKE '%${s}%' OR last_name LIKE '%${s}%' OR email LIKE '%${s}%' OR phone_number LIKE '%${s}%'`;
            condition     = `${filter} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
            countCondition = filter;
        }

        const countResult = await dbcon.query(db,
            `SELECT COUNT(*) AS total FROM website_contacts ${countCondition}`,
            []
        );
        const total = countResult[0] ? countResult[0].total : 0;

        const rows = await dbcon.query(db,
            `SELECT id, first_name, last_name, email, phone_number,
                    whatsapp_number, same_as_phone,
                    contact_count, last_contacted_at, created_at
             FROM website_contacts ${condition}`,
            []
        );

        return apiResponse.successResponseWithData(res, 'Contact list fetched.', {
            total,
            page,
            limit,
            data: rows || [],
        });

    } catch (err) {
        console.error('[ContactController] getContacts error:', err);
        return apiResponse.ErrorResponse(res, 'Something went wrong.');
    }
};

// ── GET /contact/:id  (no auth) ───────────────────────────────────────────────
exports.getContactById = async (req, res) => {
    try {
        const db = constants.vals.defaultDB;
        const id = parseInt(req.params.id, 10);

        if (!id) return apiResponse.validationErrorResponse(res, 'Invalid id.');

        const rows = await dbcon.query(db,
            `SELECT id, first_name, last_name, email, phone_number,
                    whatsapp_number, same_as_phone,
                    contact_count, last_contacted_at, created_at
             FROM website_contacts WHERE id = ?`,
            [id]
        );

        if (!rows || !rows.length) return apiResponse.notFoundResponse(res, 'Contact not found.');

        return apiResponse.successResponseWithData(res, 'Contact fetched.', rows[0]);

    } catch (err) {
        console.error('[ContactController] getContactById error:', err);
        return apiResponse.ErrorResponse(res, 'Something went wrong.');
    }
};
