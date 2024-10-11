require('dotenv').config();
const express = require('express');
const http = require('http');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const qutUsername = `n11381345@qut.edu.au`;
const fs = require('fs');

// AWS SDK Imports
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// AWS Setup
const s3 = new S3Client({ region: process.env.AWS_REGION });
const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoDBClient);

// AWS Cognito Setup
const AWS = require('aws-sdk');
const CognitoIdentityServiceProvider = new AWS.CognitoIdentityServiceProvider();
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    clientId: process.env.COGNITO_CLIENT_ID,
    tokenUse: 'id',
});

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

const app = express();
const port = process.env.PORT || 3000;

// Set the path to the ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegPath);

// Middleware Setup
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use('/videos', express.static(path.join(__dirname, 'videos')));
app.use(flash());
app.use(cookieParser());
app.set('view engine', 'ejs');
app.use(session({
    secret: 'yourSecretKey', // Replace with a secure secret key
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }  // Ensure secure cookies in production
}));

// WebSocket Setup for Progress Tracking
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
    console.log('WebSocket connected');
    let progress = 0;
    const interval = setInterval(() => {
        progress += 10;
        ws.send(JSON.stringify({ progress }));
        if (progress >= 100) {
            clearInterval(interval);
            ws.send(JSON.stringify({ progress: 'Complete' }));
        }
    }, 1000);
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// Cognito authentication middleware
const isAuthenticated = async (req, res, next) => {
    const token = req.cookies.jwt;
    if (!token) {
        return res.redirect('/login');
    }
    try {
        const payload = await verifier.verify(token);
        req.user = payload; // Store user info in the request
        next();
    } catch (error) {
        console.error("Error verifying token:", error);
        return res.redirect('/login');
    }
};

// Function to Generate Pre-signed URL for S3 Video
async function generatePreSignedUrl(filename) {
    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `videos/${filename}`,
    };
    const command = new GetObjectCommand(params);
    return await getSignedUrl(s3, command, { expiresIn: 3600 });  // 1-hour expiration
}

// Fetch Uploaded Videos for a User
async function getUploadedVideos() {
    const params = {
        TableName: process.env.DYNAMODB_TABLE_NAME,
        KeyConditionExpression: '#partitionKey = :username',
        ExpressionAttributeNames: { '#partitionKey': 'qut-username' },
        ExpressionAttributeValues: { ':username': qutUsername },
    };

    try {
        const data = await docClient.send(new QueryCommand(params));
        return await Promise.all(data.Items.map(async (video) => {
            const url = await generatePreSignedUrl(video.filename);
            return { ...video, url };
        }));
    } catch (error) {
        console.error('Error fetching videos:', error);
        throw new Error('Error fetching videos');
    }
}

// Routes

// Landing Page Route
app.get('/', isAuthenticated, async (req, res) => {
    try {
        const videosWithUrls = await getUploadedVideos();
        const firstVideo = videosWithUrls.length > 0 ? videosWithUrls[0] : null;

        res.render('index', {
            user: req.user,
            videos: videosWithUrls,
            video: firstVideo ? firstVideo.filename : null,
            preview: firstVideo ? firstVideo.url : null,
            msg: '',
        });
    } catch (error) {
        console.error('Error loading videos:', error);
        res.render('index', { user: req.user, videos: [], video: null, preview: null, msg: 'Error loading videos' });
    }
});

// Login Route
app.get('/login', (req, res) => {
    res.render('login', { message: req.flash('error') });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const params = {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: process.env.COGNITO_CLIENT_ID,
        AuthParameters: { USERNAME: username, PASSWORD: password }
    };

    try {
        const data = await CognitoIdentityServiceProvider.initiateAuth(params).promise();
        const { IdToken, AccessToken } = data.AuthenticationResult;
        res.cookie('jwt', IdToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
        res.cookie('access_token', AccessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
        res.redirect('/');
    } catch (error) {
        console.error('Login Error:', error);
        res.render('login', { message: 'Invalid login credentials.' });
    }
});

// Register Route
app.get('/register', (req, res) => {
    res.render('register', { message: '' });
});

app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    const params = {
        ClientId: process.env.COGNITO_CLIENT_ID,
        Username: username,
        Password: password,
        UserAttributes: [{ Name: 'email', Value: email }]
    };

    try {
        await CognitoIdentityServiceProvider.signUp(params).promise();
        res.redirect('/login');
    } catch (error) {
        console.error('Registration Error:', error);
        let message = 'Error registering user. Try again.';
        if (error.code === 'InvalidPasswordException') {
            message = 'Password must contain at least 8 characters, including an uppercase letter, a number, and a special character.';
        } else if (error.code === 'UsernameExistsException') {
            message = 'Username already exists. Please try a different one.';
        }
        res.render('register', { message });
    }
});

// Logout Route
app.get('/logout', (req, res) => {
    res.clearCookie('jwt');
    res.redirect('/login');
});

// Upload Video to S3 and Save Metadata in DynamoDB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1000000000 },  // 1GB limit
    fileFilter: (req, file, cb) => {
        const filetypes = /mp4|avi|mov|mkv/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (mimetype && extname) return cb(null, true);
        cb('Error: Videos Only!');
    }
}).single('videoFile');

