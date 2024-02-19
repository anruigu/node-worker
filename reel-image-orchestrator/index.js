/**
 * Module dependencies.
 */
const express = require('express');
const bodyParser = require('body-parser');
const methodOverride = require('method-override');
const morgan = require('morgan');
const app = express();
const domain = require('domain');
const fs = require('fs');
const path = require('path');
const key = fs.readFileSync(path.resolve(__dirname, '../common-components/encryption/wildcard.2023.key'));
const cert = fs.readFileSync(path.resolve(__dirname, '../common-components/encryption/wildcard.2023.crt'));
const ca = fs.readFileSync(path.resolve(__dirname, '../common-components/encryption/gd_bundle-g2-g1.2023.crt'));
const https = require('https');
const api = require('./src/application/app.js');

const options = {
    key: key,
    cert: cert,
    ca: ca,
};

const d = domain.create();

d.on('error', function(err) {
    console.log(err.stack);
});
d.run(function() {
    // parse application/x-www-form-urlencoded
    app.use(bodyParser.urlencoded({
        extended: false,
    }));

    app.use(morgan('dev'));
    // parse application/json
    app.use(bodyParser.json({
        limit: '50mb',
    }));
    app.use(function(req, res, next) {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept,userid,username');
        if (req.method === 'OPTIONS') {
            res.status(200).end();
        } else {
            next();
        }
    });
    app.use(methodOverride());

    require('./src/application/app.js')(app);

    const port = 53000;
    // const port = process.env.secure_server_port;
    https.createServer(options, app).listen(port);
    console.log('http listening on: ' + port + ' and secure port ' + port);
});
