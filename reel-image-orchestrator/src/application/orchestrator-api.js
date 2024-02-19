const Consumer = require('sqs-consumer').Consumer;
const SQSClient = require('@aws-sdk/client-sqs').SQSClient;
const axios = require('axios');
const conn = require('./connection.js');
const {resolve} = require('path');
const ObjectID = require('mongodb').ObjectID;
const aws = require('aws-sdk');
const io = require('socket.io-client');

// AWS Connection Keys
const awsConfig = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_DEFAULT_REGION
};

const socketUrl = process.env.socket_url;

// AWS SQS URL
const sqsUrl = process.env.AWS_SQS_QUEUE_URL;

const preProcessUrl = 'http://localhost:12344/pre-processor';
const cropUrl = 'http://localhost:12345/crop';
const analyzeUrl = 'http://localhost:12346/anaylze';
const processUrl = 'http://localhost:12347/process';
const uploadUrl = 'http://localhost:12347/upload';

module.exports = {
    setup: function(app) {
        this.processWatcher(),
        app.post('/process-reel', this.startProcessWatcher),
        app.post('/getNotifications', this.getNotifications);
    },
    processWatcher: function() {
        console.log('Process Watcher Started');

        const consumer = Consumer.create({
            queueUrl: sqsUrl,
            handleMessage: async (message) => {
                console.log('Handle Message');
                console.log(message);
                if (message.Body) {
                    let reelInfo = null;
                    let reel = null;
                    try {
                        reel = JSON.parse(message.Body);
                        reelInfo = await getReelInfo(reel.reelId);
                    } catch (err) {
                        console.log('Error Getting Reel Info: ' + err);
                        await deleteSQSMessage(message);
                        return;
                    }

                    try {
                        if (!reelInfo || !reelInfo._id) {
                            console.error('Error: Process Reel Failed: No Reel Found');
                        } else if (reelInfo.event && reelInfo.event.type && reelInfo.event.type === 'done') {
                            console.log('Reel Already Processed');
                        } else if (reel.event == null) {
                            console.log('Reel Event Not Passed');
                        } else {
                            const types = ['pre-processor', 'cropper', 'analyzer', 'processor', 'uploader'];
                            if (reel.event.type == null || reel.event.type.trim().length < 1) {
                                reel.event.type = 'new';
                            }

                            reelInfo.event = {
                                type: reel.event.type,
                                status: reel.event.status,
                                message: reel.event.message
                            };

                            let start = false;
                            if ((reel.event.status != null && reel.event.status === 'complete') || reel.event.type === 'new') {
                                let typeIdx = types.indexOf(reel.event.type.trim().toLowerCase());
                                if (typeIdx > 3) {
                                    reelInfo.event = {
                                        type: 'done',
                                        status: reel.event.status,
                                        message: reel.event.message
                                    };
                                    await pushNotifications(reelInfo);
                                    await pushEventSocket(reelInfo);
                                } else {
                                    typeIdx += 1;
                                    reelInfo.event = {
                                        type: types[typeIdx],
                                        status: 'start',
                                        message: ''
                                    };
                                    start = true;
                                }
                            } else if (reel.event.status != null && reel.event.status === 'error') {
                                await pushNotifications(reelInfo);
                                await pushEventSocket(reelInfo);
                            }
                            await updateReel(reelInfo);
                            console.log(reelInfo);
                            if (start) {
                                reelInfo = await processReelOnType(reelInfo, reelInfo.event.type);
                                if (reelInfo != null && reelInfo.event != null && reelInfo.event.status === 'error') {
                                    await updateReel(reelInfo);
                                    await pushNotifications(reelInfo);
                                }
                            }
                        }
                    } catch (err) {
                        if (reelInfo != null) {
                            reelInfo.event = {
                                type: reel.event.type,
                                status: 'error',
                                message: 'Error: Process Reel Failed: ' + err
                            };
                            await updateReel(reelInfo);
                            await pushNotifications(reelInfo);
                            await pushEventSocket(reelInfo);
                        }
                        console.error('Error: Process Reel Failed: ' + err);
                    }
                } else {
                    console.error('No Reel Object Found');
                }

                await deleteSQSMessage(message);
            },
            sqs: new SQSClient({
                region: awsConfig.region,
                sslEnabled: false,
                credentials: {
                    accessKeyId: awsConfig.accessKeyId,
                    secretAccessKey: awsConfig.secretAccessKey
                }
            })
        });

        consumer.on('error', (err) => {
            console.error(err.message);
        });

        consumer.on('processing_error', (err) => {
            console.error(err.message);
        });

        consumer.start();
    },
    startProcessWatcher: async function(req, res) {
        console.log('Start Process Reel');

        if (!req.body || !req.body._id || req.body._id.trim().length < 1) {
            res.status(500).send('Error: Process Reel Failed: No Reel Id Found');
        } else {
            try {
                const message = {
                    reelId: req.body._id.trim(),
                    event: {
                        type: 'new',
                        status: '',
                        message: ''
                    }
                };

                const sqs = new aws.SQS(awsConfig);
                const params = {
                    MessageBody: JSON.stringify(message),
                    QueueUrl: sqsUrl,
                    MessageGroupId: 'Ops-Reel'
                };
                sqs.sendMessage(params, (err, data) => {
                    if (err) {
                        res.error('Error: Send SQS Failed: ' + err);
                    }
                    res.send('Reel Process Started for Id: ' + req.body._id);
                });
            } catch (err) {
                res.status(500).send('Error: Process Reel Failed: ' + err);
            }
        }
    },
    getNotifications: function(req, res) {
        console.log('Get User Notifications');

        if (req && req.body && req.body.userId && req.body.userId > 0) {
            const res = getNotifications(req.body.userId);
            res.send(res);
        } else {
            console.log('Error: No User Id Found');
            res.error('No User Id Found');
        }
    }
};