app.post('/upload', isAuthenticated, (req, res) => {
    upload(req, res, async (err) => {
        if (err) return res.status(400).json({ message: 'Error uploading video', error: err });
        if (!req.file) return res.status(400).json({ message: 'No file selected!' });

        try {
            // S3 Upload logic
            const s3Params = {
                Bucket: process.env.S3_BUCKET_NAME,
                Key: `videos/${req.file.originalname}`,
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            };
            await s3.send(new PutObjectCommand(s3Params));

            // Generate pre-signed URL for playback
            const preSignedUrl = await generatePreSignedUrl(req.file.originalname);

            // DynamoDB logic
            const dynamoParams = {
                TableName: process.env.DYNAMODB_TABLE_NAME,
                Item: {
                    'qut-username': qutUsername,
                    videoId: Date.now().toString(),
                    filename: req.file.originalname,
                    uploadTime: new Date().toISOString(),
                },
            };
            await docClient.send(new PutCommand(dynamoParams));

            const videosWithUrls = await getUploadedVideos();
            res.render('index', { video: req.file.originalname, msg: 'Video uploaded successfully', preview: preSignedUrl, user: req.user, videos: videosWithUrls });
        } catch (error) {
            console.error('Error uploading video or saving metadata:', error);
            res.render('index', { video: null, preview: null, msg: 'Error uploading video', user: req.user });
        }
    });
});

// Get uploaded videos for the user
// When fetching videos, generates the pre-signed URL to fetch the video from S3
app.get('/videos', isAuthenticated, async (req, res) => {

    try {
        // Fetch video metadata from DynamoDB
        const dynamoParams = {
            TableName: process.env.DYNAMODB_TABLE_NAME,
            KeyConditionExpression: '#partitionKey = :username',
            ExpressionAttributeNames: {
                '#partitionKey': 'qut-username',
            },
            ExpressionAttributeValues: {
                ':username': qutUsername,
            },
        };

        const dynamoData = await docClient.send(new QueryCommand(dynamoParams));

        // Generate pre-signed URLs for each video
        const videosWithUrls = await Promise.all(
            dynamoData.Items.map(async (video) => {
                const url = await generatePreSignedUrl(video.filename);
                return { filename: video.filename, url };
            })
        );

        // Render the page with videos list
        res.render('index', {
            videos: videosWithUrls,
            user: req.user,
            preview: null,  // No initial video selected for preview
            msg: '',
            video: ''
        });

    } catch (error) {
        console.error('Error fetching videos from DynamoDB:', error);
        res.status(500).send('Error fetching videos');
    }
});

// Function to generate pre-signed URL for video playback
async function generatePreSignedUrl(filename) {
    const s3Params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `videos/${filename}`,
    };
    const command = new GetObjectCommand(s3Params);
    return await getSignedUrl(s3, command, { expiresIn: 3600 });  // 1 hour URL
}

// Process video route
app.post('/process', isAuthenticated, async (req, res) => {
    const { format, resolution, video } = req.body;
    if (!format || !resolution || !video) return res.status(400).send('Format, resolution, or video file not specified.');

    const output = `./videos/processed-${Date.now()}.${format}`;
    let scaleOption = '1920:1080';
    if (resolution === '720p') scaleOption = '1280:720';
    if (resolution === '480p') scaleOption = '640:480';

    const s3Params = { Bucket: process.env.S3_BUCKET_NAME, Key: `videos/${video}` };

    try {
        const command = new GetObjectCommand(s3Params);
        const data = await s3.send(command);

        const localVideoPath = `./videos/${video}`;
        const stream = fs.createWriteStream(localVideoPath);
        data.Body.pipe(stream);

        stream.on('finish', () => {
            ffmpeg(localVideoPath).outputOptions(['-vf', `scale=${scaleOption}`]).toFormat(format).output(output)
                .on('end', () => res.download(output))
                .on('error', (err) => res.status(500).send('Error processing video'))
                .run();
        });

        stream.on('error', (err) => res.status(500).send('Error writing video file'));
    } catch (error) {
        res.status(500).send('Error downloading video from S3');
    }
});

// Delete Video Route
app.delete('/delete-video/:filename', isAuthenticated, async (req, res) => {
    const { filename } = req.params;

    try {
        const s3DeleteParams = { Bucket: process.env.S3_BUCKET_NAME, Key: `videos/${filename}` };
        await s3.send(new DeleteObjectCommand(s3DeleteParams));

        const dynamoDeleteParams = { TableName: process.env.DYNAMODB_TABLE_NAME, Key: { 'qut-username': qutUsername, 'filename': filename } };
        await docClient.send(new DeleteCommand(dynamoDeleteParams));

        res.status(200).send('Video deleted successfully');
    } catch (error) {
        console.error('Error deleting video:', error);
        res.status(500).send('Error deleting video');
    }
});

// Health Check Route
app.get('/health-check', (req, res) => {
    res.status(200).send('Server is healthy');
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('An unexpected error occurred:', err);
    res.status(500).send('Something went wrong. Please try again later.');
});

// Start the Server
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
