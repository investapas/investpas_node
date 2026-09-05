const bcrypt = require('bcrypt');
const { responseHandler } = require('../helpers/utility');
const dbQuery = require("../helpers/query");
let constants = require("../vars/constants");
let { notFoundResponse } = require("../vars/apiResponse");
const utility = require('../helpers/utility');
const jwt = require('jsonwebtoken');
const FileManager = require("../helpers/file_manager");
const moment = require('moment-timezone');
const { log } = require('console');

// User phone number verify
exports.userPhoneVerify = async (req, res) => {
    try {
        let response = { status: 'error', msg: '' };
        let bodyData = req?.body?.inputdata;

        if (utility.checkEmptyString(bodyData.user_Phone)) {
            response['msg'] = 'Phone number is required.';
            return utility.apiResponse(req, res, response);
        }

        if (!constants.vals.regex.phone_number.test(bodyData?.user_Phone)) {
            response['msg'] = 'Phone number must start with 6 and it must be 7 digits long.';
            return utility.apiResponse(req, res, response);
        }

        let condition = `WHERE user_Phone = ${bodyData?.user_Phone} AND is_active = 1 AND is_delete = 0`;
        let selectFields = 'user_Id, user_Name, user_Phone, user_Pin, user_Token';

        const checkPhoneNo = await dbQuery.fetchSingleRecord(
            constants.vals.defaultDB,
            'user',
            condition,
            selectFields
        );

        const otp = await utility.generateOtp(constants.vals.optLength);
        console.log(otp);
        console.log("dkasdksahdhjsagdhas");


        const hashedOtp = await bcrypt.hash(otp, 10);
        const date = req.locals.now;
        const localNow = moment.tz(date, 'YYYY-MM-DD HH:mm:ss', constants.vals.tz);
        const expiresAt = localNow.clone().add(constants.vals.otpExpireMinutes, 'minutes').format('YYYY-MM-DD HH:mm:ss');

        // If phone number is NOT in system → new user flow
        if (Array.isArray(checkPhoneNo) && checkPhoneNo.length == 0) {
            const params = {
                user_phone: bodyData?.user_Phone,
                otp_hash: hashedOtp,
                expires_at: expiresAt,
                created_at: date
            };
            await dbQuery.insertSingle(constants.vals.defaultDB, 'user_otp', params);

            await utility.sendSMS(bodyData?.user_Phone, otp);

            response['status'] = 'success';
            response['msg'] = 'Phone number is new. OTP has been sent for verification.';
            response['data'] = { isNewUser: true };
            return utility.apiResponse(req, res, response);
        }

        // Existing user → normal login OTP logic
        const userToken = jwt.sign({ phone: bodyData?.user_Phone }, 'apiservice');
        checkPhoneNo.user_Token = userToken;

        const newValue = `user_Token = '${userToken}', firebase_token = '${bodyData?.firebase_Token || ""}', updated_at = '${date}'`;
        const updateCondition = `user_Id = ${checkPhoneNo?.user_Id}`;
        await dbQuery.updateRecord(constants.vals.defaultDB, 'user', updateCondition, newValue);

        // Clean up old OTPs
        const deleteCondition = `user_Id = ${checkPhoneNo?.user_Id}`;
        await dbQuery.deleteRecord(constants.vals.defaultDB, 'user_otp', deleteCondition);

        // Store OTP for existing user
        const otpParams = {
            user_id: checkPhoneNo?.user_Id,
            otp_hash: hashedOtp,
            expires_at: expiresAt,
        };
        await dbQuery.insertSingle(constants.vals.defaultDB, 'user_otp', otpParams);

        await utility.sendSMS(bodyData?.user_Phone, otp);
        await utility.addAuthenticationLogs(checkPhoneNo?.user_Id, 'Login', 'Success', req.ip);

        response['status'] = 'success';
        response['data'] = { ...checkPhoneNo, isNewUser: false };
        response['msg'] = 'Existing phone verified successfully and OTP sent.';
        return utility.apiResponse(req, res, response);

    } catch (error) {
        throw error;
    }
};

exports.userOtpVerify = async (req, res) => {
    try {
        let response = { status: 'error', msg: '' };
        let bodyData = req?.body?.inputdata;

        if (utility.checkEmptyString(bodyData?.otp)) {
            response['msg'] = 'OTP is required.';
            return utility.apiResponse(req, res, response);
        }

        console.log(bodyData);
        console.log("dkjaskdhjsadh");

        // Either user_Id or user_Phone must be provided
        if (utility.checkEmptyString(bodyData?.user_Id) && utility.checkEmptyString(bodyData?.user_Phone)) {
            response['msg'] = 'Either user_Id or user_Phone is required.';
            return utility.apiResponse(req, res, response);
        }

        // Build condition dynamically
        let condition;
        if (bodyData?.user_Id) {
            condition = `WHERE user_Id = ${bodyData?.user_Id} ORDER BY created_at DESC LIMIT 1`;
        } else {
            condition = `WHERE user_phone = '${bodyData?.user_Phone}' ORDER BY created_at DESC LIMIT 1`;
        }

        let selectFields = 'id, user_Id, user_phone, otp_Hash, expires_at';
        const checkOtp = await dbQuery.fetchSingleRecord(constants.vals.defaultDB, 'user_otp', condition, selectFields);

        if (!checkOtp || checkOtp.length == 0) {
            response['msg'] = 'OTP not found or expired. Please request a new one.';
            return utility.apiResponse(req, res, response);
        }

        // Verify expiration
        if (checkOtp?.expires_at < req.locals.now) {
            response['msg'] = 'OTP has expired.';
            return utility.apiResponse(req, res, response);
        }

        // Compare hash
        const isMatch = await bcrypt.compare(bodyData?.otp, checkOtp?.otp_Hash);
        if (!isMatch) {
            response['msg'] = 'Invalid OTP. Please try again.';
            return utility.apiResponse(req, res, response);
        }

        // OTP is correct → delete used OTP
        const deleteCondition = `id = ${checkOtp?.id}`;
        await dbQuery.deleteRecord(constants.vals.defaultDB, 'user_otp', deleteCondition);

        // If new user → send flag to frontend to show registration form
        if (!checkOtp?.user_Id && checkOtp?.user_phone) {
            response['status'] = 'success';
            response['msg'] = 'OTP verified successfully. Proceed to registration.';
            response['data'] = {
                isNewUser: true,
                phone: checkOtp?.user_phone
            };
            return utility.apiResponse(req, res, response);
        }

        // If existing user → normal success flow
        response['status'] = 'success';
        response['msg'] = 'OTP verified successfully. Login successful.';
        response['data'] = {
            isNewUser: false,
            user_Id: checkOtp?.user_Id
        };
        return utility.apiResponse(req, res, response);

    } catch (error) {
        throw error;
    }
};