const getReelInfo = function(reelId) {
    return new Promise((resolve, reject) => {
        try {
            const db = conn.getDB();
            const id = new ObjectID(reelId);
            db.collection('ops_ai_reel').findOne({'_id': id}, function(err, response) {
                if (err) {
                    console.log('Unable to get reel info: ' + err);
                    return reject(err);
                }
                return resolve(response);
            });
        } catch (error) {
            console.log(error);
            return reject(error);
        }
    });
};

const sendMessageToSQS = async function(messageBody, queueUrl, messageGroupId) {
    const sqs = new aws.SQS({
        apiVersion: '2012-11-05',
    });
    const params = {
        MessageBody: messageBody,
        QueueUrl: queueUrl,
        MessageGroupId: messageGroupId
    };
    return new Promise((resolve, reject) => {
        sqs.sendMessage(params, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data.MessageId);
            }
        });
    });
};

const processReel = async function(reel) {
    console.log('Reel Processing Started');
    if (!reel.event) {
        reel.event = {};
    }
    let types = ['pre-processor', 'crop', 'analyze', 'process'];
    if (reel.event.type === null || reel.event.type === 'new') {
        // Call Pre Processor API
    } else if (reel.event.type === 'pre-processor') {
        // Call Pre Processor API
    } else if (reel.event.type === 'cropper') {
        // Call Cropper API
        types = ['crop', 'analyze', 'process'];
    } else if (reel.event.type === 'analyzer') {
        // Call Analyzer API
        types = ['analyze', 'process'];
    } else if (reel.event.type === 'processor') {
        // Call Processor API
        types = ['process'];
    }

    if (!reel.event.type || reel.event.type !== 'done') {
        return processReelAllTypes(reel, types);
    } else {
        return reel;
    }
};

const processReelAllTypes = async function(reel, types) {
    console.log('Reel Processing all types');
    for (const type of types) {
        reel.event = {
            'type': type,
            'status': 'started'
        };
        reel = await updateReel(reel);
        if (reel && reel._id) {
            reel = await processReelOnType(reel, type);
            reel = await updateReel(reel);

            if (reel && reel._id) {
                await pushNotifications(reel);
                if (reel.event.status === 'error') {
                    return reel;
                }
            }
        } else {
            return null;
        }
    }

    reel.event = {
        type: 'done',
        status: 'complete',
        message: ''
    };
    await updateReel(reel);
    await pushNotifications(reel);
    return reel;
};

