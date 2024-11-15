require('dotenv').config();
const express = require('express');
const { json, urlencoded } = express;
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const app = express();
const port = process.env.PORT || 4000;

const s3 = new S3Client({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const queueUrl = process.env.SQS_QUEUE_URL;

let clients = {};

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
    const clientId = Date.now();
    clients[clientId] = ws;
    console.log(`WebSocket connected: ${clientId}`);

    ws.on('message', (message) => {
        console.log('Received message:', message);
    });

    ws.on('close', () => {
        console.log(`WebSocket connection closed: ${clientId}`);
        delete clients[clientId];
    });
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

app.use(json()); // For parsing application/json
app.use(urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded
app.use((err, req, res, next) => {
    console.error('An unexpected error occurred:', err);
    res.status(500).send('Something went wrong. Please try again later.');
});

app.post('/process', async (req, res) => {
    console.log('Received request for video processing:', req.body);
    const { format, resolution, selectedVideo, userId } = req.body; // Get userId from the request body
    const localVideoPath = `./videos/${selectedVideo}`;
    const outputFilePath = `./videos/processed-${Date.now()}.${format}`;

    if (!selectedVideo || !userId) {
        return res.status(400).send('No video or user ID specified for conversion.');
    }

    try {
        await sendSQSMessage({
            status: 'Processing started',
            video: selectedVideo,
            format,
            resolution,
        });

        console.log(`Video processing started for ${selectedVideo} in ${format} format at ${resolution} resolution.`);

        // Update S3 Key with userId to locate the correct video file
        const getCommand = new GetObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `videos/${userId}/${selectedVideo}` // Use userId to build the correct path
        });
        const data = await s3.send(getCommand);

        const stream = fs.createWriteStream(localVideoPath);
        data.Body.pipe(stream);

        stream.on('finish', () => {
            broadcastProgress(10);

            ffmpeg(localVideoPath)
                .outputOptions(['-vf', `scale=${getScaleOption(resolution)}`])
                .toFormat(format)
                .output(outputFilePath)
                .on('progress', (progress) => {
                    const roundedProgress = Math.round(progress.percent);
                    broadcastProgress(roundedProgress);
                })
                .on('end', async () => {
                    console.log('Video processing complete');
                    broadcastProgress(100);

                    await sendSQSMessage({
                        status: 'Processing complete',
                        video: selectedVideo,
                        outputFilePath,
                    });

                    res.download(outputFilePath, (err) => {
                        if (err) {
                            console.error('Error sending file:', err);
                            res.status(500).send('Error sending file');
                        } else {
                            console.log('File sent successfully');
                            res.end();
                        }

                        // Clean up local files
                        fs.unlink(localVideoPath, (unlinkErr) => {
                            if (unlinkErr) console.error('Error deleting local video file:', unlinkErr);
                        });
                        fs.unlink(outputFilePath, (unlinkErr) => {
                            if (unlinkErr) console.error('Error deleting processed video file:', unlinkErr);
                        });
                    });
                })
                .on('error', async (err) => {
                    console.error('Error processing video:', err);

                    await sendSQSMessage({
                        status: 'Processing error',
                        video: selectedVideo,
                        error: err.message,
                    });

                    broadcastProgress('Error');
                    res.status(500).send('Error processing video');
                })
                .run();
        });

        stream.on('error', (err) => {
            console.error('Error writing video file:', err);
            res.status(500).send('Error writing video file');
        });
    } catch (error) {
        console.error('Error downloading video from S3:', error);
        res.status(500).send('Error downloading video from S3');
    }
});

// Health-check route
app.get('/health-check', (req, res) => {
    res.status(200).send('Server is healthy');
});

function broadcastProgress(progress) {
    for (let clientId in clients) {
        if (clients[clientId].readyState === WebSocket.OPEN) {
            clients[clientId].send(JSON.stringify({ progress }));
        }
    }
}

async function sendSQSMessage(message) {
    try {
        console.log('Preparing to send SQS message:', message);  // Log message content before sending
        const command = new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(message),
        });
        const response = await sqs.send(command);
        console.log('SQS Message Sent:', response.MessageId, 'with content:', message);  // Log after successful send
    } catch (err) {
        console.error('Error sending SQS message:', err);
    }
}

function getScaleOption(resolution) {
    switch (resolution) {
        case '720p': return '1280:720';
        case '480p': return '640:480';
        default: return '1920:1080';
    }
}

server.listen(port, () => console.log(`Video processor running at http://localhost:${port}`));
