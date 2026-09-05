"use strict";

const constants = require("../vars/constants");
const dbquery = require("./query");
const mongoClient = require("../config/mongoClient");
const utility = require("./utility");

const _ = require('underscore');
const axios = require('axios');
const Validator = require('validatorjs');
const _s = require("underscore.string");
const moment = require('moment-timezone');
const crypto = require("crypto");
const base64url = require('base64url');
const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
const useragent = require('useragent');
useragent(true);
const methods = exports;


exports.getGoogleAddressLatLng = async function (req, lat, lng) {
    try {
        // ✅ Step 1: Fetch Google Maps API key from DB (key_Name = 'backend')
        const keyData = await dbQuery.fetchSingleRecord(
            constants.vals.defaultDB,
            'google_map_api_key',
            "WHERE key_Name = 'backend' LIMIT 1",
            'google_map_keys'
        );

        const apikey = keyData?.google_map_keys || constants.vals.google_api;

        // ✅ Step 2: Initialize variables
        let cityName = "";
        let street = "";
        let county = "";
        let town = "";
        let distance = 0;
        let postcode = "";
        let address = "";
        let route = "";
        let for_route = true;
        let addres = "";

        // ✅ Step 3: Call Google Maps API
        let url_address = `https://maps.google.com/maps/api/geocode/json?sensor=false&key=${apikey}&latlng=${lat},${lng}`;
        const resp_json_addres = await utility.curl_gapi_file_get_contents(url_address);

        if (!utility.checkEmpty(resp_json_addres)) {
            const resp_address = JSON.parse(resp_json_addres);

            if (resp_address.status === 'OK') {
                if (utility.issetNested(resp_address, 'results', '0', 'address_components')) {
                    address = resp_address['results'][0]['address_components'];
                }

                route = '';
                for (let k in address) {
                    addres = address[k];
                    if (utility.issetNested(addres, 'types', '0') && addres['types'][0] === 'route' && for_route) {
                        for_route = false;
                        route = addres['long_name'];
                    }
                    if (utility.issetNested(addres, 'types', '0') && addres['types'][0] === 'postal_code') {
                        postcode = addres['long_name'];
                    }
                }

                if (utility.issetNested(address, 1, 'long_name')) street = address[1]['long_name'];
                if (utility.issetNested(address, 2, 'long_name')) town = address[2]['long_name'];
                if (!utility.checkEmpty(address[3]) && !utility.checkEmpty(address[3]['long_name'])) county = address[3]['long_name'];
                if (utility.checkEmpty(route) && utility.issetNested(address, 2, 'long_name')) route = address[2]['long_name'];

                street = route;
                if (utility.issetNested(address, 3, 'long_name')) cityName = address[3]['long_name'];

                if (utility.issetNested(resp_address, 'results', 0, 'geometry', 'location', 'lat')) {
                    lat = resp_address['results'][0]['geometry']['location']['lat'];
                }
                if (utility.issetNested(resp_address, 'results', 0, 'geometry', 'location', 'lng')) {
                    lng = resp_address['results'][0]['geometry']['location']['lng'];
                }
            }
        }

        // ✅ Step 4: Return structured response
        return {
            postcode,
            city: cityName,
            street,
            latitude: lat,
            longitude: lng
        };

    } catch (error) {
        console.error('Error in getGoogleAddressLatLng:', error);
        return {
            postcode: '',
            city: '',
            street: '',
            latitude: lat,
            longitude: lng
        };
    }
};



exports.getAXIOSData = async function (req, url, httpMethod, header, data) {

    var config = {
        method: httpMethod,
        url: url,
        headers: header,
        data: JSON.stringify(data)
    };

    var val = "cc";

    await axios(config)
        .then(function (response) {
            val = JSON.stringify(response.data);
            val = response.data;//JSON.parse(val)
        })
        .catch(function (response) {
            val = JSON.stringify(response);
            val = JSON.parse(val)
        });

    return val
};


