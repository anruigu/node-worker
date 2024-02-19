const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const conn = require('./application/connection.js');
const vision = require('@google-cloud/vision');
const {GoogleAuth, grpc} = require('google-gax');
const awsFunctions = require('../../common-components/aws/aws');
const {PythonShell} = require('python-shell');

awsFunctions.setAWSCredentials(
    process.env.ID,
    process.env.SECRET,
    process.env.AWS_DEFAULT_REGION,
);
const ObjectId = mongoose.Types.ObjectId;
const apiKey = process.env.vision_api_key;
const queueUrl = process.env.AWS_SQS_QUEUE_URL;


function getApiKeyCredentials() {
    const sslCreds = grpc.credentials.createSsl();
    const googleAuth = new GoogleAuth();
    const authClient = googleAuth.fromAPIKey(apiKey);
    const credentials = grpc.credentials.combineChannelCredentials(
        sslCreds,
        grpc.credentials.createFromGoogleCredential(authClient)
    );
    return credentials;
}
// initialize the client
const sslCreds = getApiKeyCredentials();
const client = new vision.ImageAnnotatorClient({sslCreds});
const app = express();
const port = 51103;
const fixedPath = '/Users/clarkfan/Desktop/test_image/';
conn.connection();
app.use(express.json());


app.post('/process', async (req, res) => {
    const db = conn.getDB();

    const reelId = req.body['reelId'];
    const message = {
        'reelId': reelId,
        'event': {
            'type': 'processor',
            'status': 'start',
            'message': ''
        }
    };
    try {
        const reelData = await db.collection('ops_ai_reel').findOne({'_id': new ObjectId(reelId)});

        const startText = reelData.textToWatch[0];
        const endText = reelData.textToWatch[reelData.textToWatch.length - 1];

        const inputPath = fixedPath + reelId + '_grey_scale';
        const files = fs.readdirSync(inputPath);
        files.sort((a, b) => a.localeCompare(b));
        const allProcessedImages = [];
        const imagesWithIssue = [];

        for (const file of files) {
            if (!(file.endsWith('.jpg') || file.endsWith('.jpeg') || file.endsWith('.png') || file.endsWith('.bmp'))) {
                continue;
            }
            const inputFilePath = path.join(inputPath, file);

            // /////////////////////////////////////////////////
            // /////////////////////////////////////////////////
            // /////////////////////////////////////////////////
            // DO NOT REMOVE THIS
            const result = await client.textDetection(inputFilePath);
            // DO NOT REMOVE THIS
            // /////////////////////////////////////////////////
            // /////////////////////////////////////////////////
            // /////////////////////////////////////////////////


            // FOR Test purpose, use locally cached data
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // const result = simulateVisionAiCall();
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING
            // REMOVE WHEN READY FOR TESTING

            if (result && result[0] && result[0].fullTextAnnotation.text) {
                const extractedText = result[0].fullTextAnnotation.text;
                const modifiedText = filterText(extractedText, startText, endText);

                const tempImageUpdate = {
                    file: {
                        name: file
                    },
                    status: 'analyzed',
                    extractedText: extractedText,
                    modifiedText: modifiedText,
                    visionAiResponse: result
                };
                allProcessedImages.push(tempImageUpdate);
            } else {
                imagesWithIssue.push(file);
            }
        }
        // Perform upsert operation
        // save the extracted text
        const bulkOperations = allProcessedImages.map((document) => {
            const fileName = document.file.name;
            delete document['file'];
            return {
                updateOne: {
                    filter: {'reelId': reelId, 'file.name': fileName},
                    update: {$set: document},
                    upsert: true
                }
            };
        });
        res.send('Image processed.');
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

app.get('/result', async (req, res) => {
    const db = conn.getDB();
    const reelId = req.query.reelId;
    db.collection('ops_ai_image').find({'reelId': reelId}).toArray(function(err, images) {
        if (err || images == null) {
            return res.status(500).send({'success': false, 'message': 'Unable to get reel'});
        }
        const ids = [];
        const filePaths = [];
        const visionAiResponses = [];
        for (const image of images) {
            const id = image._id;
            const file = image.file;
            const filePath = file.path + '/' + file.name;
            const visionAiResponse = image.visionAiResponse;
            if (!visionAiResponse) {
                continue;
            }
            filePaths.push(filePath);
            ids.push(id);
            visionAiResponses.push(visionAiResponse);
        }
        const data = {
            ids: ids,
            filePaths: filePaths,
            visionAiResponses: visionAiResponses
        };
        const filename = `${reelId}.json`;
        fs.writeFileSync(filename, JSON.stringify(data));
        const options = {
            scriptPath: __dirname,
            args: [filename],
        };
        const pyShell = new PythonShell('processor.py', options);
        // Event listener for when the script starts
        pyShell.on('start', () => {
            console.log('Python script is running.');
        });
        let output = null;
        // Event listener for when the script sends a message
        pyShell.on('message', (messageFromPy) => {
            // TODO:
            // group it in python, and handle it here
            console.log('Python script says:', messageFromPy);
            output = messageFromPy;
        });

        pyShell.end((err) => {
            if (err) {
                console.error(`Error: ${err.toString()}`);
                res.status(500).send(err);
            } else {
                res.send(JSON.parse(output));
                console.log('Python shell ended successfully');
            }
            fs.unlinkSync(filename);
        });
    });
});

function filterText(inputText, start, end) {
    const placeholder = '<NEWLINE>';
    const modifiedText = inputText.replace(/\n/g, placeholder);

    const firstIndex = modifiedText.indexOf(start);
    const lastIndex = modifiedText.lastIndexOf(end);

    if ((firstIndex === -1 && lastIndex === -1) || (lastIndex !== -1 && lastIndex < firstIndex)) {
        return inputText;
    }

    if (firstIndex === -1) {
        return modifiedText.substring(0, lastIndex + end.length).replace(new RegExp(placeholder, 'g'), '\n');
    }

    if (lastIndex === -1) {
        return modifiedText.substring(firstIndex).replace(new RegExp(placeholder, 'g'), '\n');
    }

    return modifiedText.substring(firstIndex, lastIndex + end.length).replace(new RegExp(placeholder, 'g'), '\n');
}

conn.connection().then(() => {
    app.listen(port, () => {
        console.log(`App listening on port ${port}`);
    });
});


function simulateVisionAiCall() {
    const response = [{
        'textAnnotations': [{
            'locale': 'und',
            'description': 'A AMEL\nAT27C256R\n70JU\n2127',
            'boundingPoly': {
                'vertices': [{'x': 84, 'y': 195},
                    {'x': 526, 'y': 195},
                    {'x': 526, 'y': 551},
                    {'x': 84, 'y': 551}]
            }
        },
        {
            'description': 'A',
            'boundingPoly': {
                'vertices': [{'x': 130, 'y': 201},
                    {'x': 210, 'y': 202},
                    {'x': 209, 'y': 269},
                    {'x': 129, 'y': 268}]
            }
        },
        {
            'description': 'AMEL',
            'boundingPoly': {
                'vertices': [{'x': 259, 'y': 202},
                    {'x': 476, 'y': 204},
                    {'x': 475, 'y': 271},
                    {'x': 258, 'y': 269}]
            }
        },
        {
            'description': 'AT27C256R',
            'boundingPoly': {
                'vertices': [{'x': 87, 'y': 311},
                    {'x': 521, 'y': 301},
                    {'x': 522, 'y': 371},
                    {'x': 89, 'y': 381}]
            }
        },
        {
            'description': '70JU',
            'boundingPoly': {
                'vertices': [{'x': 213, 'y': 403},
                    {'x': 393, 'y': 397},
                    {'x': 395, 'y': 457},
                    {'x': 215, 'y': 463}]
            }
        },
        {
            'description': '2127',
            'boundingPoly': {
                'vertices': [{'x': 214, 'y': 487},
                    {'x': 396, 'y': 485},
                    {'x': 397, 'y': 545},
                    {'x': 215, 'y': 547}]
            }
        }],
        'fullTextAnnotation': {
            'pages': [{
                'property': {
                    'detectedLanguages': [{
                        'languageCode': 'es',
                        'confidence': 0.19631624
                    }]
                },
                'width': 590,
                'height': 712,
                'blocks': [{
                    'boundingBox': {
                        'vertices': [{'x': 84, 'y': 201},
                            {'x': 521, 'y': 195},
                            {'x': 526, 'y': 545},
                            {'x': 89, 'y': 551}]
                    },
                    'paragraphs': [{
                        'boundingBox': {
                            'vertices': [{'x': 86, 'y': 201},
                                {'x': 521, 'y': 198},
                                {'x': 522, 'y': 378},
                                {'x': 87, 'y': 381}]
                        },
                        'words': [{
                            'property': {
                                'detectedLanguages': [{
                                    'languageCode': 'es',
                                    'confidence': 1
                                }]
                            },
                            'boundingBox': {
                                'vertices': [{'x': 130, 'y': 201},
                                    {'x': 210, 'y': 202},
                                    {'x': 209, 'y': 269},
                                    {'x': 129, 'y': 268}]
                            },
                            'symbols': [{
                                'property': {'detectedBreak': {'type': 'SPACE'}},
                                'boundingBox': {
                                    'vertices': [{'x': 130, 'y': 201},
                                        {'x': 210, 'y': 202},
                                        {'x': 209, 'y': 269},
                                        {'x': 129, 'y': 268}]
                                },
                                'text': 'A'
                            }]
                        },
                        {
                            'property': {
                                'detectedLanguages': [{
                                    'languageCode': 'es',
                                    'confidence': 1
                                }]
                            },
                            'boundingBox': {
                                'vertices': [{'x': 259, 'y': 202},
                                    {'x': 476, 'y': 204},
                                    {'x': 475, 'y': 271},
                                    {'x': 258, 'y': 269}]
                            },
                            'symbols': [{
                                'boundingBox': {
                                    'vertices': [{'x': 259, 'y': 202},
                                        {'x': 315, 'y': 203},
                                        {'x': 314, 'y': 270},
                                        {'x': 258, 'y': 269}]
                                },
                                'text': 'A'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 332, 'y': 203},
                                        {'x': 389, 'y': 204},
                                        {'x': 388, 'y': 271},
                                        {'x': 331, 'y': 270}]
                                },
                                'text': 'M'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 400, 'y': 204},
                                        {'x': 438, 'y': 204},
                                        {'x': 437, 'y': 271},
                                        {'x': 399, 'y': 271}]
                                },
                                'text': 'E'
                            },
                            {
                                'property': {'detectedBreak': {'type': 'EOL_SURE_SPACE'}},
                                'boundingBox': {
                                    'vertices': [{'x': 437, 'y': 204},
                                        {'x': 476, 'y': 204},
                                        {'x': 475, 'y': 271},
                                        {'x': 436, 'y': 271}]
                                },
                                'text': 'L'
                            }]
                        },
                        {
                            'boundingBox': {
                                'vertices': [{'x': 87, 'y': 311},
                                    {'x': 521, 'y': 301},
                                    {'x': 522, 'y': 371},
                                    {'x': 89, 'y': 381}]
                            },
                            'symbols': [{
                                'boundingBox': {
                                    'vertices': [{'x': 87, 'y': 312},
                                        {'x': 141, 'y': 311},
                                        {'x': 143, 'y': 380},
                                        {'x': 89, 'y': 381}]
                                },
                                'text': 'A'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 141, 'y': 310},
                                        {'x': 184, 'y': 309},
                                        {'x': 186, 'y': 378},
                                        {'x': 143, 'y': 379}]
                                },
                                'text': 'T'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 189, 'y': 309},
                                        {'x': 229, 'y': 308},
                                        {'x': 231, 'y': 377},
                                        {'x': 191, 'y': 378}]
                                },
                                'text': '2'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 240, 'y': 308},
                                        {'x': 279, 'y': 307},
                                        {'x': 281, 'y': 376},
                                        {'x': 242, 'y': 377}]
                                },
                                'text': '7'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 283, 'y': 307},
                                        {'x': 330, 'y': 306},
                                        {'x': 332, 'y': 375},
                                        {'x': 285, 'y': 376}]
                                },
                                'text': 'C'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 340, 'y': 306},
                                        {'x': 382, 'y': 305},
                                        {'x': 384, 'y': 374},
                                        {'x': 342, 'y': 375}]
                                },
                                'text': '2'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 388, 'y': 305},
                                        {'x': 429, 'y': 304},
                                        {'x': 431, 'y': 373},
                                        {'x': 390, 'y': 374}]
                                },
                                'text': '5'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 436, 'y': 304},
                                        {'x': 476, 'y': 303},
                                        {'x': 478, 'y': 372},
                                        {'x': 438, 'y': 373}]
                                },
                                'text': '6'
                            },
                            {
                                'property': {'detectedBreak': {'type': 'LINE_BREAK'}},
                                'boundingBox': {
                                    'vertices': [{'x': 477, 'y': 303},
                                        {'x': 521, 'y': 302},
                                        {'x': 523, 'y': 371},
                                        {'x': 479, 'y': 372}]
                                },
                                'text': 'R'
                            }]
                        }]
                    },
                    {
                        'boundingBox': {
                            'vertices': [{'x': 211, 'y': 401},
                                {'x': 394, 'y': 397},
                                {'x': 397, 'y': 545},
                                {'x': 214, 'y': 549}]
                        },
                        'words': [{
                            'boundingBox': {
                                'vertices': [{'x': 213, 'y': 403},
                                    {'x': 393, 'y': 397},
                                    {'x': 395, 'y': 457},
                                    {'x': 215, 'y': 463}]
                            },
                            'symbols': [{
                                'boundingBox': {
                                    'vertices': [{'x': 213, 'y': 404},
                                        {'x': 253, 'y': 403},
                                        {'x': 255, 'y': 462},
                                        {'x': 215, 'y': 463}]
                                },
                                'text': '7'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 258, 'y': 402},
                                        {'x': 299, 'y': 401},
                                        {'x': 301, 'y': 460},
                                        {'x': 260, 'y': 461}]
                                },
                                'text': '0'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 312, 'y': 400},
                                        {'x': 350, 'y': 399},
                                        {'x': 352, 'y': 458},
                                        {'x': 314, 'y': 459}]
                                },
                                'text': 'J'
                            },
                            {
                                'property': {'detectedBreak': {'type': 'EOL_SURE_SPACE'}},
                                'boundingBox': {
                                    'vertices': [{'x': 356, 'y': 399},
                                        {'x': 393, 'y': 398},
                                        {'x': 395, 'y': 457},
                                        {'x': 358, 'y': 458}]
                                },
                                'text': 'U'
                            }]
                        },
                        {
                            'boundingBox': {
                                'vertices': [{'x': 214, 'y': 487},
                                    {'x': 396, 'y': 485},
                                    {'x': 397, 'y': 545},
                                    {'x': 215, 'y': 547}]
                            },
                            'symbols': [{
                                'boundingBox': {
                                    'vertices': [{'x': 214, 'y': 488},
                                        {'x': 256, 'y': 488},
                                        {'x': 257, 'y': 547},
                                        {'x': 215, 'y': 547}]
                                },
                                'text': '2'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 262, 'y': 487},
                                        {'x': 298, 'y': 487},
                                        {'x': 299, 'y': 546},
                                        {'x': 263, 'y': 546}]
                                },
                                'text': '1'
                            },
                            {
                                'boundingBox': {
                                    'vertices': [{'x': 305, 'y': 486},
                                        {'x': 348, 'y': 486},
                                        {'x': 349, 'y': 545},
                                        {'x': 306, 'y': 545}]
                                },
                                'text': '2'
                            },
                            {
                                'property': {'detectedBreak': {'type': 'LINE_BREAK'}},
                                'boundingBox': {
                                    'vertices': [{'x': 357, 'y': 486},
                                        {'x': 396, 'y': 486},
                                        {'x': 397, 'y': 545},
                                        {'x': 358, 'y': 545}]
                                },
                                'text': '7'
                            }]
                        }]
                    }],
                    'blockType': 'TEXT'
                }]
            }],
            'text': 'A AMEL\nAT27C256R\n70JU\n2127'
        }
    }];
    return response;
}