const processReelOnType = function(reel, type) {
    console.log('Reel Processing at: ' + type);
    let url = '';
    if (type === 'pre-processor') {
        url = preProcessUrl;
    } else if (type === 'cropper') {
        url = cropUrl;
    } else if (type === 'analyzer') {
        url = analyzeUrl;
    } else if (type === 'processer') {
        url = processUrl;
    } else if (type === 'uploader') {
        url = uploadUrl;
    } else {
        return 'done';
    }

    return new Promise((resolve) => {
        makeRequest(url, 'POST', reel).then(async (err, response) => {
            reel.event = {
                type: type,
                status: 'complete',
                message: 'Success: completed type - ' + type
            };
            await pushEventSocket(reel);
            resolve(null);
        }).catch((error) => {
            console.log('Error Processing Reel at: ' + type);
            reel.event = {
                type: type,
                status: 'error',
                message: 'Error: ' + error
            };
            resolve(reel);
        });
    });
};

const updateReel = async function(reel) {
    const db = conn.getDB();
    return new Promise((resolve, reject) => {
        try {
            const id = new ObjectID(reel._id);
            db.collection('ops_ai_reel').updateOne({'_id': id}, {$set: reel}, {upsert: true}, async function(err, response) {
                if (err) {
                    console.log('Unable to update reel: ' + err);
                    return reject(err);
                }
                return resolve(reel);
            });
        } catch (error) {
            console.log('Error Updating Reel: ' + error);
            return reject(error);
        }
    });
};

const pushNotifications = function(reel) {
    const body = {
        reelId: reel._id,
        uid: reel.operatorId,
        lastSuccessfulImageId: reel.lastSuccessfulImageId,
        lastSuccessfulImage: reel.lastSuccessfulImage,
        read: false
    };

    let message = '';
    let title = '';
    if (reel.event && reel.event.status && reel.event.status === 'error') {
        message = 'Error Processing Reel at Stage: ' + reel.event.type;
        title = 'Error';
    } else {
        message = 'Success Processing Reel at Stage: ' + reel.event.type;
        title = 'Success';
    }
    body.message = message;
    body.title = title;

    return new Promise((resolve, reject) => {
        try {
            const db = conn.getDB();
            db.collection('ops_notifications').insertOne(body, function(err, response) {
                if (err) {
                    console.log('Unable to insert notifications: ' + err);
                    return reject(err);
                }
                return resolve(response);
            });
        } catch (error) {
            console.log(error);
            return reject(error);
        }
    });
};

const pushEventSocket = function(data) {
    const socket = io.connect(socketUrl, {reconnect: true});

    // Add a connect listener
    socket.on('connect', function(socket) {
        console.log('Connected!');
    });
    socket.emit('reel/new', data);
};

const getNotifications = function(userId) {
    const db = conn.getDB();
    db.collection('ops_notifications').find({uid: userId}, function(err, response) {
        if (err) {
            console.log('Unable to get notifications: ' + err);
            throw err;
        }
        return response;
    });
};

const makeRequest = async function(url, requestType, body) {
    if (requestType === 'POST') {
        return await axios.post(url, body);
    } else {
        return await axios.get(url);
    }
};

const deleteSQSMessage = async function(message) {
    try {
        const sqs = new aws.SQS(awsConfig);
        const params = {
            QueueUrl: sqsUrl,
            ReceiptHandle: message.ReceiptHandle
        };

        await sqs.deleteMessage(params, (err, data) => {
            if (err) {
                console.log('Error Deleting SQS Message: ' + err);
            } else {
                console.log('Success Deleting SQS Message');
            }
        });
    } catch (err) {
        console.log('Error Deleting SQS Message: ' + err);
    }
};
