// Testing to push to repo

require('dotenv').config();
const express = require('express');
const http = require('http');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const session = require('express-session');
const bcrypt = require('bcryptjs');
const flash = require('connect-flash');
// const mongoose = require('mongoose');
const WebSocket = require('ws');
const User = require('./models/user');
const Video = require('./models/video');
const axios = require('axios');
const AWS = require('aws-sdk');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const app = express();
const port = process.env.PORT || 3000;
ffmpeg.setFfmpegPath(ffmpegPath);

// AWS SDK Configuration for S3
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});
const s3 = new S3Client({ region: process.env.REGION });
const dynamoDB = new AWS.DynamoDB.DocumentClient();

// Create HTTP server using the express app
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket connections for live progress tracking
wss.on('connection', (ws) => {
    console.log('WebSocket connected');
    ws.on('message', (message) => {
        console.log('Received:', message);
    });

    // Example progress simulation
    ws.send(JSON.stringify({ progress: 0 }));
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

// Send progress updates
function sendProgressUpdate(ws, progress) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ progress }));
    }
}

function isAuthenticated(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) {
        return next();
    } else {
        res.redirect('/login');
    }
}

// Connect to MongoDB
// mongoose.connect(process.env.DATABASE_URL, {
//   useNewUrlParser: true,
//   useUnifiedTopology: true,
// })
// .then(() => console.log('MongoDB connected'))
// .catch((err) => console.error('MongoDB connection error:', err));

// Middleware Setup
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SECRET_KEY,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// View engine setup
app.set('view engine', 'ejs');

// Passport authentication configuration
passport.use(new LocalStrategy(async (username, password, done) => {
    const params = {
        TableName: process.env.DYNAMODB_USERS_TABLE,
        Key: {
            username: username,
        },
    };

    try {
        const result = await dynamoDB.get(params).promise();
        const user = result.Item;
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return done(null, false, { message: 'Incorrect username or password.' });
        }
        return done(null, user);
    } catch (error) {
        return done(error);
    }
}));


passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

// Route for main page (requires authentication)
app.get('/', isAuthenticated, (req, res) => {
    res.render('index', {
        video: null,
        preview: null,
        msg: '',
        user: req.user || null
    });
});

// Route for user authentication and login
app.get('/login', (req, res) => res.render('login', { message: req.flash('error') }));

app.post('/login', passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login',
    failureFlash: true
}));

// Route for registering a new user
app.get('/register', (req, res) => res.render('register'));

// Update user registration to save in DynamoDB
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    const params = {
        TableName: process.env.DYNAMODB_TABLE_NAME,
        Item: {
            userId: Date.now().toString(), // Generate a unique ID for each user
            username: username,
            password: hashedPassword,
        },
    };

    try {
        await dynamoDB.put(params).promise();
        res.redirect('/login');
    } catch (error) {
        console.error('Error registering user:', error);
        res.status(500).send('Error registering user');
    }
});


// Logout route
app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/login');
    });
});

// Retrieve Videos from DynamoDB
app.get('/videos', isAuthenticated, async (req, res) => {
    const params = {
        TableName: process.env.DYNAMODB_TABLE_NAME,
        KeyConditionExpression: 'username = :username',
        ExpressionAttributeValues: {
            ':username': req.user.username,
        },
    };

    try {
        const data = await dynamoDB.query(params).promise();
        res.render('index', {
            videos: data.Items,
            user: req.user
        });
    } catch (error) {
        console.error('Error fetching videos from DynamoDB:', error);
        res.status(500).send('Error fetching videos');
    }
});


// Multer Storage Setup for video uploads
const storage = multer.diskStorage({
    destination: './videos/',
    filename: (req, file, cb) => {
        cb(null, `videoFile-${Date.now()}${path.extname(file.originalname)}`);
    }
});

// Initialize Multer upload
const upload = multer({
    storage,
    limits: { fileSize: 1000000000 }, // 1GB limit
    fileFilter: (req, file, cb) => {
        const filetypes = /mp4|avi|mov|mkv/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (mimetype && extname) return cb(null, true);
        else cb('Error: Videos Only!');
    }
}).single('videoFile');

// Video upload route
app.post('/upload', isAuthenticated, (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            return res.render('index', { msg: err, user: req.user });
        }
        if (!req.file) {
            return res.render('index', { msg: 'No file selected!', user: req.user });
        }
        try {
            const video = await Video.create({
                filename: req.file.filename,
                UserId: req.user.id,
            });
            res.render('index', { 
                video: req.file.filename, 
                preview: null, 
                msg: 'Video uploaded successfully', 
                user: req.user  // Pass the user object
            });
        } catch (error) {
            console.error('Error uploading video:', error);
            res.status(500).send('Error uploading video');
        }
    });
});

// Process video route (CPU intensive task - video processing with FFmpeg)
app.post('/process', isAuthenticated, (req, res) => {
    const { format, resolution, video } = req.body;
    if (!format || !resolution || !video) return res.status(400).send('Format, resolution, or video file not specified.');

    const output = `./videos/processed-${Date.now()}.${format}`;
    
    let scaleOption;

    switch (resolution) {
        case '1080p': scaleOption = '1920:1080'; break;
        case '720p': scaleOption = '1280:720'; break;
        case '480p': scaleOption = '640:480'; break;
        default: scaleOption = '1920:1080';
    }

    ffmpeg(`./videos/${video}`)
        .outputOptions(['-vf', `scale=${scaleOption}`])
        .toFormat(format)
        .output(output)
        .on('end', () => res.download(output))
        .on('error', (err) => res.status(500).send('Error processing video'))
        .run();
});

// Helper: User Authentication Check
function isAuthenticated(req, res, next) {
    if (req.isAuthenticated()) return next();
    else res.redirect('/login');
}

// Server listen
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
