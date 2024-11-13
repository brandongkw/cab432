require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const path = require('path');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3"); // Ensure GetObjectCommand is included
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const AWS = require('aws-sdk');
const CognitoIdentityServiceProvider = new AWS.CognitoIdentityServiceProvider();
const { CognitoJwtVerifier } = require('aws-jwt-verify');
const app = express();
const qutUsername = 'n11381345@qut.edu.au';
const port = process.env.PORT || 443;

const s3 = new S3Client({ region: process.env.AWS_REGION });
const dynamoDBClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const docClient = DynamoDBDocumentClient.from(dynamoDBClient);

const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    clientId: process.env.COGNITO_CLIENT_ID,
    tokenUse: 'id',
});

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(flash());
app.use(cookieParser());
app.set('view engine', 'ejs');
app.use(session({
    secret: 'yourSecretKey',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' },
}));
app.use(express.json());


// Global error handler
app.use((err, req, res, next) => {
    console.error('An unexpected error occurred:', err);
    res.status(500).send('Something went wrong. Please try again later.');
});

// Middleware for user authentication
const isAuthenticated = async (req, res, next) => {
    const token = req.cookies.jwt;
    if (!token) return res.redirect('/login');
    try {
        const payload = await verifier.verify(token);
        req.user = payload;
        next();
    } catch (error) {
        return res.status(401).send('Unauthorized. Please log in again.');
    }
};

// ----------------- Routes -----------------

// Landing Page Route
app.get('/', isAuthenticated, async (req, res) => {
    try {
        const videos = await getUploadedVideos(req.user);
        const firstVideo = videos.length > 0 ? videos[0] : null;

        res.render('index', {
            user: req.user,
            videos,
            preview: firstVideo ? firstVideo.url : null, // Pass preview URL if available
            video: firstVideo ? firstVideo.filename : null,
            msg: ''
        });
    } catch (error) {
        console.error("Error loading videos:", error);
        res.render('index', {
            user: req.user,
            videos: [],
            preview: null,
            video: null,
            msg: 'Error loading videos'
        });
    }
});


// Login and Register Routes
app.get('/login', (req, res) => res.render('login', { message: req.flash('error') }));
app.get('/register', (req, res) => res.render('register', { message: '' }));

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



// Video Upload Route
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1000000000 },
    fileFilter: (req, file, cb) => {
        const filetypes = /mp4|avi|mov|mkv/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (mimetype && extname) return cb(null, true);
        cb('Error: Videos Only!');
    }
}).single('videoFile');

const { v4: uuidv4 } = require('uuid');

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
            // Generate a unique filename to avoid collisions in S3
            const uniqueFilename = `${uuidv4()}_${req.file.originalname}`;

            // S3 Upload logic with error handling
            const s3Params = {
                Bucket: process.env.S3_BUCKET_NAME,
                Key: `videos/${req.user['cognito:username']}/${uniqueFilename}`, // Store under user's unique folder
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            };

            await s3.send(new PutObjectCommand(s3Params));

            // Generate pre-signed URL for playback
            const preSignedUrl = await generatePreSignedUrl(`${req.user['cognito:username']}/${uniqueFilename}`);

            // DynamoDB logic - Store the unique filename as 'filename' in DynamoDB
            const command = new PutCommand({
                TableName: process.env.DYNAMODB_TABLE_NAME,
                Item: {
                    'qut-username': qutUsername,
                    'videoId': uuidv4(),  // Generate a unique videoId
                    'userId': req.user['cognito:username'],
                    'filename': uniqueFilename,  // Save the unique filename
                    'uploadTime': new Date().toISOString(),
                    'videoName': req.file.originalname,  // Store the original file name for reference
                },
            });

            await dynamoDBClient.send(command);

            // Return JSON response
            res.json({
                preview: preSignedUrl,
                message: 'Video uploaded successfully'
            });
        } catch (error) {
            console.error('Error uploading video or saving metadata:', error);
            res.status(500).json({ message: 'Error uploading video, please try again later.', error });
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
                    const url = await generatePreSignedUrl(`${user['cognito:username']}/${video.filename}`);
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
                        const url = await generatePreSignedUrl(`${user['cognito:username']}/${video.filename}`);
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

// Delete video from both S3 and DynamoDB
app.post('/delete-video', isAuthenticated, async (req, res) => {
    const { filename, videoId } = req.body;

    // Log to confirm the received values
    console.log("Received delete request with filename:", filename, "and videoId:", videoId);

    if (!filename || !videoId) {
        return res.status(400).json({ message: 'Filename or videoId missing from request' });
    }

    try {
        // Delete from S3
        const s3Params = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `videos/${req.user['cognito:username']}/${filename}`, // Ensure correct S3 key
        };
        await s3.send(new DeleteObjectCommand(s3Params));

        // Delete metadata from DynamoDB
        const dynamoParams = {
            TableName: process.env.DYNAMODB_TABLE_NAME,
            Key: {
                'qut-username': qutUsername,  // Partition key in DynamoDB
                'videoId': videoId            // Sort key in DynamoDB
            }
        };
        await dynamoDBClient.send(new DeleteCommand(dynamoParams));

        res.status(200).json({ message: 'Video deleted successfully' });
    } catch (error) {
        console.error('Error deleting video:', error);
        res.status(500).json({ message: 'Error deleting video' });
    }
});

// Health-check route
app.get('/health-check', (req, res) => {
    res.status(200).send('Server is healthy');
});

// ----------------- Helper Functions -----------------

// Fetching videos for a user
async function getUploadedVideos(user) {
    try {
        const params = {
            TableName: process.env.DYNAMODB_TABLE_NAME,
            KeyConditionExpression: '#partitionKey = :username',
            ExpressionAttributeNames: {
                '#partitionKey': 'qut-username',
            },
            ExpressionAttributeValues: {
                ':username': qutUsername,
            },
        };

        const data = await docClient.send(new QueryCommand(params));

        // Filter results by userId after querying by qut-username
        const videosForUser = data.Items.filter(video => video.userId === user['cognito:username']);

        if (videosForUser.length > 0) {
            return await Promise.all(videosForUser.map(async (video) => {
                const url = await generatePreSignedUrl(`${user['cognito:username']}/${video.filename}`);
                return { ...video, url };
            }));
        }
        return [];
    } catch (error) {
        console.error('Error fetching videos:', error);
        throw new Error('Error fetching videos');
    }
}

// Function to generate pre-signed URL
async function generatePreSignedUrl(filenameWithPath) {
    const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `videos/${filenameWithPath}`,  // Use full path passed to the function
    };
    const command = new GetObjectCommand(params);
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });  // URL expires in 1 hour
    return signedUrl;
}


// Start the server
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
