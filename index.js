require('dotenv').config();
const express = require('express');
const http = require('http');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const WebSocket = require('ws');
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// AWS Cognito setup
const AWS = require('aws-sdk');
const CognitoIdentityServiceProvider = new AWS.CognitoIdentityServiceProvider();
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    clientId: process.env.COGNITO_CLIENT_ID,
    tokenUse: 'id',
});

// AWS S3 and DynamoDB setup
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

const s3 = new S3Client({ region: process.env.AWS_REGION });
const dynamoDB = DynamoDBDocumentClient.from(new AWS.DynamoDB());
console.log('AWS Credentials:', s3.config.credentials);

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
app.use(flash());

// WebSocket setup for progress tracking
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
    console.log('WebSocket connected');
    ws.on('message', (message) => {
        console.log('Received:', message);
    });

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
        req.user = payload; // User info extracted from token
        next();
    } catch (error) {
        console.error("Error verifying token: ", error);
        return res.status(401).send('Unauthorized. Please log in again.');
    }
};


// Function to generate pre-signed URL
async function generatePreSignedUrl(filename) {
    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `videos/${filename}`,
    };
    const command = new GetObjectCommand(params);
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });  // URL expires in 1 hour
    return signedUrl;
}

// Route for main page (requires authentication)
app.get('/', isAuthenticated, (req, res) => {
    res.render('index', { video: null, preview: null, msg: '', user: req.user });
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

        // Store the new tokens as cookies or in session storage
        res.cookie('jwt', IdToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 3600000  // Token valid for 1 hour
        });

        // Optionally store access token if needed
        res.cookie('access_token', AccessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 3600000  // Token valid for 1 hour
        });

        const tokenPayload = jwt.decode(IdToken); // jwt.decode will extract token details
        console.log("Token expires at:", new Date(tokenPayload.exp * 1000)); // Token expiry time in human-readable format

        res.redirect('/');
    } catch (error) {
        console.error('Login Error:', error);
        res.render('login', { message: 'Invalid login credentials.' });
    }
});

// Register Route
app.get('/register', (req, res) => {
    res.render('register', { message: '' });  // Pass an empty message initially
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
        if (error.code === 'InvalidPasswordException') {
            res.render('register', { message: 'Password must contain at least 8 characters, including an uppercase letter, a number, and a special character.' });
        } else if (error.code === 'UsernameExistsException') {
            res.render('register', { message: 'Username already exists. Please try a different one.' });
        } else {
            res.render('register', { message: 'Error registering user. Try again.' });
        }
    }
});

// Logout Route
app.get('/logout', (req, res) => {
    res.clearCookie('jwt');  // Clear the JWT token
    res.redirect('/login');
});

// Upload video to S3 and save metadata in DynamoDB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1000000000 }, // 1GB limit
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
        if (err) {
            console.error('Multer Error:', err); // Log the Multer error
            return res.render('index', { msg: err, user: req.user });
        }
        if (!req.file) {
            console.error('No file was uploaded');
            return res.render('index', { msg: 'No file selected!', user: req.user });
        }

        try {
            // Check current AWS credentials
            console.log('AWS Credentials:', {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                sessionToken: process.env.AWS_SESSION_TOKEN,
            });

            const s3Params = {
                Bucket: process.env.S3_BUCKET_NAME,
                Key: `videos/${req.file.originalname}`,
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            };
            console.log('Uploading video to S3:', s3Params); // Log the S3 upload params
            await s3.send(new PutObjectCommand(s3Params));

            // Store metadata in DynamoDB
            const dynamoParams = {
                TableName: process.env.DYNAMODB_TABLE_NAME,
                Item: {
                    videoId: Date.now().toString(),  // Unique ID for video
                    filename: req.file.originalname,
                    userId: req.user.sub,  // Cognito User ID
                    uploadTime: new Date().toISOString(),  // Include timestamp
                },
            };
            console.log('Saving metadata to DynamoDB:', dynamoParams); // Log the DynamoDB params
            await dynamoDB.send(new PutCommand(dynamoParams));

            res.render('index', { video: req.file.originalname, msg: 'Video uploaded successfully', user: req.user });
        } catch (error) {
            console.error('Error uploading video or saving metadata:', error); // Log the full error
            res.status(500).send('Error uploading video');
        }
    });
});

// Get uploaded videos for the user
// When fetching videos, generates the pre-signed URL to fetch the video from S3
app.get('/videos', isAuthenticated, async (req, res) => {
    const params = {
        TableName: process.env.DYNAMODB_TABLE_NAME,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': req.user.sub },
    };

    try {
        const data = await dynamoDB.send(new QueryCommand(params));

        // Generate pre-signed URLs for each video
        const videosWithUrls = await Promise.all(
            data.Items.map(async (video) => {
                const url = await generatePreSignedUrl(video.filename);
                return { ...video, url };
            })
        );

        res.render('index', { videos: videosWithUrls, user: req.user });
    } catch (error) {
        res.status(500).send('Error fetching videos');
    }
});

// Process video route
app.post('/process', isAuthenticated, (req, res) => {
    const { format, resolution, video } = req.body;

    // Log the incoming data to see if it matches what you expect
    console.log('Processing request body:', req.body);

    if (!format || !resolution || !video) {
        console.error('Format, resolution, or video not specified');
        return res.status(400).send('Format, resolution, or video file not specified.');
    }

    const output = `./videos/processed-${Date.now()}.${format}`;
    let scaleOption = '1920:1080';  // Default to 1080p

    if (resolution === '720p') scaleOption = '1280:720';
    if (resolution === '480p') scaleOption = '640:480';

    console.log(`Converting video: ${video}, format: ${format}, resolution: ${resolution}`); // Log conversion info
    ffmpeg(`./videos/${video}`)
        .outputOptions(['-vf', `scale=${scaleOption}`])
        .toFormat(format)
        .output(output)
        .on('end', () => {
            console.log('Video conversion completed:', output);  // Log successful conversion
            res.download(output);
        })
        .on('error', (err) => {
            console.error('Error processing video:', err);  // Log the ffmpeg error
            res.status(500).send('Error processing video');
        })
        .run();
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('An unexpected error occurred:', err);
    res.status(500).send('Something went wrong. Please try again later.');
});

// Start the server
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
