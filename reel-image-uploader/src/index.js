const express = require('express');
const fs = require('fs');
const path = require('path');
const conn = require('./application/connection.js');
const awsFunctions = require('../../common-components/aws/aws');
awsFunctions.setAWSCredentials(
    process.env.ID,
    process.env.SECRET,
    process.env.AWS_DEFAULT_REGION,
);
const queueUrl = process.env.AWS_SQS_QUEUE_URL;

const app = express();
const port = 51104;
const allowedExtensions = ['.jpg', '.jpeg', '.png', '.bmp', '.webp'];
const fixedPath = '/Users/clarkfan/Desktop/test_image/';
conn.connection();
app.use(express.json());


app.post('/upload', async (req, res) => {
    const db = conn.getDB();

    const reelId = req.body['reelId'];
    const message = {
        'reelId': reelId,
        'event': {
            'type': 'uploader',
            'status': 'start',
            'message': ''
        }
    };
    try {
        const inputPath = fixedPath + reelId + '_output_with_pin';
        const files = fs.readdirSync(inputPath);
        files.sort((a, b) => a.localeCompare(b));
        const allUploaded = [];

        for (const file of files) {
            if (!allowedExtensions.includes(path.extname(file))) {
                continue;
            }
            const inputFilePath = path.join(inputPath, file);
            const fileContent = fs.readFileSync(inputFilePath);
            allUploaded.push(file);
            await awsFunctions.uploadFileToS3AndRemoveLocalFile(
                process.env.BUCKET_NAME, reelId + '/cropped/' + file, fileContent, null, inputFilePath);
        }
        // Perform upsert operation
        // TODO:
        // check with team whether need to save cropped w/ pin files and original files
        const bulkOperations = allUploaded.map((fileName) => {
            return {
                updateOne: {
                    filter: {'reelId': reelId, 'file.name': fileName},
                    update: {$set: {
                        file: {
                            'name': fileName,
                            'path': reelId + '/cropped',
                            'source': 's3'
                        },
                        status: 'archived',
                        archivedDate: new Date()
                    }},
                    upsert: true
                }
            };
        });
        res.send('Image uploaded.');
        await db.collection('ops_ai_image').bulkWrite(bulkOperations);
        message.event.status = 'complete';
        awsFunctions.sendMessageToSQS(JSON.stringify(message), queueUrl, 'sendMessageToSQS');
    } catch (error) {
        // TODO
        message.event.status = 'error';
        message.event.message = JSON.stringify(error);
        awsFunctions.sendMessageToSQS(JSON.stringify(message), queueUrl, 'sendMessageToSQS');
    }
});

conn.connection().then(() => {
    app.listen(port, () => {
        console.log(`App listening on port ${port}`);
    });
});
