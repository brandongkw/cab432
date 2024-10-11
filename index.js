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
const axios = require('axios');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const qutUsername = 'n11381345@qut.edu.au';
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

console.log('AWS Credentials:', s3.config.credentials);

// AWS Cognito setup
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

// Fetching videos for a user
async function getUploadedVideos(user) {
    try {
        const params = {
            TableName: process.env.DYNAMODB_TABLE_NAME,
            KeyConditionExpression: '#partitionKey = :username',
            ExpressionAttributeNames: {
                '#partitionKey': 'qut-username',
            },
            ExpressionAttributeValues: { ':username': qutUsername },
        };
        const data = await docClient.send(new QueryCommand(params));

        if (data.Items.length > 0) {
            return await Promise.all(data.Items.map(async (video) => {
                const url = await generatePreSignedUrl(video.filename);
                return { ...video, url };
            }));
        }
        return [];
    } catch (error) {
        console.error('Error fetching videos:', error);
        throw new Error('Error fetching videos');
    }
}

// Landing Page Route
app.get('/', isAuthenticated, async (req, res) => {
    try {
        const videosWithUrls = await getUploadedVideos(req.user);
        const firstVideo = videosWithUrls.length > 0 ? videosWithUrls[0] : null;

        res.render('index', {
            user: req.user,
            videos: videosWithUrls,
            video: firstVideo ? firstVideo.filename : null,
            preview: firstVideo ? firstVideo.url : null,
            msg: '',
        });
    } catch (error) {
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
        // Initiate authentication using AWS Cognito
        const data = await CognitoIdentityServiceProvider.initiateAuth(params).promise();
        const { IdToken, AccessToken } = data.AuthenticationResult;

        // Decode the JWT token before responding to avoid async issues
        const tokenPayload = jwt.decode(IdToken);
        console.log("Token expires at:", new Date(tokenPayload.exp * 1000));

        // Set cookies with the tokens (IdToken and AccessToken)
        res.cookie('jwt', IdToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 3600000  // Token valid for 1 hour
        });

        res.cookie('access_token', AccessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 3600000  // Token valid for 1 hour
        });

        // Redirect to homepage after successful login
        res.redirect('/');

    } catch (error) {
        // Handle login error
        console.error('Login Error:', error);

        // Make sure to render the login page with an error message
        if (!res.headersSent) {
            res.render('login', { message: 'Invalid login credentials.' });
        }
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
            console.error('Multer Error:', err);
            return res.status(400).json({ message: 'Error uploading video', error: err });
        }
        if (!req.file) {
            return res.status(400).json({ message: 'No file selected!' });
        }

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
            const command = new PutCommand({
                TableName: process.env.DYNAMODB_TABLE_NAME,
                Item: {
                    'qut-username': qutUsername,
                    videoId: Date.now().toString(),
                    filename: req.file.originalname,
                    uploadTime: new Date().toISOString(),
                },
            });
            await docClient.send(command);

            // Return JSON response
            res.json({
                preview: preSignedUrl,
                message: 'Video uploaded successfully'
            });
        } catch (error) {
            console.error('Error uploading video or saving metadata:', error);
            res.status(500).json({ message: 'Error uploading video', error });
        }
    });
});

// Get uploaded videos for the user
// When fetching videos, generates the pre-signed URL to fetch the video from S3
app.get('/videos', isAuthenticated, async (req, res) => {
    const params = {
        TableName: process.env.DYNAMODB_TABLE_NAME,
        KeyConditionExpression: '#partitionKey = :username',
        ExpressionAttributeNames: {
            '#partitionKey': 'qut-username',  // Partition key in DynamoDB
        },
        ExpressionAttributeValues: {
            ':username': qutUsername,  // Dynamically get the user's qut-username
        },
    };

    try {
        const data = await docClient.send(new QueryCommand(params));

        if (data.Items && data.Items.length > 0) {
            videosWithUrls = await Promise.all(
                data.Items.map(async (video) => {
                    const url = await generatePreSignedUrl(video.filename);
                    return { ...video, url };  // Attach the signed URL to the video object
                })
            );
        }

        // Ensure you pass videos (even if empty)
        res.render('index', { user: req.user, videos: videosWithUrls, preview: null });
    } catch (error) {
        console.error('Error fetching videos:', error);
        res.render('index', { user: req.user, videos: [], preview: null, msg: 'Error fetching videos' });
    }
});

