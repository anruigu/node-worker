const express = require('express');
const {PythonShell} = require('python-shell');
const conn = require('./application/connection.js');
const mongoose = require('mongoose');
const ObjectId = mongoose.Types.ObjectId;

const awsFunctions = require('../../common-components/aws/aws');
awsFunctions.setAWSCredentials(
    process.env.ID,
    process.env.SECRET,
    process.env.AWS_DEFAULT_REGION,
);
const queueUrl = process.env.AWS_SQS_QUEUE_URL;

const app = express();
const port = 51100;
app.use(express.json());

app.post('/preprocess', async (req, res) => {
    const db = conn.getDB();
    if (!req || !req.body || !req.body['reelId']) {
        return res.status(500).send({'success': false, 'message': 'Unable to get reel'});
    }
    const reelId = req.body['reelId'];
    let errPct = 0;
    const message = {
        'reelId': reelId,
        'event': {
            'type': 'preprocess',
            'status': 'start',
            'message': ''
        }
    };
    try {
        const reelData = await db.collection('ops_ai_reel').findOne({'_id': new ObjectId(reelId)});
        const goldenSampleData = reelData.goldenSampleData;
        const options = {
            scriptPath: __dirname,
            args: [reelId, JSON.stringify(goldenSampleData)],
        };
        const pyShell = new PythonShell('preprocess.py', options);
        res.send('Python script invoked.');
        // Event listener for when the script starts
        pyShell.on('start', () => {
            console.log('Python script is running.');
        });

        // Event listener for when the script sends a message
        pyShell.on('message', (messageFromPy) => {
            // console.log('Python script says:', message);
            const output = messageFromPy;
            errPct = JSON.parse(output).anomalyPct;
            message.event.message = output;
        });

        // TODO: update to preprocessed for images
        pyShell.end((err) => {
            if (err) {
                console.error(`Error: ${err.toString()}`);
                message.event.status = 'error';
                message.event.message = JSON.stringify(err.toString());
                awsFunctions.sendMessageToSQS(JSON.stringify(message), queueUrl, 'sendMessageToSQS');
            } else if (errPct > 0.1) {
                console.error(`Error: Anomaly Pct is ${errPct}`);
                message.event.status = 'error';
                message.event.message = `Error: anomaly Pct is ${errPct}`;
                awsFunctions.sendMessageToSQS(JSON.stringify(message), queueUrl, 'sendMessageToSQS');
            } else {
                console.log('Python shell ended successfully');
                message.event.status = 'complete';
                awsFunctions.sendMessageToSQS(JSON.stringify(message), queueUrl, 'sendMessageToSQS');
            }
        });
    } catch (error) {
        message.event.status = 'error';
        message.event.message = JSON.stringify(error);
        awsFunctions.sendMessageToSQS(JSON.stringify(message), queueUrl, 'sendMessageToSQS');
        console.error('Error preprocessing images:', error);
    }
});


conn.connection().then(() => {
    app.listen(port, () => {
        console.log(`App listening on port ${port}`);
    });
});
