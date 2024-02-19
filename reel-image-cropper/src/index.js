const express = require('express');
const jimp = require('jimp');
const fs = require('fs');
const path = require('path');
const conn = require('./application/connection.js');
const mongoose = require('mongoose');
const awsFunctions = require('../../common-components/aws/aws');
const ObjectId = mongoose.Types.ObjectId;
awsFunctions.setAWSCredentials(
    process.env.ID,
    process.env.SECRET,
    process.env.AWS_DEFAULT_REGION,
);
const queueUrl = process.env.AWS_SQS_QUEUE_URL;
const sendMessageToSQS = 'Ops-Reel';

const app = express();
const port = 51102;
// const fixedPath = '/test_image/';
const fixedPath = '/Users/clarkfan/Desktop/test_image/';
app.use(express.json());

app.post('/crop', async (req, res) => {
    const db = conn.getDB();
    let lastSuccessfulImage = null;
    const allProcessedImages = [];
    if (!req || !req.body || !req.body['reelId']) {
        return res.status(500).send({'success': false, 'message': 'Unable to get reel'});
    }
    const reelId = req.body['reelId'];
    const message = {
        'reelId': reelId,
        'event': {
            'type': 'cropper',
            'status': 'start',
            'message': ''
        }
    };
    try {
        db.collection('ops_ai_reel').findOne({'_id': new ObjectId(reelId)}, async function(err, reel) {
            if (err || reel == null) {
                return res.status(500).send({'success': false, 'message': 'Unable to get reel'});
            } else {
                // can find reel info based on reelId
                res.send({'success': true});
                const inputPath = fixedPath + reelId;
                const outputPath = fixedPath + reelId + '_output';
                const outputPathWithPin = fixedPath + reelId + '_output_with_pin';

                const cropX = reel.goldenSampleData.cropArea.x; // X-coordinate of the top-left corner
                const cropY = reel.goldenSampleData.cropArea.y; // Y-coordinate of the top-left corner
                const cropWidth = reel.goldenSampleData.cropArea.width; // Width of the cropped area
                const cropHeight = reel.goldenSampleData.cropArea.height; // Height of the cropped area

                const cropXWithPin = reel.goldenSampleDataWithPin.cropArea.x; // X-coordinate of the top-left corner
                const cropYWithPin = reel.goldenSampleDataWithPin.cropArea.y; // Y-coordinate of the top-left corner
                const cropWidthWithPin = reel.goldenSampleDataWithPin.cropArea.width; // Width of the cropped area
                const cropHeightWithPin = reel.goldenSampleDataWithPin.cropArea.height; // Height of the cropped area


                let rotationAngle = reel.goldenSampleData.rotation;
                let rotationAngleWithPin = reel.goldenSampleDataWithPin.rotation;

                rotationAngle = -rotationAngle;
                rotationAngleWithPin = -rotationAngleWithPin;
                // Create the output directory if it doesn't exist
                if (!fs.existsSync(outputPath)) {
                    fs.mkdirSync(outputPath, {recursive: true});
                }

                // Create the output with pin directory if it doesn't exist
                if (!fs.existsSync(outputPathWithPin)) {
                    fs.mkdirSync(outputPathWithPin, {recursive: true});
                }

                // Read the files in the input directory
                const files = fs.readdirSync(inputPath);
                files.sort((a, b) => a.localeCompare(b));
                const imagesToUpload = [];
                const webpExtension = '.webp';
                for (const file of files) {
                    if (!(file.endsWith('.jpg') || file.endsWith('.jpeg') || file.endsWith('.png') || file.endsWith('.bmp'))) {
                        continue;
                    }
                    const inputFilePath = path.join(inputPath, file);
                    const outputFilePath = path.join(outputPath, file);
                    const outputWithPinFilePath = path.join(outputPathWithPin, path.basename(file, path.extname(file)) + webpExtension);
                    const image = await jimp.read(inputFilePath);
                    // Apply the crop and rotation operations
                    image
                        .rotate(rotationAngle)
                        .crop(cropX, cropY, cropWidth, cropHeight)
                        .write(outputFilePath);

                    // TODO: check on how to correctly compress to webp since currently file size stays the same

                    jimp.read(inputFilePath).then((img) => {
                        return img
                            .rotate(rotationAngleWithPin)
                            .crop(cropXWithPin, cropYWithPin, cropWidthWithPin, cropHeightWithPin)
                            .quality(50)
                            .write(outputWithPinFilePath);
                    });

                    const tempImage = new Image(reelId, outputPath, file);
                    lastSuccessfulImage = file;
                    imagesToUpload.push(tempImage);
                    allProcessedImages.push(file);
                }

                // Create an array of update operations
                const bulkOperations = imagesToUpload.map((document) => ({
                    updateOne: {
                        filter: {'reelId': document.reelId, 'file.name': document.file.name},
                        update: {$set: document},
                        upsert: true
                    }
                }));

                // Perform upsert operation
                await db.collection('ops_ai_image').bulkWrite(bulkOperations);

                const reelDataToUpdate = {
                    'status': 'crop-complete',
                    'images': allProcessedImages,
                    'lastSuccessfulImage': lastSuccessfulImage
                };
                const reelUpdate = await db.collection('ops_ai_reel').updateOne(
                    {_id: new ObjectId(reelId)},
                    {$set: reelDataToUpdate}
                );

                if (reelUpdate.modifiedCount > 0) {
                    console.log(`Reel with _id ${reelId} updated successfully`);
                } else {
                    console.log(`No Reel found with _id ${reelId}`);
                }
            }
        });
        message.event.status = 'complete';
        awsFunctions.sendMessageToSQS(JSON.stringify(message), queueUrl, sendMessageToSQS);
    } catch (error) {
        console.error('Error processing images:', error);
        res.status(500).send('Internal Server Error');
        message.event.status = 'error';
        message.event.message = JSON.stringify(error);
        message.event.lastSuccessfulImage = lastSuccessfulImage;
        awsFunctions.sendMessageToSQS(JSON.stringify(message), queueUrl, sendMessageToSQS);
    }
});

class Image {
    constructor(reelId, filePath, fileName) {
        this.reelId = reelId;
        this.uploadedDate = new Date();
        this.archivedDate = null;
        this.status = 'uploaded';
        this.file = {
            'source': 'local',
            'path': filePath,
            'name': fileName
        };
        this.seq = fileName.split('_')[0];
    }
}

conn.connection().then(() => {
    app.listen(port, () => {
        console.log(`App listening on port ${port}`);
    });
});