// Process video route
app.post('/process', isAuthenticated, async (req, res) => {
    const { format, resolution, video } = req.body;
    if (!format || !resolution || !video) return res.status(400).send('Format, resolution, or video file not specified.');

    const output = `./videos/processed-${Date.now()}.${format}`;
    let scaleOption = '1920:1080';  // Default to 1080p
    if (resolution === '720p') scaleOption = '1280:720';
    if (resolution === '480p') scaleOption = '640:480';

    // Define the path to download the video from S3
    const s3Params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `videos/${video}`,  // Ensure this points to the correct video file in S3
    };

    try {
        // Download the video from S3
        const command = new GetObjectCommand(s3Params);
        const data = await s3.send(command);

        // Write the video to a local file
        const localVideoPath = `./videos/${video}`;
        const stream = fs.createWriteStream(localVideoPath);
        data.Body.pipe(stream);

        // Wait until the file is fully written
        stream.on('finish', () => {
            // Start processing the video with ffmpeg
            ffmpeg(localVideoPath)
                .outputOptions(['-vf', `scale=${scaleOption}`])
                .toFormat(format)
                .output(output)
                .on('end', () => {
                    console.log('Video processing complete');
                    res.download(output);  // Serve the processed video file
                })
                .on('error', (err) => {
                    console.error('Error processing video:', err);
                    res.status(500).send('Error processing video');
                })
                .run();
        });

        // Handle error during file writing
        stream.on('error', (err) => {
            console.error('Error writing file:', err);
            res.status(500).send('Error writing video file');
        });
    } catch (error) {
        console.error('Error downloading video from S3:', error);
        res.status(500).send('Error downloading video from S3');
    }
});

// Delete video from both S3 and DynamoDB
app.post('/delete-video', isAuthenticated, async (req, res) => {
    const { filename } = req.body;

    try {
        // Delete from S3
        const s3Params = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `videos/${filename}`,
        };
        await s3.send(new DeleteObjectCommand(s3Params));

        // Delete metadata from DynamoDB
        const dynamoParams = {
            TableName: process.env.DYNAMODB_TABLE_NAME,
            Key: {
                'qut-username': qutUsername,
                'filename': filename
            }
        };
        await docClient.send(new DeleteCommand(dynamoParams));

        res.redirect('/videos');
    } catch (error) {
        console.error('Error deleting video:', error);
        res.status(500).send('Error deleting video');
    }
});

// Preview a selected video
app.post('/preview-video', isAuthenticated, (req, res) => {
    const { videoUrl } = req.body;

    try {
        // Fetch videos again from DynamoDB to render the list
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

        docClient.send(new QueryCommand(dynamoParams))
            .then(async (dynamoData) => {
                const videosWithUrls = await Promise.all(
                    dynamoData.Items.map(async (video) => {
                        const url = await generatePreSignedUrl(video.filename);
                        return { filename: video.filename, url };
                    })
                );

                // Render the page with the selected video preview
                res.render('index', {
                    videos: videosWithUrls,  // List of user's videos
                    preview: videoUrl,  // Set the selected video for preview
                    user: req.user,
                    msg: '',
                    video: ''
                });
            })
            .catch((error) => {
                console.error('Error fetching videos:', error);
                res.status(500).send('Error fetching videos');
            });
    } catch (error) {
        console.error('Error processing preview:', error);
        res.status(500).send('Error processing preview');
    }
});

// Health-check route
app.get('/health-check', (req, res) => {
    res.status(200).send('Server is healthy');
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('An unexpected error occurred:', err);
    res.status(500).send('Something went wrong. Please try again later.');
});

// Start the server
server.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});