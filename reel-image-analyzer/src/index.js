const express = require('express');
const {PythonShell} = require('python-shell');

const awsFunctions = require('../../common-components/aws/aws');
awsFunctions.setAWSCredentials(
    process.env.ID,
    process.env.SECRET,
    process.env.AWS_DEFAULT_REGION,
);
const queueUrl = process.env.AWS_SQS_QUEUE_URL;

const app = express();
const port = 51101;
const conn = require('./application/connection.js');
conn.connection();
const fixedPath = '/Users/clarkfan/Desktop/test_image/';
app.use(express.json());

app.post('/analyze', async (req, res) => {
    const allProcessedImages = [];
    const db = conn.getDB();
    if (!req || !req.body || !req.body['reelId']) {
        return res.status(500).send({'success': false, 'message': 'Unable to get reel'});
    }
    const reelId = req.body['reelId'];
    const message = {
        'reelId': reelId,
        'event': {
            'type': 'analyzer',
            'status': 'start',
            'message': ''
        }
    };
    try {
        const options = {
            scriptPath: __dirname,
            args: [reelId],
        };
        const pyShell = new PythonShell('analyze.py', options);
        // Event listener for when the script starts
        pyShell.on('start', () => {
            console.log('Python script is running.');
        });

        // Event listener for when the script sends a message
        pyShell.on('message', (message) => {
            // console.log('Python script says:', message);
            const output = message;
            console.log('message start');
            console.log(output);
            console.log('message end');
        });

        // TODO: update to analyzed for images
        pyShell.end((err) => {
            if (err) {
                console.error(`Error: ${err}`);
                res.status(500).send(err);
                return;
            } else {
                console.log('Python shell ended successfully');
                res.send('Python script invoked.');
                return;
            }
        });
        // Send an immediate response to the client
        message.event.status = 'complete';
        awsFunctions.sendMessageToSQS(JSON.stringify(message), queueUrl, 'sendMessageToSQS');
    } catch (error) {
        message.event.status = 'error';
        message.event.message = JSON.stringify(error);
        awsFunctions.sendMessageToSQS(JSON.stringify(message), queueUrl, 'sendMessageToSQS');
        console.error('Error analyzing images:', error);
        res.status(500).send('Internal Server Error');
    }
});

conn.connection().then(() => {
    app.listen(port, () => {
        console.log(`App listening on port ${port}`);
    });
});
